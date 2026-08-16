import type { ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { ExecutionResult } from "../../core/types.ts";
import type { IActionRunner, RunActionInput } from "../actions/action-runner.ts";
import type { AgentModelOption } from "../agents/agent-settings-service.ts";
import type { ClaudeCodeTurnInput, ClaudeCodeTurnResult, IClaudeCodeClient } from "../agents/claude-code-client.ts";
import type { ActionApproval } from "../approvals/connection-approval-types.ts";
import type { AgentChatProgress, AgentChatResponse } from "./agent-chat-types.ts";

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
      requiredScopes: ["records:read"],
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
    grantedScopes: ["records:read"],
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

    const progress: AgentChatProgress[] = [];
    const response = await service.respond(
      {
        messages: [{ role: "user", content: "Is record 42 active?" }],
      },
      (update) => {
        progress.push(update);
      },
    );

    expect(response.message).toMatchObject({ role: "assistant", content: "Record 42 is active." });
    expect(response.status).toBe("completed");
    expect(response.toolActivity).toHaveLength(2);
    expect(response.toolActivity[0]).toMatchObject({ type: "search", ok: true });
    expect(response.toolActivity[0]?.output).toMatchObject({
      results: [
        {
          actionId: "example.lookup",
          requiredScopes: ["records:read"],
          compatibleConnections: [{ connectionId: connection.id, grantedScopes: ["records:read"] }],
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
    expect(claude.inputs[0]?.prompt).toContain('"grantedScopes":["records:read"]');
    expect(claude.inputs[0]?.systemPrompt).toContain("call the action so the host can create the approval request");
    expect(claude.inputs[1]?.prompt).toContain("example.lookup");
    expect(claude.inputs[2]?.prompt).toContain("Record 42 is active");
    expect(progress.map((update) => update.phase)).toEqual([
      "tool_started",
      "tool_completed",
      "tool_started",
      "tool_completed",
    ]);
    expect(progress[0]?.tool).toMatchObject({
      name: "search_connector_actions",
      label: "Search connected actions",
      input: { query: "look up record" },
    });
    expect(progress[0]?.id).toBe(progress[1]?.id);
    expect(progress[1]?.tool?.activity).toMatchObject({ type: "search", ok: true });
    expect(progress[2]?.tool).toMatchObject({
      name: "run_connector_action",
      actionId: "example.lookup",
      connectionId: connection.id,
      connectionDisplayName: "Example account",
      input: { query: "record-42" },
    });
    expect(progress[2]?.id).toBe(progress[3]?.id);
    expect(progress[3]?.tool?.activity).toMatchObject({
      type: "action",
      ok: true,
      actionId: "example.lookup",
    });
    expect([
      "Hmm, I'm finding the right connection and action.",
      "Okay, I'm checking which connection can handle that.",
      "One moment, I'm finding the right connected action.",
    ]).toContain(progress[0]?.speech);
    expect([
      "Okay, I found the connection and action I need.",
      "Good, I found the connected action I need.",
      "Yes, I found the right connection for that.",
    ]).toContain(progress[1]?.speech);
    expect([
      "Okay, I'm checking Example now.",
      "Hmm, I'm working with Example now.",
      "I've connected to Example. Let me check that.",
    ]).toContain(progress[2]?.speech);
    expect(["Okay, Example completed that step.", "Good, that Example step is complete."]).toContain(
      progress[3]?.speech,
    );
  });

  it("pauses on approval and resumes the exact action with saved agent context", async () => {
    const approvalId = "26d9fa1f-ff35-4bc8-b9af-12bb33389e61";
    const approval = createChatApproval(approvalId);
    const approvals = new FakeChatApprovals(approval);
    const actions = new FakeActionRunner([
      {
        ok: false,
        error: {
          code: "approval_pending",
          message: "Action queued and pending approval.",
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
      { kind: "final", text: "The action is queued for approval." },
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
    expect(approvals.approval.chat?.toolActivity).toHaveLength(2);
    approvals.approve();

    const completed = await service.resume(approvalId);

    expect(completed).toMatchObject({ status: "completed", message: { content: "Record 42 is active." } });
    expect(actions.inputs[1]).toMatchObject({
      actionId: "example.lookup",
      input: { query: "record-42" },
      approvalPolicy: "bypass",
    });
    expect(claude.inputs[3]?.prompt).toContain('"active":true');
    expect((await service.getApprovalResult(approvalId)).response).toEqual(completed);
  });

  it("queues every approval request before executing the approved batch", async () => {
    const firstApprovalId = "11111111-1111-4111-8111-111111111111";
    const secondApprovalId = "22222222-2222-4222-8222-222222222222";
    const approvals = new FakeChatApprovals([
      createChatApproval(firstApprovalId, "record-1"),
      createChatApproval(secondApprovalId, "record-2"),
    ]);
    const actions = new FakeActionRunner([
      {
        ok: false,
        error: {
          code: "approval_pending",
          message: "Action queued and pending approval.",
          details: { approvalId: firstApprovalId },
        },
      },
      {
        ok: false,
        error: {
          code: "approval_pending",
          message: "Action queued and pending approval.",
          details: { approvalId: secondApprovalId },
        },
      },
      { ok: true, output: { id: "record-1", updated: true } },
      { ok: true, output: { id: "record-2", updated: true } },
    ]);
    const claude = new FakeClaudeCodeClient([
      {
        kind: "tool_call",
        toolName: "run_connector_action",
        arguments: {
          actionId: "example.lookup",
          connectionId: connection.id,
          input: { query: "record-1" },
        },
      },
      {
        kind: "tool_call",
        toolName: "run_connector_action",
        arguments: {
          actionId: "example.lookup",
          connectionId: connection.id,
          input: { query: "record-2" },
        },
      },
      { kind: "final", text: "Both changes are queued." },
      { kind: "final", text: "Both approved changes completed." },
    ]);
    const service = createService(claude, actions, true, approvals);

    const waiting = await service.respond({
      messages: [{ role: "user", content: "Update both records." }],
    });

    expect(waiting).toMatchObject({
      status: "waiting_for_approval",
      approvalId: firstApprovalId,
      approvalIds: [firstApprovalId, secondApprovalId],
    });
    expect((await approvals.getActionApproval(firstApprovalId))?.chat?.batchApprovalIds).toEqual([
      firstApprovalId,
      secondApprovalId,
    ]);
    expect((await approvals.getActionApproval(secondApprovalId))?.chat?.batchApprovalIds).toEqual([
      firstApprovalId,
      secondApprovalId,
    ]);
    expect(actions.inputs).toHaveLength(2);

    approvals.approve(firstApprovalId);
    const stillWaiting = await service.resume(firstApprovalId);
    expect(stillWaiting).toMatchObject({
      status: "waiting_for_approval",
      approvalId: secondApprovalId,
      approvalIds: [secondApprovalId],
    });
    expect(actions.inputs).toHaveLength(2);

    approvals.approve(secondApprovalId);
    const completed = await service.resume(secondApprovalId);
    expect(completed).toMatchObject({
      status: "completed",
      message: { content: "Both approved changes completed." },
    });
    expect(actions.inputs.slice(2)).toEqual([
      expect.objectContaining({ input: { query: "record-1" }, approvalPolicy: "bypass" }),
      expect.objectContaining({ input: { query: "record-2" }, approvalPolicy: "bypass" }),
    ]);
    expect((await service.getApprovalResult(firstApprovalId)).response).toEqual(completed);
    expect((await service.getApprovalResult(secondApprovalId)).response).toEqual(completed);
  });

  it("rejects conversation history that does not end with a user message", async () => {
    const service = createService(new FakeClaudeCodeClient([]), new FakeActionRunner());

    await expect(
      service.respond({ messages: [{ role: "assistant", content: "How can I help?" }] }),
    ).rejects.toMatchObject({ code: "invalid_chat", status: 400 });
  });

  it("asks Claude for concise, expandable answers when voice mode is enabled", async () => {
    const claude = new FakeClaudeCodeClient([{ kind: "final", text: "Three useful results. Would you like more?" }]);
    const service = createService(claude, new FakeActionRunner());

    await service.respond({ messages: [{ role: "user", content: "Read every result" }], voiceMode: true });

    expect(claude.inputs[0]?.systemPrompt).toContain("keep any spoken list to at most three short items");
    expect(claude.inputs[0]?.systemPrompt).toContain("ask whether the user wants more detail");
  });

  it("runs host-provided workspace tools alongside connector tools", async () => {
    const claude = new FakeClaudeCodeClient([
      { kind: "tool_call", toolName: "synapse_add_artifact", arguments: { title: "Useful result" } },
      { kind: "final", text: "I added the result to the canvas." },
    ]);
    const service = createService(claude, new FakeActionRunner());
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];

    const response = await service.respondWithExtension(
      { messages: [{ role: "user", content: "Keep that result" }] },
      {
        systemPrompt: "Prefer durable artifact cards for useful results.",
        context: { selectedNodeId: "node-1" },
        tools: [
          {
            name: "synapse_add_artifact",
            description: "Add an artifact card.",
            inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
          },
        ],
        async runTool(toolName, input) {
          calls.push({ toolName, input });
          if (toolName !== "synapse_add_artifact") return undefined;
          return {
            id: "graph-activity-1",
            type: "action",
            label: "Add artifact",
            ok: true,
            actionId: toolName,
            input,
            output: { nodeId: "artifact-1" },
          };
        },
      },
    );

    expect(calls).toEqual([{ toolName: "synapse_add_artifact", input: { title: "Useful result" } }]);
    expect(response.toolActivity).toMatchObject([{ actionId: "synapse_add_artifact", ok: true }]);
    expect(claude.inputs[0]?.systemPrompt).toContain("Prefer durable artifact cards");
    expect(claude.inputs[0]?.prompt).toContain("synapse_add_artifact");
    expect(claude.inputs[0]?.prompt).toContain('"selectedNodeId":"node-1"');
  });

  it("uses Claude to decide whether a live voice interruption cancels the running task", async () => {
    const claude = new FakeClaudeCodeClient([
      { cancelCurrentTask: true, reason: "The user explicitly replaced the request." },
    ]);
    const service = createService(claude, new FakeActionRunner());

    const decision = await service.classifyInterruption({
      messages: [{ role: "user", content: "Summarize today's email" }],
      interruption: "Stop, check tomorrow instead",
      progress: "Checking Outlook",
    });

    expect(decision).toEqual({ cancelCurrentTask: true, reason: "The user explicitly replaced the request." });
    expect(claude.inputs[0]?.systemPrompt).toContain("should cancel the Chat task");
    expect(claude.inputs[0]?.effort).toBe("low");
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
  private readonly approvals = new Map<string, ActionApproval>();

  constructor(approval: ActionApproval | ActionApproval[] = createChatApproval(crypto.randomUUID())) {
    for (const item of Array.isArray(approval) ? approval : [approval]) this.approvals.set(item.id, item);
  }

  get approval(): ActionApproval {
    return this.approvals.values().next().value!;
  }

  async getActionApproval(id: string): Promise<ActionApproval | undefined> {
    const approval = this.approvals.get(id);
    return approval ? structuredClone(approval) : undefined;
  }

  async attachChatContinuation(
    id: string,
    messages: NonNullable<ActionApproval["chat"]>["messages"],
    toolActivity: NonNullable<ActionApproval["chat"]>["toolActivity"],
    voiceMode = false,
    batchApprovalIds = [id],
  ): Promise<ActionApproval> {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error("Unexpected approval id");
    const updated = { ...approval, chat: { messages, toolActivity, voiceMode, batchApprovalIds } };
    this.approvals.set(id, updated);
    return structuredClone(updated);
  }

  async consumeApproved(id: string): Promise<ActionApproval> {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== "approved") throw new Error("Approval is not approved");
    const updated = { ...approval, status: "consumed" as const, consumedAt: new Date().toISOString() };
    this.approvals.set(id, updated);
    return structuredClone(updated);
  }

  async storeChatResponse(id: string, response: AgentChatResponse): Promise<ActionApproval> {
    const approval = this.approvals.get(id);
    if (!approval?.chat) throw new Error("Unexpected approval id");
    const updated = { ...approval, chat: { ...approval.chat, response } };
    this.approvals.set(id, updated);
    return structuredClone(updated);
  }

  approve(id = this.approval.id): void {
    const approval = this.approvals.get(id)!;
    this.approvals.set(id, {
      ...approval,
      status: "approved",
      resolvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
}

function createChatApproval(id: string, query = "record-42"): ActionApproval {
  return {
    id,
    status: "pending",
    actionId: "example.lookup",
    connectionId: connection.id,
    caller: "chat",
    input: { query },
    requestHash: "request-hash",
    requestedAt: new Date().toISOString(),
  };
}
