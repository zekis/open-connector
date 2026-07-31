import type { ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { ActionRunResult, IActionRunner, RunActionInput } from "../actions/action-runner.ts";
import type { AgentRuntimeProvider } from "../agents/agent-settings-service.ts";
import type { FlowAgentTurn, FlowAgentTurnInput, IFlowAgent } from "./flow-agent.ts";
import type { FlowApproval, FlowApprovalStatus, FlowDefinition, FlowRun, FlowStep, IFlowStore } from "./flow-types.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ActionPolicyService } from "../../core/action-policy.ts";
import { FlowRunner } from "./flow-runner.ts";

describe("FlowRunner", () => {
  it("executes an always-allowed tool and completes the agent loop", async () => {
    const harness = createHarness("always_allow");

    const detail = await harness.runner.start(harness.flow.id);

    expect(detail.run).toMatchObject({
      flowId: harness.flow.id,
      status: "completed",
      stepCount: 1,
      finalOutput: "Synchronized one source item.",
    });
    expect(detail.steps.map((step) => [step.kind, step.status])).toEqual([
      ["agent", "completed"],
      ["action", "completed"],
      ["agent", "completed"],
    ]);
    expect(detail.approvals).toEqual([]);
    expect(harness.actions.toolCalls).toHaveLength(1);
    expect(harness.actions.toolCalls[0]).toMatchObject({
      actionId: "source.read",
      connectionId: "source-connection",
      caller: "flow",
      flowId: harness.flow.id,
      input: { query: "today" },
    });
    expect(harness.agent.inputs[1]).toMatchObject({
      previousResponseId: "response-1",
      input: {
        type: "flow_tool_result",
        call: {
          callId: "call-1",
        },
      },
    });
  });

  it("pauses before a gated tool, then executes the fingerprinted call after approval", async () => {
    const harness = createHarness("require_approval");

    const waiting = await harness.runner.start(harness.flow.id);
    const approval = waiting.approvals[0]!;
    expect(waiting.run.status).toBe("waiting_for_approval");
    expect(approval).toMatchObject({
      status: "pending",
      actionId: "source.read",
      connectionId: "source-connection",
      input: { query: "today" },
    });
    expect(harness.actions.toolCalls).toEqual([]);

    const completed = await harness.runner.approve(approval.id);

    expect(completed.run.status).toBe("completed");
    expect(completed.approvals[0]?.status).toBe("approved");
    expect(completed.steps.find((step) => step.kind === "action")?.status).toBe("completed");
    expect(harness.actions.toolCalls).toHaveLength(1);
    await expect(harness.runner.approve(approval.id)).rejects.toMatchObject({
      code: "approval_not_pending",
    });
  });

  it("cancels a run without executing a denied tool", async () => {
    const harness = createHarness("require_approval");
    const waiting = await harness.runner.start(harness.flow.id);

    const cancelled = await harness.runner.deny(waiting.approvals[0]!.id);

    expect(cancelled.run).toMatchObject({
      status: "cancelled",
      errorCode: "approval_denied",
    });
    expect(cancelled.steps.find((step) => step.kind === "action")?.status).toBe("denied");
    expect(harness.actions.toolCalls).toEqual([]);
  });

  it("snapshots the current Agents-page model when a run starts", async () => {
    const harness = createHarness("always_allow", "sonnet");

    const detail = await harness.runner.start(harness.flow.id);

    expect(detail.run.flowSnapshot.agent.model).toBe("sonnet");
    expect(harness.agent.inputs[0]?.flow.agent.model).toBe("sonnet");
    expect(harness.flow.agent.model).toBe("opus");
  });
});

function createHarness(
  approval: "always_allow" | "require_approval",
  currentModel = "opus",
): {
  flow: FlowDefinition;
  actions: FakeActionRunner;
  agent: FakeFlowAgent;
  runner: FlowRunner;
} {
  const flow = createFlow(approval);
  const store = new MemoryFlowStore();
  const actions = new FakeActionRunner();
  const agent = new FakeFlowAgent();
  const connections = new Map(createConnections().map((connection) => [connection.id, connection]));
  const runner = new FlowRunner({
    catalog: createFlowCatalog(),
    connections: {
      async getConnectionSummaryById(id: string): Promise<ConnectionSummary | undefined> {
        return connections.get(id);
      },
    },
    flows: {
      async getRequired(id: string): Promise<FlowDefinition> {
        if (id !== flow.id) {
          throw new Error("Flow not found.");
        }
        return flow;
      },
    },
    store,
    actions,
    claudeCodeAgent: agent,
    agentSettings: {
      async get(provider: AgentRuntimeProvider) {
        return { provider, model: currentModel };
      },
    },
    getPolicySnapshot: async () => new ActionPolicyService().createSnapshot(),
  });
  return { flow, actions, agent, runner };
}

class FakeActionRunner implements IActionRunner {
  readonly toolCalls: RunActionInput[] = [];

  async run(input: RunActionInput): Promise<ActionRunResult | undefined> {
    this.toolCalls.push(input);
    return actionResult({ items: [{ id: "item-1" }] });
  }
}

class FakeFlowAgent implements IFlowAgent {
  readonly inputs: FlowAgentTurnInput[] = [];

  async respond(input: FlowAgentTurnInput): Promise<FlowAgentTurn> {
    this.inputs.push(input);
    return this.inputs.length === 1
      ? {
          responseId: "response-1",
          functionCall: {
            callId: "call-1",
            name: "flow_1_source_read",
            arguments: JSON.stringify({ query: "today" }),
          },
        }
      : {
          responseId: "response-2",
          text: "Synchronized one source item.",
        };
  }
}

class MemoryFlowStore implements IFlowStore {
  private readonly flows = new Map<string, FlowDefinition>();
  private readonly runs = new Map<string, FlowRun>();
  private readonly steps = new Map<string, FlowStep>();
  private readonly approvals = new Map<string, FlowApproval>();

  async setFlow(flow: FlowDefinition): Promise<void> {
    this.flows.set(flow.id, flow);
  }

  async getFlow(id: string): Promise<FlowDefinition | undefined> {
    return this.flows.get(id);
  }

  async listFlows(): Promise<FlowDefinition[]> {
    return [...this.flows.values()];
  }

  async deleteFlow(id: string): Promise<boolean> {
    return this.flows.delete(id);
  }

  async addRun(run: FlowRun): Promise<void> {
    this.runs.set(run.id, run);
  }

  async updateRun(run: FlowRun): Promise<void> {
    this.runs.set(run.id, run);
  }

  async getRun(id: string): Promise<FlowRun | undefined> {
    return this.runs.get(id);
  }

  async listRuns(flowId?: string, limit = 100): Promise<FlowRun[]> {
    return [...this.runs.values()].filter((run) => !flowId || run.flowId === flowId).slice(0, limit);
  }

  async addStep(step: FlowStep): Promise<void> {
    this.steps.set(step.id, step);
  }

  async updateStep(step: FlowStep): Promise<void> {
    this.steps.set(step.id, step);
  }

  async listSteps(runId: string): Promise<FlowStep[]> {
    return [...this.steps.values()]
      .filter((step) => step.runId === runId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async addApproval(approval: FlowApproval): Promise<void> {
    this.approvals.set(approval.id, approval);
  }

  async getApproval(id: string): Promise<FlowApproval | undefined> {
    return this.approvals.get(id);
  }

  async listApprovals(status?: FlowApprovalStatus): Promise<FlowApproval[]> {
    return [...this.approvals.values()].filter((approval) => !status || approval.status === status);
  }

  async updateApproval(approval: FlowApproval, expectedStatus: FlowApprovalStatus): Promise<boolean> {
    if (this.approvals.get(approval.id)?.status !== expectedStatus) {
      return false;
    }
    this.approvals.set(approval.id, approval);
    return true;
  }
}

function actionResult(output: unknown): ActionRunResult {
  return {
    executionId: crypto.randomUUID(),
    auditPersisted: true,
    result: {
      ok: true,
      output,
    },
  };
}

function createFlow(approval: "always_allow" | "require_approval"): FlowDefinition {
  return {
    id: "flow-1",
    revision: "revision-1",
    name: "Source sync",
    status: "active",
    sourceConnectionId: "source-connection",
    destinationConnectionId: "destination-connection",
    instructions: "Read today's source items and synchronize them to the destination.",
    agent: {
      provider: "claude_code",
      connectionId: "claude-subscription-connection",
      model: "opus",
      reasoningEffort: "medium",
    },
    tools: [
      {
        actionId: "source.read",
        connectionId: "source-connection",
        approval,
      },
    ],
    maxSteps: 4,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function createConnections(): ConnectionSummary[] {
  return [
    connection("source-connection", "source", "Source"),
    connection("destination-connection", "destination", "Destination"),
  ];
}

function connection(id: string, service: string, displayName: string): ConnectionSummary {
  return {
    id,
    service,
    connectionName: "default",
    authType: "no_auth",
    configured: true,
    virtual: false,
    default: true,
    profile: {
      accountId: id,
      displayName,
      grantedScopes: [],
    },
  };
}

function createFlowCatalog() {
  const providers: ProviderDefinition[] = [
    {
      service: "source",
      displayName: "Source",
      categories: [],
      authTypes: ["no_auth"],
      auth: [{ type: "no_auth" }],
      actions: [
        {
          id: "source.read",
          service: "source",
          name: "read",
          description: "Read source items.",
          requiredScopes: [],
          providerPermissions: [],
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: { type: "object" },
        },
      ],
    },
  ];
  return createCatalogStore(providers, { executableActionIds: ["source.read"] });
}
