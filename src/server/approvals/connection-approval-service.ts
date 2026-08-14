import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type {
  AgentChatApprovalContinuation,
  AgentChatResponse,
  AgentChatToolActivity,
} from "../chat/agent-chat-types.ts";
import type { RunLogCaller } from "../storage/runtime-store.ts";
import type {
  ActionApproval,
  ActionApprovalExecution,
  ConnectionActionPermission,
  ConnectionApprovalMode,
  IConnectionApprovalStore,
} from "./connection-approval-types.ts";

import { hashActionRequest } from "../actions/action-idempotency.ts";

const approvalLifetimeMs = 15 * 60 * 1_000;
const maximumPermissions = 1_000;

export interface ConnectionApprovalServiceOptions {
  catalog: CatalogStore;
  connections: Pick<ConnectionService, "getConnectionSummaryById">;
  store: IConnectionApprovalStore;
}

export interface ActionApprovalRequestInput {
  actionId: string;
  connection: ConnectionSummary;
  caller: RunLogCaller;
  input: unknown;
  runtimeTokenId?: string;
}

export type ActionApprovalDecision = { allowed: true } | { allowed: false; approval: ActionApproval };

/** Owns connector action defaults and exact-request approvals for non-Flow requests. */
export class ConnectionApprovalService {
  private readonly options: ConnectionApprovalServiceOptions;

  constructor(options: ConnectionApprovalServiceOptions) {
    this.options = options;
  }

  listPermissions(connectionId?: string): Promise<ConnectionActionPermission[]> {
    return this.options.store.listPermissions(connectionId);
  }

  async replacePermissions(connectionId: string, input: unknown): Promise<ConnectionActionPermission[]> {
    const connection = await this.options.connections.getConnectionSummaryById(connectionId);
    if (!connection) {
      throw new ConnectionApprovalError("connection_not_found", `Connection not found: ${connectionId}.`, 404);
    }
    const body = requiredObject(input, "Connection permissions body");
    if (!Array.isArray(body.permissions) || body.permissions.length > maximumPermissions) {
      throw new ConnectionApprovalError(
        "invalid_connection_permissions",
        `permissions must be an array with no more than ${maximumPermissions} items.`,
      );
    }
    const updatedAt = new Date().toISOString();
    const actionIds = new Set<string>();
    const permissions = body.permissions.map((item, index): ConnectionActionPermission => {
      const value = requiredObject(item, `permissions[${index}]`);
      const actionId = requiredText(value.actionId, `permissions[${index}].actionId`);
      const action = this.options.catalog.actionsById.get(actionId);
      if (!action || action.service !== connection.service || !action.execution.locallyExecutable) {
        throw new ConnectionApprovalError(
          "invalid_connection_permissions",
          `${actionId} is not an executable action for this connection.`,
        );
      }
      if (actionIds.has(actionId)) {
        throw new ConnectionApprovalError("invalid_connection_permissions", `Duplicate permission: ${actionId}.`);
      }
      actionIds.add(actionId);
      return {
        connectionId,
        actionId,
        approval: readApprovalMode(value.approval, `permissions[${index}].approval`),
        updatedAt,
      };
    });
    const currentPermissions = await this.options.store.listPermissions(connectionId);
    const nextRequired = new Set(
      permissions
        .filter((permission) => permission.approval === "require_approval")
        .map((permission) => permission.actionId),
    );
    const noLongerRequired = new Set(
      currentPermissions
        .filter((permission) => permission.approval === "require_approval" && !nextRequired.has(permission.actionId))
        .map((permission) => permission.actionId),
    );
    await this.expireApprovals(connectionId, noLongerRequired, updatedAt);
    await this.options.store.replacePermissions(connectionId, permissions);
    return permissions;
  }

  async getApprovalMode(connectionId: string, actionId: string): Promise<ConnectionApprovalMode> {
    return (await this.options.store.getPermission(connectionId, actionId))?.approval ?? "always_allow";
  }

  async requestAction(input: ActionApprovalRequestInput): Promise<ActionApprovalDecision> {
    if ((await this.getApprovalMode(input.connection.id, input.actionId)) === "always_allow") {
      return { allowed: true };
    }
    const requestHash = hashActionRequest({
      actionId: `${input.caller}:${input.actionId}`,
      connectionName: input.connection.id,
      input: input.input,
      runtimeTokenId: input.runtimeTokenId,
    });
    const approval: ActionApproval = {
      id: crypto.randomUUID(),
      status: "pending",
      actionId: input.actionId,
      connectionId: input.connection.id,
      caller: input.caller,
      input: input.input,
      requestHash,
      requestedAt: new Date().toISOString(),
      runtimeTokenId: input.runtimeTokenId,
    };
    await this.options.store.addActionApproval(approval);
    return { allowed: false, approval };
  }

  listActionApprovals(limit?: number): Promise<ActionApproval[]> {
    return this.options.store.listActionApprovals(limit);
  }

  getActionApproval(id: string): Promise<ActionApproval | undefined> {
    return this.options.store.getActionApproval(id);
  }

  async attachChatContinuation(
    id: string,
    messages: AgentChatApprovalContinuation["messages"],
    toolActivity: AgentChatToolActivity[],
    voiceMode = false,
  ): Promise<ActionApproval> {
    const approval = await this.getPendingApproval(id);
    if (approval.caller !== "chat") {
      throw new ConnectionApprovalError("invalid_approval_caller", "Only Chat approvals can store agent state.");
    }
    const updated: ActionApproval = {
      ...approval,
      chat: {
        messages: structuredClone(messages),
        toolActivity: structuredClone(toolActivity),
        voiceMode,
      },
    };
    if (!(await this.options.store.updateActionApproval(updated, "pending"))) {
      throw new ConnectionApprovalError("approval_not_pending", "The approval has already been resolved.");
    }
    return updated;
  }

