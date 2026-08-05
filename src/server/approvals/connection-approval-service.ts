import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { RunLogCaller } from "../storage/runtime-store.ts";
import type {
  ActionApproval,
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

/** Owns connector action defaults and one-time approval grants for non-Flow requests. */
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
    const now = new Date();
    const approved = await this.options.store.findActionApproval(requestHash, "approved");
    if (approved) {
      if (approved.expiresAt && Date.parse(approved.expiresAt) > now.getTime()) {
        const consumed: ActionApproval = {
          ...approved,
          status: "consumed",
          consumedAt: now.toISOString(),
        };
        if (await this.options.store.updateActionApproval(consumed, "approved")) {
          return { allowed: true };
        }
      } else {
        await this.options.store.updateActionApproval(
          { ...approved, status: "expired", resolvedAt: approved.resolvedAt ?? now.toISOString() },
          "approved",
        );
      }
    }
    const pending = await this.options.store.findActionApproval(requestHash, "pending");
    if (pending) {
      return { allowed: false, approval: pending };
    }
    const approval: ActionApproval = {
      id: crypto.randomUUID(),
      status: "pending",
      actionId: input.actionId,
      connectionId: input.connection.id,
      caller: input.caller,
      input: input.input,
      requestHash,
      requestedAt: now.toISOString(),
      runtimeTokenId: input.runtimeTokenId,
    };
    await this.options.store.addActionApproval(approval);
    return { allowed: false, approval };
  }

  listActionApprovals(limit?: number): Promise<ActionApproval[]> {
    return this.options.store.listActionApprovals(limit);
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
