import type { ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { ExecutionResult } from "../../core/types.ts";
import type { IActionRunner, RunActionInput } from "../actions/action-runner.ts";
import type { AgentModelOption } from "../agents/agent-settings-service.ts";
import type { ClaudeCodeTurnInput, ClaudeCodeTurnResult, IClaudeCodeClient } from "../agents/claude-code-client.ts";
import type { ActionApproval } from "../approvals/connection-approval-types.ts";
import type { AgentChatResponse } from "./agent-chat-types.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ActionPolicyService } from "../../core/action-policy.ts";
import { AgentChatService } from "./agent-chat-service.ts";

const provider: ProviderDefinition = {
  service: "example",
  displayName: "Example",
  categories: ["Developer Tools"],
  authTypes: ["api_key"],
  auth: [{ type: "api_key" }],
  actions: [
    {
      id: "example.lookup",
      service: "example",
      name: "lookup",
      description: "Look up one record by query.",
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      outputSchema: { type: "object" },
    },
  ],
};

const connection: ConnectionSummary = {
  id: "connection-1",
  service: "example",
  connectionName: "default",
  authType: "api_key",
  configured: true,
  virtual: false,
  default: true,
  profile: {
    accountId: "example-account",
    displayName: "Example account",
    grantedScopes: [],
  },
};

describe("AgentChatService", () => {
  it("searches connected actions and executes the selected action through the guarded runner", async () => {
    const claude = new FakeClaudeCodeClient([
      {
        kind: "tool_call",
        toolName: "search_connector_actions",
        arguments: { query: "look up record" },
      },
      {
        kind: "tool_call",
        toolName: "run_connector_action",
        arguments: {
          actionId: "example.lookup",
          connectionId: connection.id,
          input: { query: "record-42" },
        },
      },
      {
        kind: "final",
        text: "Record 42 is active.",
      },
    ]);
    const actions = new FakeActionRunner();
    const service = createService(claude, actions);

    const response = await service.respond({
      messages: [{ role: "user", content: "Is record 42 active?" }],
    });

    expect(response.message).toMatchObject({ role: "assistant", content: "Record 42 is active." });
    expect(response.status).toBe("completed");
    expect(response.toolActivity).toHaveLength(2);
    expect(response.toolActivity[0]).toMatchObject({ type: "search", ok: true });
    expect(response.toolActivity[0]?.output).toMatchObject({
      results: [
        {
          actionId: "example.lookup",
          compatibleConnections: [{ connectionId: connection.id }],
          inputSchema: provider.actions[0]?.inputSchema,
        },
      ],
    });
    expect(response.toolActivity[1]).toMatchObject({
      type: "action",
      ok: true,
      actionId: "example.lookup",
      connectionId: connection.id,
    });
    expect(actions.inputs).toEqual([
      expect.objectContaining({
        actionId: "example.lookup",
        connectionId: connection.id,
        caller: "chat",
        input: { query: "record-42" },
      }),
    ]);
    expect(claude.inputs[0]?.prompt).toContain("Example account");
    expect(claude.inputs[0]?.systemPrompt).toContain("call the action so the host can create the approval request");
    expect(claude.inputs[1]?.prompt).toContain("example.lookup");
    expect(claude.inputs[2]?.prompt).toContain("Record 42 is active");
  });

  it("pauses on approval and resumes the exact action with saved agent context", async () => {
    const approvalId = "26d9fa1f-ff35-4bc8-b9af-12bb33389e61";
    const approval = createChatApproval(approvalId);
    const approvals = new FakeChatApprovals(approval);
    const actions = new FakeActionRunner([
      {
        ok: false,
        error: {
          code: "approval_required",
          message: "Approval is required.",
          details: { approvalId },
        },
      },
      successfulActionResult,
    ]);
    const claude = new FakeClaudeCodeClient([
      {
        kind: "tool_call",
        toolName: "search_connector_actions",
        arguments: { query: "look up record" },
      },
      {
        kind: "tool_call",
        toolName: "run_connector_action",
        arguments: {
          actionId: "example.lookup",
          connectionId: connection.id,
          input: { query: "record-42" },
        },
      },
      { kind: "final", text: "Record 42 is active." },
    ]);
    const service = createService(claude, actions, true, approvals);

    const waiting = await service.respond({
      messages: [{ role: "user", content: "Is record 42 active?" }],
    });

    expect(waiting).toMatchObject({ status: "waiting_for_approval", approvalId });
    expect(approvals.approval.chat).toMatchObject({
      messages: [{ role: "user", content: "Is record 42 active?" }],
    });
    expect(approvals.approval.chat?.toolActivity).toHaveLength(1);
    approvals.approve();

    const completed = await service.resume(approvalId);

    expect(completed).toMatchObject({ status: "completed", message: { content: "Record 42 is active." } });
    expect(actions.inputs[1]).toMatchObject({
      actionId: "example.lookup",
      input: { query: "record-42" },
      approvalPolicy: "bypass",
    });
    expect(claude.inputs[2]?.prompt).toContain('"active":true');
    expect((await service.getApprovalResult(approvalId)).response).toEqual(completed);
  });

  it("rejects conversation history that does not end with a user message", async () => {
    const service = createService(new FakeClaudeCodeClient([]), new FakeActionRunner());

    await expect(
      service.respond({ messages: [{ role: "assistant", content: "How can I help?" }] }),
    ).rejects.toMatchObject({ code: "invalid_chat", status: 400 });
  });

  it("requires a configured Claude subscription", async () => {
    const service = createService(new FakeClaudeCodeClient([]), new FakeActionRunner(), false);

    await expect(service.respond({ messages: [{ role: "user", content: "Hello" }] })).rejects.toMatchObject({
      code: "agent_connection_not_found",
      status: 400,
    });
  });
});

function createService(
  claudeCode: IClaudeCodeClient,
  actions: IActionRunner,
  agentConfigured = true,
  approvals = new FakeChatApprovals(),
): AgentChatService {
  const catalog = createCatalogStore([provider], { executableActionIds: ["example.lookup"] });
  return new AgentChatService({
    catalog,
    connections: {
      async listConnections() {
        return [connection];
      },
    },
    agents: {
      async list() {
        return agentConfigured
          ? [
              {
                id: "claude-subscription",
                provider: "claude_code" as const,
                authType: "subscription_oauth" as const,
                configured: true as const,
                displayName: "Claude subscription",
              },
            ]
          : [];
      },
      async getClaudeOAuthToken() {
        return "oauth-token";
      },
    },
    agentSettings: {
      async get() {
        return { provider: "claude_code", model: "opus" };
      },
    },
    claudeCode,
    actions,
    approvals,
    getPolicySnapshot: async () => new ActionPolicyService().createSnapshot(),
  });
}

class FakeClaudeCodeClient implements IClaudeCodeClient {
  readonly inputs: ClaudeCodeTurnInput[] = [];
  private readonly decisions: unknown[];

  constructor(decisions: unknown[]) {
    this.decisions = decisions;
  }

  async inspectSubscriptionToken(): Promise<void> {}

  async listModels(): Promise<AgentModelOption[]> {
    return [];
  }

  async completeTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
    this.inputs.push(input);
    return { structuredOutput: this.decisions.shift() };
  }
}

