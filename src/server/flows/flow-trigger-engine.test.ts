import type { ConnectionSummary } from "../../connection-service.ts";
import type { ActionPolicySnapshot } from "../../core/action-policy.ts";
import type { ActionRunResult, IActionRunner, RunActionInput } from "../actions/action-runner.ts";
import type {
  FlowApproval,
  FlowApprovalStatus,
  FlowDefinition,
  FlowRun,
  FlowStep,
  FlowTrigger,
  FlowTriggerEvent,
  FlowTriggerState,
  IFlowStore,
} from "./flow-types.ts";

import { describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { provider as outlookProvider } from "../../providers/outlook/definition.ts";
import { FlowTriggerEngine } from "./flow-trigger-engine.ts";

describe("FlowTriggerEngine", () => {
  it("launches a schedule once for each due local minute", async () => {
    const harness = createHarness({ type: "schedule", cron: "0 9 * * *", timeZone: "Australia/Perth" });
    const now = new Date("2026-08-05T01:00:15.000Z");

    await harness.engine.tick(now);
    await harness.engine.tick(new Date("2026-08-05T01:00:45.000Z"));

    expect(harness.starts).toHaveLength(1);
    expect(harness.starts[0]?.event).toMatchObject({
      type: "schedule",
      payload: { scheduledFor: "2026-08-05T09:00@Australia/Perth" },
    });
  });

  it("establishes a connector baseline before launching for a new email", async () => {
    const harness = createHarness({
      type: "new_email",
      connectionId: "source-1",
      pollIntervalSeconds: 60,
    });
    harness.actions.outputs.push(
      { messages: [{ id: "message-1", subject: "Existing" }] },
      {
        messages: [
          { id: "message-2", subject: "New" },
          { id: "message-1", subject: "Existing" },
        ],
      },
    );

    await harness.engine.tick(new Date("2026-08-05T01:00:00.000Z"));
    expect(harness.starts).toHaveLength(0);

    await harness.engine.tick(new Date("2026-08-05T01:01:00.000Z"));
    expect(harness.actions.inputs).toEqual([
      expect.objectContaining({ caller: "trigger", actionId: "outlook.list_messages", flowId: "flow-1" }),
      expect.objectContaining({ caller: "trigger", actionId: "outlook.list_messages", flowId: "flow-1" }),
    ]);
    expect(harness.starts).toHaveLength(1);
    expect(harness.starts[0]?.event).toMatchObject({
      type: "new_email",
      payload: { items: [{ id: "message-2", subject: "New" }] },
    });
  });

  it("launches provider-declared connector events", async () => {
    const harness = createHarness({
      type: "event",
      connectionId: "source-1",
      eventId: "outlook.new_sent_email",
      pollIntervalSeconds: 60,
    });
    harness.actions.outputs.push(
      { messages: [{ id: "sent-1", subject: "Existing" }] },
      { messages: [{ id: "sent-2", subject: "New sent message" }] },
    );

    await harness.engine.tick(new Date("2026-08-05T01:00:00.000Z"));
    await harness.engine.tick(new Date("2026-08-05T01:01:00.000Z"));

    expect(harness.actions.inputs[0]?.input).toMatchObject({ mailFolderId: "sentitems" });
    expect(harness.starts[0]?.event).toMatchObject({
      type: "event",
      payload: {
        eventId: "outlook.new_sent_email",
        items: [{ id: "sent-2", subject: "New sent message" }],
      },
    });
  });

  it("queues one independent Flow run for each new connector item", async () => {
    const harness = createHarness({
      type: "new_email",
      connectionId: "source-1",
      pollIntervalSeconds: 60,
    });
    harness.actions.outputs.push(
      { messages: [{ id: "existing", subject: "Existing" }] },
      {
        messages: [
          { id: "message-2", subject: "Second new email" },
          { id: "message-1", subject: "First new email" },
          { id: "existing", subject: "Existing" },
        ],
      },
    );

    await harness.engine.tick(new Date("2026-08-05T01:00:00.000Z"));
    await harness.engine.tick(new Date("2026-08-05T01:01:00.000Z"));
    await vi.waitFor(() => expect(harness.starts).toHaveLength(2));

    expect(harness.starts.map((start) => start.event?.payload)).toEqual([
      expect.objectContaining({ items: [{ id: "message-2", subject: "Second new email" }] }),
      expect.objectContaining({ items: [{ id: "message-1", subject: "First new email" }] }),
    ]);
  });

  it("adds Outlook attachment metadata to a newly triggered email without downloading file content", async () => {
    const harness = createHarness({
      type: "new_email",
      connectionId: "source-1",
      pollIntervalSeconds: 60,
    });
    harness.actions.outputs.push(
      { messages: [{ id: "existing", subject: "Existing" }] },
      { messages: [{ id: "message-2", subject: "Plans", hasAttachments: true }] },
      {
        attachments: [
          {
            id: "attachment-1",
            name: "plans.pdf",
            contentType: "application/pdf",
            size: 2048,
            isInline: false,
          },
        ],
      },
    );

    await harness.engine.tick(new Date("2026-08-05T01:00:00.000Z"));
    await harness.engine.tick(new Date("2026-08-05T01:01:00.000Z"));

    expect(harness.actions.inputs[2]).toMatchObject({
      actionId: "outlook.list_attachments",
      connectionId: "source-1",
      input: { messageId: "message-2" },
      approvalPolicy: "bypass",
    });
    expect(harness.starts[0]?.event?.payload).toMatchObject({
      items: [
        {
          id: "message-2",
          attachments: [{ id: "attachment-1", name: "plans.pdf", contentType: "application/pdf" }],
        },
      ],
    });
  });

  it("accepts API payloads only for API-triggered flows", async () => {
    const harness = createHarness({ type: "api" });

    await harness.engine.triggerApi("flow-1", { ticketId: 42 });
    expect(harness.starts[0]?.event).toMatchObject({ type: "api", payload: { ticketId: 42 } });

    harness.flow.trigger = { type: "manual" };
    await expect(harness.engine.triggerApi("flow-1", {})).rejects.toMatchObject({ code: "flow_trigger_mismatch" });
  });
});

interface StartCapture {
  trigger?: FlowTriggerEvent["type"];
  event?: FlowTriggerEvent;
}

interface TriggerHarness {
  engine: FlowTriggerEngine;
  flow: FlowDefinition;
  starts: StartCapture[];
  actions: StubActionRunner;
}

function createHarness(trigger: FlowTrigger): TriggerHarness {
  const flow = createFlow(trigger);
  const store = new MemoryFlowStore(flow);
  const starts: StartCapture[] = [];
  const actions = new StubActionRunner();
  const connection: ConnectionSummary = {
    id: "source-1",
    service: trigger.type === "new_email" || trigger.type === "event" ? "outlook" : "obsidian",
    connectionName: "default",
    authType: "oauth2",
    configured: true,
    virtual: false,
    default: true,
    profile: { accountId: "account-1", displayName: "Source", grantedScopes: [] },
  };
  const engine = new FlowTriggerEngine({
    catalog: createCatalogStore([outlookProvider], { executableActionIds: ["outlook.list_messages"] }),
    flows: {
      async list(): Promise<FlowDefinition[]> {
        return [flow];
      },
      async getRequired(): Promise<FlowDefinition> {
        return flow;
      },
    },
    runner: {
      async start(_flowId, input = {}) {
        starts.push(input);
        return {
          run: createRun(flow, input.trigger ?? "manual", input.event),
          steps: [],
          approvals: [],
        };
      },
    },
    store,
    connections: {
      async getConnectionSummaryById(id: string): Promise<ConnectionSummary | undefined> {
        return id === connection.id ? connection : undefined;
      },
    },
    actions,
    async getPolicySnapshot(): Promise<ActionPolicySnapshot> {
      return {} as ActionPolicySnapshot;
    },
  });
  return { engine, flow, starts, actions };
}

class StubActionRunner implements IActionRunner {
  readonly inputs: RunActionInput[] = [];
  readonly outputs: unknown[] = [];

  async run(input: RunActionInput): Promise<ActionRunResult> {
    this.inputs.push(input);
    return {
      executionId: crypto.randomUUID(),
      auditPersisted: true,
      result: { ok: true, output: this.outputs.shift() ?? {} },
    };
  }
}

class MemoryFlowStore implements IFlowStore {
  private readonly flows = new Map<string, FlowDefinition>();
  private readonly states = new Map<string, FlowTriggerState>();

  constructor(flow: FlowDefinition) {
    this.flows.set(flow.id, flow);
  }

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
    this.states.delete(id);
    return this.flows.delete(id);
  }

  async setTriggerState(state: FlowTriggerState): Promise<void> {
    this.states.set(state.flowId, state);
  }

  async getTriggerState(flowId: string): Promise<FlowTriggerState | undefined> {
    return this.states.get(flowId);
  }

  async deleteTriggerState(flowId: string): Promise<void> {
    this.states.delete(flowId);
  }

  async addRun(): Promise<void> {}
  async updateRun(): Promise<void> {}
  async getRun(): Promise<FlowRun | undefined> {
    return undefined;
  }
  async listRuns(): Promise<FlowRun[]> {
    return [];
  }
  async addStep(): Promise<void> {}
  async updateStep(): Promise<void> {}
  async listSteps(): Promise<FlowStep[]> {
    return [];
  }
  async addApproval(): Promise<void> {}
  async getApproval(): Promise<FlowApproval | undefined> {
    return undefined;
  }
  async listApprovals(): Promise<FlowApproval[]> {
    return [];
  }
  async updateApproval(_approval: FlowApproval, _expectedStatus: FlowApprovalStatus): Promise<boolean> {
    return false;
  }
}

function createFlow(trigger: FlowTrigger): FlowDefinition {
  return {
    id: "flow-1",
    revision: "revision-1",
    name: "Triggered sync",
    status: "active",
    sourceConnectionId: "source-1",
    destinationConnectionId: "destination-1",
    instructions: "Synchronize the trigger item.",
    trigger,
    agent: { provider: "claude_code", connectionId: "agent-1", model: "opus", reasoningEffort: "medium" },
    tools: [{ actionId: "outlook.list_messages", connectionId: "source-1", approval: "always_allow" }],
    maxSteps: 8,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

function createRun(flow: FlowDefinition, trigger: FlowTriggerEvent["type"], event?: FlowTriggerEvent): FlowRun {
  return {
    id: crypto.randomUUID(),
    flowId: flow.id,
    flowRevision: flow.revision,
    flowSnapshot: flow,
    trigger,
    triggerEvent: event,
    status: "completed",
    stepCount: 0,
    startedAt: "2026-08-05T01:00:00.000Z",
    updatedAt: "2026-08-05T01:00:00.000Z",
  };
}
