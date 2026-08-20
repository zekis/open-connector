import type { ConnectionSummary } from "../../connection-service.ts";
import type {
  ActionApproval,
  ActionApprovalStatus,
  ConnectionActionPermission,
  IConnectionApprovalStore,
} from "./connection-approval-types.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionApprovalError, ConnectionApprovalService } from "./connection-approval-service.ts";

const connection: ConnectionSummary = {
  id: "example-connection",
  service: "example",
  connectionName: "default",
  authType: "no_auth",
  configured: true,
  virtual: true,
  default: true,
  profile: {
    accountId: "example",
    displayName: "Example",
    grantedScopes: [],
  },
};

describe("ConnectionApprovalService", () => {
  it("defaults missing connector action settings to always allow", async () => {
    const { service } = createService();

    await expect(service.getApprovalMode(connection.id, "example.echo")).resolves.toBe("always_allow");
    await expect(
      service.requestAction({ actionId: "example.echo", connection, caller: "http", input: { message: "hello" } }),
    ).resolves.toEqual({ allowed: true });
  });

  it("validates and completely replaces one connection's action defaults", async () => {
    const { service } = createService();

    const permissions = await service.replacePermissions(connection.id, {
      permissions: [{ actionId: "example.echo", approval: "require_approval" }],
    });

    expect(permissions).toEqual([
      expect.objectContaining({
        connectionId: connection.id,
        actionId: "example.echo",
        approval: "require_approval",
      }),
    ]);
    await expect(service.getApprovalMode(connection.id, "example.echo")).resolves.toBe("require_approval");
    await service.replacePermissions(connection.id, { permissions: [] });
    await expect(service.getApprovalMode(connection.id, "example.echo")).resolves.toBe("always_allow");
  });

  it("rejects actions that do not belong to the saved connection", async () => {
    const { service } = createService();

    await expect(
      service.replacePermissions(connection.id, {
        permissions: [{ actionId: "other.write", approval: "require_approval" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_connection_permissions" } satisfies Partial<ConnectionApprovalError>);
  });

  it("queues identical pending requests as separate one-time approvals", async () => {
    const { service, store } = createService();
    await service.replacePermissions(connection.id, {
      permissions: [{ actionId: "example.echo", approval: "require_approval" }],
    });
    const request = {
      actionId: "example.echo",
      connection,
      caller: "mcp" as const,
      input: { message: "hello" },
    };

    const first = await service.requestAction(request);
    const duplicate = await service.requestAction(request);

    expect(first.allowed).toBe(false);
    expect(duplicate.allowed).toBe(false);
    if (first.allowed) throw new Error("Expected a pending approval.");
    if (duplicate.allowed) throw new Error("Expected a second pending approval.");
    expect(duplicate.approval.id).not.toBe(first.approval.id);
    await expect(store.listActionApprovals()).resolves.toHaveLength(2);
    await expect(service.approve(first.approval.id)).resolves.toMatchObject({ status: "approved" });
    await service.consumeApproved(first.approval.id, "mcp");
    await service.storeExecution(first.approval.id, {
      executionId: "execution-1",
      auditPersisted: true,
      result: { ok: true, output: { message: "hello" } },
      completedAt: "2026-08-09T01:00:00.000Z",
    });
    await expect(store.getActionApproval(first.approval.id)).resolves.toMatchObject({ status: "consumed" });

    const next = await service.requestAction(request);
    expect(next.allowed).toBe(false);
    if (!next.allowed) expect(next.approval.id).not.toBe(first.approval.id);
  });

  it("persists queued Chat state before storing its resumed response", async () => {
    const { service, store } = createService();
    await service.replacePermissions(connection.id, {
      permissions: [{ actionId: "example.echo", approval: "require_approval" }],
    });
    const requested = await service.requestAction({
      actionId: "example.echo",
      connection,
      caller: "chat",
      input: { message: "hello" },
    });
    if (requested.allowed) throw new Error("Expected a pending approval.");

    await service.attachChatContinuation(
      requested.approval.id,
      [{ role: "user", content: "Send hello" }],
      [],
      false,
      [requested.approval.id, "approval-2"],
      "Australia/Perth",
    );
    await service.approve(requested.approval.id);
    await service.storeChatResponse(requested.approval.id, {
      status: "waiting_for_approval",
      approvalId: "approval-2",
      approvalIds: ["approval-2"],
      message: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "One more action is waiting.",
        createdAt: new Date().toISOString(),
      },
      toolActivity: [],
    });
    await expect(store.getActionApproval(requested.approval.id)).resolves.toMatchObject({
      status: "approved",
      chat: {
        batchApprovalIds: [requested.approval.id, "approval-2"],
        timeZone: "Australia/Perth",
        response: { status: "waiting_for_approval", approvalId: "approval-2" },
      },
    });
    await service.consumeApproved(requested.approval.id, "chat");
    await service.storeChatResponse(requested.approval.id, {
      status: "completed",
      message: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Sent hello.",
        createdAt: new Date().toISOString(),
      },
      toolActivity: [],
    });

    await expect(store.getActionApproval(requested.approval.id)).resolves.toMatchObject({
      status: "consumed",
      chat: {
        messages: [{ role: "user", content: "Send hello" }],
        response: { status: "completed", message: { content: "Sent hello." } },
      },
    });
    await expect(service.consumeApproved(requested.approval.id, "chat")).rejects.toMatchObject({
      code: "approval_not_approved",
    });
  });

  it("records only one decision when the same approval is submitted concurrently", async () => {
    const { service } = createService();
    await service.replacePermissions(connection.id, {
      permissions: [{ actionId: "example.echo", approval: "require_approval" }],
    });
    const requested = await service.requestAction({
      actionId: "example.echo",
      connection,
      caller: "chat",
      input: { message: "hello" },
    });
    if (requested.allowed) throw new Error("Expected a pending approval.");

    const decisions = await Promise.allSettled([
      service.approve(requested.approval.id),
      service.approve(requested.approval.id),
    ]);

    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.status === "rejected")).toHaveLength(1);
    await expect(service.getActionApproval(requested.approval.id)).resolves.toMatchObject({ status: "approved" });
  });

  it("keeps approvals scoped to the caller and runtime token", async () => {
    const { service } = createService();
    await service.replacePermissions(connection.id, {
      permissions: [{ actionId: "example.echo", approval: "require_approval" }],
    });

    const http = await service.requestAction({
      actionId: "example.echo",
      connection,
      caller: "http",
      input: { message: "hello" },
      runtimeTokenId: "token-a",
    });
    const mcp = await service.requestAction({
      actionId: "example.echo",
      connection,
      caller: "mcp",
      input: { message: "hello" },
      runtimeTokenId: "token-a",
    });
    const otherToken = await service.requestAction({
      actionId: "example.echo",
      connection,
      caller: "http",
      input: { message: "hello" },
      runtimeTokenId: "token-b",
    });

    expect(http.allowed || mcp.allowed || otherToken.allowed).toBe(false);
    if (!http.allowed && !mcp.allowed && !otherToken.allowed) {
      expect(new Set([http.approval.id, mcp.approval.id, otherToken.approval.id]).size).toBe(3);
    }
  });

  it("expires open approvals when an action no longer requires approval", async () => {
    const { service, store } = createService();
    await service.replacePermissions(connection.id, {
      permissions: [{ actionId: "example.echo", approval: "require_approval" }],
    });
    const pending = await service.requestAction({
      actionId: "example.echo",
      connection,
      caller: "chat",
      input: { message: "pending" },
    });
    const approved = await service.requestAction({
      actionId: "example.echo",
      connection,
      caller: "http",
      input: { message: "approved" },
    });
    if (pending.allowed || approved.allowed) throw new Error("Expected approval requests.");
    await service.approve(approved.approval.id);

    await service.replacePermissions(connection.id, {
      permissions: [{ actionId: "example.echo", approval: "always_allow" }],
    });

    await expect(store.getActionApproval(pending.approval.id)).resolves.toMatchObject({ status: "expired" });
    await expect(store.getActionApproval(approved.approval.id)).resolves.toMatchObject({ status: "expired" });
    await expect(
      service.requestAction({
        actionId: "example.echo",
        connection,
        caller: "http",
        input: { message: "approved" },
      }),
    ).resolves.toEqual({ allowed: true });

    await service.replacePermissions(connection.id, {
      permissions: [{ actionId: "example.echo", approval: "require_approval" }],
    });
    await expect(
      service.requestAction({
        actionId: "example.echo",
        connection,
        caller: "http",
        input: { message: "approved" },
      }),
    ).resolves.toMatchObject({ allowed: false, approval: { status: "pending" } });
  });
});

function createService(): { service: ConnectionApprovalService; store: MemoryConnectionApprovalStore } {
  const store = new MemoryConnectionApprovalStore();
  const catalog = createCatalogStore(
    [
      {
        service: "example",
        displayName: "Example",
        categories: [],
        authTypes: ["no_auth"],
        auth: [{ type: "no_auth" }],
        actions: [
          {
            id: "example.echo",
            service: "example",
            name: "echo",
            description: "Echo input.",
            requiredScopes: [],
            providerPermissions: [],
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
          {
            id: "other.write",
            service: "other",
            name: "write",
            description: "Write elsewhere.",
            requiredScopes: [],
            providerPermissions: [],
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
        ],
      },
    ],
    { executableActionIds: ["example.echo", "other.write"] },
  );
  return {
    store,
    service: new ConnectionApprovalService({
      catalog,
      connections: {
        getConnectionSummaryById: async (id) => (id === connection.id ? connection : undefined),
      },
      store,
    }),
  };
}

class MemoryConnectionApprovalStore implements IConnectionApprovalStore {
  private permissions: ConnectionActionPermission[] = [];
  private readonly approvals = new Map<string, ActionApproval>();

  async replacePermissions(connectionId: string, permissions: ConnectionActionPermission[]): Promise<void> {
    this.permissions = [
      ...this.permissions.filter((permission) => permission.connectionId !== connectionId),
      ...structuredClone(permissions),
    ];
  }

  async listPermissions(connectionId?: string): Promise<ConnectionActionPermission[]> {
    return structuredClone(
      connectionId
        ? this.permissions.filter((permission) => permission.connectionId === connectionId)
        : this.permissions,
    );
  }

  async getPermission(connectionId: string, actionId: string): Promise<ConnectionActionPermission | undefined> {
    return structuredClone(
      this.permissions.find(
        (permission) => permission.connectionId === connectionId && permission.actionId === actionId,
      ),
    );
  }

  async addActionApproval(approval: ActionApproval): Promise<void> {
    this.approvals.set(approval.id, structuredClone(approval));
  }

  async getActionApproval(id: string): Promise<ActionApproval | undefined> {
    return structuredClone(this.approvals.get(id));
  }

  async listActionApprovals(limit = 500): Promise<ActionApproval[]> {
    return structuredClone(
      [...this.approvals.values()]
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
        .slice(0, limit),
    );
  }

  async findActionApproval(requestHash: string, status: ActionApprovalStatus): Promise<ActionApproval | undefined> {
    return structuredClone(
      [...this.approvals.values()].find(
        (approval) => approval.requestHash === requestHash && approval.status === status,
      ),
    );
  }

  async updateActionApproval(approval: ActionApproval, expectedStatus: ActionApprovalStatus): Promise<boolean> {
    const current = this.approvals.get(approval.id);
    if (!current || current.status !== expectedStatus) return false;
    this.approvals.set(approval.id, structuredClone(approval));
    return true;
  }
}