  async consumeApproved(id: string, caller: RunLogCaller): Promise<ActionApproval> {
    const approval = await this.options.store.getActionApproval(id);
    if (!approval) {
      throw new ConnectionApprovalError("approval_not_found", `Approval not found: ${id}.`, 404);
    }
    if (approval.caller !== caller) {
      throw new ConnectionApprovalError("invalid_approval_caller", "The approval belongs to a different caller.");
    }
    if (approval.status !== "approved") {
      throw new ConnectionApprovalError("approval_not_approved", "The approval is not ready to resume.");
    }
    const now = new Date();
    if (!approval.expiresAt || Date.parse(approval.expiresAt) <= now.getTime()) {
      await this.options.store.updateActionApproval(
        { ...approval, status: "expired", resolvedAt: approval.resolvedAt ?? now.toISOString() },
        "approved",
      );
      throw new ConnectionApprovalError("approval_expired", "The approval expired before the agent resumed.");
    }
    const consumed: ActionApproval = {
      ...approval,
      status: "consumed",
      consumedAt: now.toISOString(),
    };
    if (!(await this.options.store.updateActionApproval(consumed, "approved"))) {
      throw new ConnectionApprovalError("approval_not_approved", "The approval has already been consumed.");
    }
    return consumed;
  }

  async storeChatResponse(id: string, response: AgentChatResponse): Promise<ActionApproval> {
    const approval = await this.options.store.getActionApproval(id);
    if (!approval || approval.caller !== "chat" || !approval.chat) {
      throw new ConnectionApprovalError("approval_not_found", `Chat approval not found: ${id}.`, 404);
    }
    if (approval.status !== "consumed") {
      throw new ConnectionApprovalError("approval_not_consumed", "The Chat approval has not been consumed.");
    }
    const updated: ActionApproval = {
      ...approval,
      chat: {
        ...approval.chat,
        response: structuredClone(response),
      },
    };
    if (!(await this.options.store.updateActionApproval(updated, "consumed"))) {
      throw new ConnectionApprovalError("approval_not_consumed", "The Chat approval changed before completion.");
    }
    return updated;
  }

  async storeExecution(id: string, execution: ActionApprovalExecution): Promise<ActionApproval> {
    const approval = await this.options.store.getActionApproval(id);
    if (!approval) {
      throw new ConnectionApprovalError("approval_not_found", `Approval not found: ${id}.`, 404);
    }
    if (approval.status !== "consumed" || approval.execution) {
      throw new ConnectionApprovalError("approval_not_consumed", "The approved request is not awaiting a result.");
    }
    const updated: ActionApproval = {
      ...approval,
      execution: structuredClone(execution),
    };
    if (!(await this.options.store.updateActionApproval(updated, "consumed"))) {
      throw new ConnectionApprovalError("approval_not_consumed", "The approved request changed before completion.");
    }
    return updated;
  }

  async approve(id: string): Promise<ActionApproval> {
    const approval = await this.getPendingApproval(id);
    const now = new Date();
    const approved: ActionApproval = {
      ...approval,
      status: "approved",
      resolvedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + approvalLifetimeMs).toISOString(),
    };
    if (!(await this.options.store.updateActionApproval(approved, "pending"))) {
      throw new ConnectionApprovalError("approval_not_pending", "The approval has already been resolved.");
    }
    return approved;
  }

  async deny(id: string): Promise<ActionApproval> {
    const approval = await this.getPendingApproval(id);
    const denied: ActionApproval = {
      ...approval,
      status: "denied",
      resolvedAt: new Date().toISOString(),
    };
    if (!(await this.options.store.updateActionApproval(denied, "pending"))) {
      throw new ConnectionApprovalError("approval_not_pending", "The approval has already been resolved.");
    }
    return denied;
  }

  private async getPendingApproval(id: string): Promise<ActionApproval> {
    const approval = await this.options.store.getActionApproval(id);
    if (!approval) {
      throw new ConnectionApprovalError("approval_not_found", `Approval not found: ${id}.`, 404);
    }
    if (approval.status !== "pending") {
      throw new ConnectionApprovalError("approval_not_pending", "The approval has already been resolved.");
    }
    return approval;
  }

  private async expireApprovals(connectionId: string, actionIds: Set<string>, now: string): Promise<void> {
    if (actionIds.size === 0) return;
    const approvals = await this.options.store.listActionApprovals(1_000);
    await Promise.all(
      approvals
        .filter(
          (approval) =>
            approval.connectionId === connectionId &&
            actionIds.has(approval.actionId) &&
            (approval.status === "pending" || approval.status === "approved"),
        )
        .map((approval) =>
          this.options.store.updateActionApproval(
            {
              ...approval,
              status: "expired",
              resolvedAt: approval.resolvedAt ?? now,
              expiresAt: now,
            },
            approval.status,
          ),
        ),
    );
  }
}

export class ConnectionApprovalError extends Error {
  readonly code: string;
  readonly status: 400 | 404;

  constructor(code: string, message: string, status: 400 | 404 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectionApprovalError("invalid_connection_permissions", `${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new ConnectionApprovalError(
      "invalid_connection_permissions",
      `${field} must be a non-empty string no longer than 200 characters.`,
    );
  }
  return value.trim();
}

function readApprovalMode(value: unknown, field: string): ConnectionApprovalMode {
  if (value === "always_allow" || value === "require_approval") {
    return value;
  }
  throw new ConnectionApprovalError(
    "invalid_connection_permissions",
    `${field} must be always_allow or require_approval.`,
  );
}
