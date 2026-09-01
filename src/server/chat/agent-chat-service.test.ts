import type { ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { ExecutionResult } from "../../core/types.ts";
import type { IActionRunner, RunActionInput } from "../actions/action-runner.ts";
import type { AgentModelOption } from "../agents/agent-settings-service.ts";
import type { AgentTurnRequest } from "../agents/agent-turn.ts";
import type { ClaudeCodeTurnInput, ClaudeCodeTurnResult, IClaudeCodeClient } from "../agents/claude-code-client.ts";
import type { ActionApproval } from "../approvals/connection-approval-types.ts";
import type { ITransitFileService } from "../files/transit-file-store.ts";
import type { FlowRunDetail } from "../flows/flow-runner.ts";
import type { FlowDefinition, FlowDefinitionInput, FlowRun } from "../flows/flow-types.ts";
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

  it("creates an explicitly requested scheduled Flow through the platform scheduler", async () => {
    const claude = new FakeClaudeCodeClient([
      { kind: "tool_call", toolName: "list_flows", arguments: {} },
      { kind: "tool_call", toolName: "search_connector_actions", arguments: { query: "look up record" } },
      {
        kind: "tool_call",
        toolName: "create_flow",
        arguments: {
          name: "Daily record check",
          status: "active",
          sourceConnectionIds: [connection.id],
          destinationConnectionId: connection.id,
          instructions: "Look up record 42 and report whether it is active.",
          trigger: { type: "schedule", cron: "0 9 * * *", timeZone: "Australia/Perth" },
          tools: [
            {
              actionId: "example.lookup",
              connectionId: connection.id,
              role: "source",
              approval: "inherit",
            },
          ],
          userConfirmedActivation: true,
        },
      },
      { kind: "final", text: "Created and activated the daily record check." },
    ]);
    const flows = new FakeFlowService();
    const service = createService(claude, new FakeActionRunner(), true, new FakeChatApprovals(), flows);

    const response = await service.respond({
      messages: [{ role: "user", content: "Create a Flow that checks record 42 every day at 9am Perth time." }],
    });

    expect(response.status).toBe("completed");
    expect(response.toolActivity).toMatchObject([
      { label: "List flows", ok: true },
      { type: "search", ok: true },
      { label: "Create flow", ok: true },
    ]);
    expect(flows.createInputs).toEqual([
      {
        name: "Daily record check",
        status: "active",
        sourceConnectionIds: [connection.id],
        destinationConnectionId: connection.id,
        instructions: "Look up record 42 and report whether it is active.",
        trigger: { type: "schedule", cron: "0 9 * * *", timeZone: "Australia/Perth" },
        agent: { connectionId: "claude-subscription" },
        tools: [
          {
            actionId: "example.lookup",
            connectionId: connection.id,
            role: "source",
            approval: "inherit",
          },
        ],
        maxSteps: undefined,
      },
    ]);
    expect(claude.inputs[0]?.systemPrompt).toContain("OOMOL Connect itself owns Flow scheduling");
    expect(claude.inputs[0]?.prompt).toContain('"name":"create_flow"');
  });

  it("blocks active Flow creation when the agent cannot assert explicit user confirmation", async () => {
    const claude = new FakeClaudeCodeClient([
      {
        kind: "tool_call",
        toolName: "create_flow",
        arguments: {
          name: "Unconfirmed automation",
          status: "active",
          sourceConnectionIds: [connection.id],
          destinationConnectionId: connection.id,
          instructions: "Look up a record every day.",
          trigger: { type: "schedule", cron: "0 9 * * *", timeZone: "Australia/Perth" },
          tools: [
            {
              actionId: "example.lookup",
              connectionId: connection.id,
              role: "source",
              approval: "inherit",
            },
          ],
          userConfirmedActivation: false,
        },
      },
      { kind: "final", text: "Please confirm that you want me to activate this daily Flow." },
    ]);
    const flows = new FakeFlowService();
    const service = createService(claude, new FakeActionRunner(), true, new FakeChatApprovals(), flows);

    const response = await service.respond({
      messages: [{ role: "user", content: "Could you suggest a daily record-checking Flow?" }],
    });

    expect(flows.createInputs).toEqual([]);
    expect(response.toolActivity[0]).toMatchObject({
      label: "Create flow",
      ok: false,
      output: { error: { code: "flow_confirmation_required" } },
    });
    expect(response.message.content).toContain("confirm");
  });

  it("creates a Flow with a new Synapse canvas destination through Chat", async () => {
    const claude = new FakeClaudeCodeClient([
      {
        kind: "tool_call",
        toolName: "create_flow",
        arguments: {
          name: "Daily canvas digest",
          status: "active",
          sourceConnectionIds: [connection.id],
          destinationSynapseName: "Daily digest",
          instructions: "Look up record 42 and publish a concise canvas digest.",
          trigger: { type: "schedule", cron: "0 9 * * *", timeZone: "Australia/Perth" },
          tools: [
            {
              actionId: "example.lookup",
              connectionId: connection.id,
              role: "source",
              approval: "inherit",
            },
          ],
          userConfirmedActivation: true,
        },
      },
      { kind: "final", text: "Created the daily canvas digest." },
    ]);
    const flows = new FakeFlowService();
    const service = createService(claude, new FakeActionRunner(), true, new FakeChatApprovals(), flows);

    await service.respond({
      messages: [{ role: "user", content: "Create a daily Flow and put its result on a new canvas." }],
    });

    expect(flows.createInputs[0]).toMatchObject({
      destinationSynapseName: "Daily digest",
      sourceConnectionIds: [connection.id],
    });
    expect(flows.createInputs[0]?.destinationConnectionId).toBeUndefined();
  });

  it("passes every requested source connection into a multi-source Flow", async () => {
    const sourceConnectionIds = ["azure-devops-1", "outlook-calendar-1", "outlook-mail-1", "granola-1"];
    const claude = new FakeClaudeCodeClient([
      {
        kind: "tool_call",
        toolName: "create_flow",
        arguments: {
          name: "Daily multi-source briefing",
          status: "paused",
          sourceConnectionIds,
          destinationSynapseName: "Daily briefing",
          instructions: "Combine work items, meetings, mail, and meeting notes into one briefing.",
          trigger: { type: "manual" },
          tools: [
            {
              actionId: "example.lookup",
              connectionId: connection.id,
              role: "source",
              approval: "inherit",
            },
          ],
          userConfirmedActivation: false,
        },
      },
      { kind: "final", text: "Created the multi-source Flow draft." },
    ]);
    const flows = new FakeFlowService();
    const service = createService(claude, new FakeActionRunner(), true, new FakeChatApprovals(), flows);

    await service.respond({
      messages: [{ role: "user", content: "Create one Flow using these four source connections." }],
    });

    expect(flows.createInputs[0]?.sourceConnectionIds).toEqual(sourceConnectionIds);
    expect(claude.inputs[0]?.systemPrompt).toContain("multi-source Flows");
    expect(claude.inputs[0]?.prompt).toContain('"sourceConnectionIds"');
  });

  it("lists, reads, updates, activates, and deletes Flows through Chat", async () => {
    const flows = new FakeFlowService();
    await flows.create({
      name: "Record check draft",
      status: "paused",
      sourceConnectionIds: [connection.id],
      destinationConnectionId: connection.id,
      instructions: "Look up record 42.",
      trigger: { type: "manual" },
      agent: { connectionId: "claude-subscription" },
      tools: [
        {
          actionId: "example.lookup",
          connectionId: connection.id,
          role: "source",
          approval: "inherit",
        },
      ],
    });
    flows.createInputs.length = 0;
    const claude = new FakeClaudeCodeClient([
      { kind: "tool_call", toolName: "list_flows", arguments: {} },
      { kind: "tool_call", toolName: "get_flow", arguments: { flowId: "flow-1" } },
      {
        kind: "tool_call",
        toolName: "update_flow",
        arguments: {
          flowId: "flow-1",
          changes: {
            instructions: "Look up record 42 and report whether it is active.",
            trigger: { type: "schedule", cron: "0 9 * * *", timeZone: "Australia/Perth" },
          },
          userConfirmedChange: false,
        },
      },
      {
        kind: "tool_call",
        toolName: "set_flow_status",
        arguments: { flowId: "flow-1", status: "active", userConfirmedActivation: true },
      },
      {
        kind: "tool_call",
        toolName: "delete_flow",
        arguments: { flowId: "flow-1", userConfirmedDeletion: true },
      },
      { kind: "final", text: "Updated, activated, and then deleted the Flow as requested." },
    ]);
    const service = createService(claude, new FakeActionRunner(), true, new FakeChatApprovals(), flows);

    const response = await service.respond({
      messages: [
        {
          role: "user",
          content: "Schedule the draft for 9am Perth time, activate it, and then delete it as a test.",
        },
      ],
    });

    expect(response.toolActivity.map((activity) => activity.label)).toEqual([
      "List flows",
      "Get flow",
      "Update flow",
      "Set flow status",
      "Delete flow",
    ]);
    expect(flows.updateInputs).toHaveLength(2);
    expect(flows.updateInputs[0]?.input).toMatchObject({
      status: "paused",
      instructions: "Look up record 42 and report whether it is active.",
      trigger: { type: "schedule", cron: "0 9 * * *", timeZone: "Australia/Perth" },
    });
    expect(flows.updateInputs[1]?.input.status).toBe("active");
    expect(flows.deleteInputs).toEqual(["flow-1"]);
  });

  it("reads Flow run history and the persisted execution trace through Chat", async () => {
    const flows = new FakeFlowService();
    const flow = await flows.create({
      name: "Record check",
      status: "active",
      sourceConnectionIds: [connection.id],
      destinationConnectionId: connection.id,
      instructions: "Look up record 42.",
      trigger: { type: "schedule", cron: "0 9 * * *", timeZone: "Australia/Perth" },
      agent: { connectionId: "claude-subscription" },
      tools: [
        {
          actionId: "example.lookup",
          connectionId: connection.id,
          role: "source",
          approval: "inherit",
        },
      ],
    });
    const run: FlowRun = {
      id: "run-1",
      flowId: flow.id,
      flowRevision: flow.revision,
      flowSnapshot: flow,
      trigger: "schedule",
      status: "failed",
      stepCount: 2,
      startedAt: "2026-08-25T01:00:00.000Z",
      updatedAt: "2026-08-25T01:00:02.000Z",
      completedAt: "2026-08-25T01:00:02.000Z",
      errorCode: "action_failed",
      errorMessage: "The provider rejected record 42.",
    };
    flows.runDetails.push({
      run,
      steps: [
        {
          id: "step-2",
          runId: run.id,
          sequence: 2,
          kind: "action",
          status: "failed",
          startedAt: "2026-08-25T01:00:01.000Z",
          completedAt: "2026-08-25T01:00:02.000Z",
          actionId: "example.lookup",
          connectionId: connection.id,
          input: { query: "42" },
          errorCode: "provider_error",
          errorMessage: "The provider rejected record 42.",
        },
        {
          id: "step-1",
          runId: run.id,
          sequence: 1,
          kind: "agent",
          status: "completed",
          startedAt: "2026-08-25T01:00:00.000Z",
          completedAt: "2026-08-25T01:00:01.000Z",
        },
      ],
      approvals: [],
    });
    const claude = new FakeClaudeCodeClient([
      { kind: "tool_call", toolName: "list_flow_runs", arguments: { flowId: flow.id, limit: 5 } },
      { kind: "tool_call", toolName: "get_flow_run", arguments: { runId: run.id } },
      { kind: "final", text: "The trace shows that the provider rejected record 42." },
    ]);
    const service = createService(claude, new FakeActionRunner(), true, new FakeChatApprovals(), flows);

    const response = await service.respond({
      messages: [{ role: "user", content: "Why did the latest Record check Flow fail?" }],
    });

    expect(response.toolActivity).toMatchObject([
      {
        label: "List flow runs",
        ok: true,
        output: {
          runs: [
            {
              id: run.id,
              flowId: flow.id,
              flowName: flow.name,
              status: "failed",
              errorCode: "action_failed",
            },
          ],
        },
      },
      {
        label: "Get flow run",
        ok: true,
        output: {
          run: { id: run.id, errorCode: "action_failed" },
          steps: [
            { id: "step-1", sequence: 1 },
            { id: "step-2", sequence: 2, errorCode: "provider_error" },
          ],
        },
      },
    ]);
    expect(flows.listRunInputs).toEqual([{ flowId: flow.id, limit: 5 }]);
    expect(flows.getRunInputs).toEqual([run.id]);
    expect(claude.inputs[0]?.systemPrompt).toContain("inspect list_flow_runs and get_flow_run before diagnosing");
    expect(claude.inputs[0]?.prompt).toContain('"name":"get_flow_run"');
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
      timeZone: "Australia/Perth",
    });

    expect(waiting).toMatchObject({ status: "waiting_for_approval", approvalId });
    expect(approvals.approval.chat).toMatchObject({
      messages: [{ role: "user", content: "Is record 42 active?" }],
      timeZone: "Australia/Perth",
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
    expect(claude.inputs[3]?.prompt).toContain('"timeZone":"Australia/Perth"');
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

  it("includes the current UTC and user-local date and time in every Chat prompt", async () => {
    const claude = new FakeClaudeCodeClient([{ kind: "final", text: "It is Thursday afternoon in Perth." }]);
    const now = () => new Date("2026-08-20T07:15:30.000Z");
    const service = createService(claude, new FakeActionRunner(), true, new FakeChatApprovals(), undefined, now);

    await service.respond({
      messages: [{ role: "user", content: "What day and time is it?" }],
      timeZone: "Australia/Perth",
    });

    expect(claude.inputs[0]?.prompt).toContain("Current date and time:");
    expect(claude.inputs[0]?.prompt).toContain('"utc":"2026-08-20T07:15:30.000Z"');
    expect(claude.inputs[0]?.prompt).toContain('"timeZone":"Australia/Perth"');
    expect(claude.inputs[0]?.prompt).toContain("August 20, 2026");
    expect(claude.inputs[0]?.systemPrompt).toContain("host-supplied current date and time");
  });

  it("rejects invalid Chat time zones before calling the agent", async () => {
    const claude = new FakeClaudeCodeClient([]);
    const service = createService(claude, new FakeActionRunner());

    await expect(
      service.respond({
        messages: [{ role: "user", content: "What time is it?" }],
        timeZone: "Mars/Olympus_Mons",
      }),
    ).rejects.toMatchObject({ code: "invalid_chat", status: 400 });
    expect(claude.inputs).toEqual([]);
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

  it("lets an extension restrict connector discovery and safely bypass approval for allowed reads", async () => {
    const claude = new FakeClaudeCodeClient([
      { kind: "tool_call", toolName: "search_connector_actions", arguments: { query: "lookup" } },
      {
        kind: "tool_call",
        toolName: "run_connector_action",
        arguments: {
          actionId: "example.lookup",
          connectionId: connection.id,
          input: { query: "record-42" },
        },
      },
      { kind: "final", text: "Discovery complete." },
    ]);
    const actions = new FakeActionRunner();
    const service = createService(claude, actions);

    const response = await service.respondWithExtension(
      { messages: [{ role: "user", content: "Discover the record" }] },
      {
        systemPrompt: "Use read-only discovery.",
        tools: [],
        connectorActionIds: new Set(["example.lookup"]),
        connectorApprovalPolicy: "bypass",
        includeFlowTools: false,
        async runTool() {
          return undefined;
        },
      },
    );

    expect(response.status).toBe("completed");
    expect(actions.inputs).toEqual([
      expect.objectContaining({
        actionId: "example.lookup",
        approvalPolicy: "bypass",
        caller: "chat",
      }),
    ]);
    expect(claude.inputs[1]?.prompt).toContain("example.lookup");
    expect(claude.inputs[0]?.prompt).not.toContain('"name":"create_flow"');
  });

  it("keeps connector access scoped to exact connection and action pairs", async () => {
    const hiddenConnection: ConnectionSummary = {
      ...connection,
      id: "connection-2",
      connectionName: "hidden",
      default: false,
      profile: { ...connection.profile, accountId: "hidden-account", displayName: "Hidden account" },
    };
    const claude = new FakeClaudeCodeClient([
      { kind: "tool_call", toolName: "search_connector_actions", arguments: { query: "lookup" } },
      {
        kind: "tool_call",
        toolName: "run_connector_action",
        arguments: {
          actionId: "example.lookup",
          connectionId: hiddenConnection.id,
          input: { query: "record-42" },
        },
      },
      { kind: "final", text: "The hidden connection was blocked." },
    ]);
    const actions = new FakeActionRunner();
    const service = createService(claude, actions, true, new FakeChatApprovals(), new FakeFlowService(), undefined, [
      connection,
      hiddenConnection,
    ]);

    const response = await service.respondWithExtension(
      { messages: [{ role: "user", content: "Discover the record" }] },
      {
        systemPrompt: "Use only the explicitly granted account.",
        tools: [],
        connectorGrants: [{ connectionId: connection.id, actionIds: new Set(["example.lookup"]) }],
        connectorApprovalPolicy: "bypass",
        includeFlowTools: false,
        async runTool() {
          return undefined;
        },
      },
    );

    expect(response.toolActivity[0]?.output).toMatchObject({
      results: [
        {
          actionId: "example.lookup",
          compatibleConnections: [{ connectionId: connection.id }],
        },
      ],
    });
    expect(response.toolActivity[1]).toMatchObject({
      ok: false,
      output: { error: { code: "action_not_available" } },
    });
    expect(actions.inputs).toEqual([]);
    expect(claude.inputs[0]?.prompt).toContain("Example account");
    expect(claude.inputs[0]?.prompt).not.toContain("Hidden account");
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

  it("uses a verified Codex ChatGPT subscription when requested", async () => {
    const catalog = createCatalogStore([provider], { executableActionIds: ["example.lookup"] });
    const codexInputs: AgentTurnRequest[] = [];
    const service = new AgentChatService({
      catalog,
      connections: {
        async listConnections() {
          return [connection];
        },
      },
      agents: {
        async list() {
          return [
            {
              id: "codex-subscription",
              provider: "openai_codex" as const,
              authType: "chatgpt_subscription" as const,
              configured: true as const,
              displayName: "ChatGPT subscription",
            },
          ];
        },
        async getClaudeOAuthToken() {
          throw new Error("Claude must not be selected.");
        },
        async assertCodexConnection(id) {
          expect(id).toBe("codex-subscription");
        },
      },
      agentSettings: {
        async get(provider) {
          return { provider, model: "gpt-5.6-sol" };
        },
      },
      claudeCode: new FakeClaudeCodeClient([]),
      codex: {
        async completeTurn(input) {
          codexInputs.push(input);
          return { structuredOutput: { kind: "final", text: "Answered by Codex." } };
        },
      },
      actions: new FakeActionRunner(),
      flows: new FakeFlowService(),
      flowRuns: new FakeFlowService(),
      approvals: new FakeChatApprovals(),
      getPolicySnapshot: async () => new ActionPolicyService().createSnapshot(),
    });

    const response = await service.respond({
      messages: [{ role: "user", content: "Hello" }],
      agentProvider: "openai_codex",
    });

    expect(response.message.content).toBe("Answered by Codex.");
    expect(codexInputs[0]).toMatchObject({ model: "gpt-5.6-sol", effort: "medium" });
  });

  it("resolves transit-file references into native agent attachments", async () => {
    const claude = new FakeClaudeCodeClient([{ kind: "final", text: "I reviewed the attachment." }]);
    const file = new File(["attachment contents"], "report.txt", { type: "text/plain" });
    const service = createService(
      claude,
      new FakeActionRunner(),
      true,
      new FakeChatApprovals(),
      new FakeFlowService(),
      undefined,
      [connection],
      {
        async read(fileId) {
          expect(fileId).toBe("file-1");
          return { file, sizeBytes: file.size, name: file.name, mimeType: file.type };
        },
      },
    );

    await service.respond({
      messages: [
        {
          role: "user",
          content: "Review the attachment.",
          attachments: [{ fileId: "file-1", name: "report.txt", mimeType: "text/plain", sizeBytes: file.size }],
        },
      ],
    });

    expect(claude.inputs[0]?.attachments?.[0]?.id).toBe("file-1");
    await expect(claude.inputs[0]?.attachments?.[0]?.file.text()).resolves.toBe("attachment contents");
  });
});

function createService(
  claudeCode: IClaudeCodeClient,
  actions: IActionRunner,
  agentConfigured = true,
  approvals = new FakeChatApprovals(),
  flows = new FakeFlowService(),
  now?: () => Date,
  connections: ConnectionSummary[] = [connection],
  transitFiles?: Pick<ITransitFileService, "read">,
): AgentChatService {
  const catalog = createCatalogStore([provider], { executableActionIds: ["example.lookup"] });
  return new AgentChatService({
    catalog,
    connections: {
      async listConnections() {
        return connections;
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
    flows,
    flowRuns: flows,
    approvals,
    getPolicySnapshot: async () => new ActionPolicyService().createSnapshot(),
    transitFiles,
    now,
  });
}

class FakeFlowService {
  readonly createInputs: FlowDefinitionInput[] = [];
  readonly updateInputs: Array<{ id: string; input: FlowDefinitionInput }> = [];
  readonly deleteInputs: string[] = [];
  readonly listRunInputs: Array<{ flowId?: string; limit?: number }> = [];
  readonly getRunInputs: string[] = [];
  readonly runDetails: FlowRunDetail[] = [];
  private readonly flows = new Map<string, FlowDefinition>();

  async create(input: unknown): Promise<FlowDefinition> {
    const value = structuredClone(input) as FlowDefinitionInput;
    this.createInputs.push(value);
    const flow = createFlowDefinition(`flow-${this.flows.size + 1}`, value);
    this.flows.set(flow.id, flow);
    return structuredClone(flow);
  }

  async update(id: string, input: unknown): Promise<FlowDefinition> {
    const value = structuredClone(input) as FlowDefinitionInput;
    this.updateInputs.push({ id, input: value });
    const flow = createFlowDefinition(id, value);
    this.flows.set(id, flow);
    return structuredClone(flow);
  }

  async list(): Promise<FlowDefinition[]> {
    return structuredClone([...this.flows.values()]);
  }

  async getRequired(id: string): Promise<FlowDefinition> {
    const flow = this.flows.get(id);
    if (!flow) throw new Error(`Flow not found: ${id}`);
    return structuredClone(flow);
  }

  async delete(id: string): Promise<void> {
    this.deleteInputs.push(id);
    this.flows.delete(id);
  }

  async listRuns(flowId?: string, limit?: number): Promise<FlowRun[]> {
    this.listRunInputs.push({ flowId, limit });
    const runs = this.runDetails.map((detail) => detail.run).filter((run) => !flowId || run.flowId === flowId);
    return structuredClone(runs.slice(0, limit));
  }

  async getRunDetail(id: string): Promise<FlowRunDetail> {
    this.getRunInputs.push(id);
    const detail = this.runDetails.find((candidate) => candidate.run.id === id);
    if (!detail) throw new Error(`Flow run not found: ${id}`);
    return structuredClone(detail);
  }
}

function createFlowDefinition(id: string, input: FlowDefinitionInput): FlowDefinition {
  const now = new Date().toISOString();
  return {
    id,
    revision: crypto.randomUUID(),
    name: input.name,
    status: input.status ?? "active",
    ...(input.sourceConnectionIds ? { sourceConnectionIds: input.sourceConnectionIds } : {}),
    ...(input.sourceConnectionId ? { sourceConnectionId: input.sourceConnectionId } : {}),
    ...(input.destinationConnectionId ? { destinationConnectionId: input.destinationConnectionId } : {}),
    ...(input.destinationSynapseId ? { destinationSynapseId: input.destinationSynapseId } : {}),
    instructions: input.instructions,
    trigger: input.trigger ?? { type: "manual" },
    agent: {
      provider: input.agent.provider ?? "claude_code",
      connectionId: input.agent.connectionId,
      model: "opus",
      reasoningEffort: input.agent.reasoningEffort ?? "medium",
    },
    tools: input.tools,
    maxSteps: input.maxSteps ?? 20,
    createdAt: now,
    updatedAt: now,
  };
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
    timeZone?: string,
  ): Promise<ActionApproval> {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error("Unexpected approval id");
    const updated = { ...approval, chat: { messages, toolActivity, voiceMode, batchApprovalIds, timeZone } };
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