class FakeActionRunner implements IActionRunner {
  readonly inputs: RunActionInput[] = [];
  private readonly results: ExecutionResult[];

  constructor(results: ExecutionResult[] = [successfulActionResult]) {
    this.results = results;
  }

  async run(input: RunActionInput) {
    this.inputs.push(input);
    return {
      executionId: crypto.randomUUID(),
      auditPersisted: true,
      result: this.results.shift() ?? successfulActionResult,
      connection,
    };
  }
}

const successfulActionResult: ExecutionResult = {
  ok: true,
  output: { id: "record-42", active: true, summary: "Record 42 is active" },
};

class FakeChatApprovals {
  approval: ActionApproval;

  constructor(approval = createChatApproval(crypto.randomUUID())) {
    this.approval = approval;
  }

  async getActionApproval(id: string): Promise<ActionApproval | undefined> {
    return id === this.approval.id ? structuredClone(this.approval) : undefined;
  }

  async attachChatContinuation(
    id: string,
    messages: NonNullable<ActionApproval["chat"]>["messages"],
    toolActivity: NonNullable<ActionApproval["chat"]>["toolActivity"],
  ): Promise<ActionApproval> {
    if (id !== this.approval.id) throw new Error("Unexpected approval id");
    this.approval = { ...this.approval, chat: { messages, toolActivity } };
    return structuredClone(this.approval);
  }

  async consumeApproved(id: string): Promise<ActionApproval> {
    if (id !== this.approval.id || this.approval.status !== "approved") throw new Error("Approval is not approved");
    this.approval = { ...this.approval, status: "consumed", consumedAt: new Date().toISOString() };
    return structuredClone(this.approval);
  }

  async storeChatResponse(id: string, response: AgentChatResponse): Promise<ActionApproval> {
    if (id !== this.approval.id || !this.approval.chat) throw new Error("Unexpected approval id");
    this.approval = { ...this.approval, chat: { ...this.approval.chat, response } };
    return structuredClone(this.approval);
  }

  approve(): void {
    this.approval = {
      ...this.approval,
      status: "approved",
      resolvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

function createChatApproval(id: string): ActionApproval {
  return {
    id,
    status: "pending",
    actionId: "example.lookup",
    connectionId: connection.id,
    caller: "chat",
    input: { query: "record-42" },
    requestHash: "request-hash",
    requestedAt: new Date().toISOString(),
  };
}
