import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService } from "../../connection-service.ts";
import type { ActionPolicySnapshot } from "../../core/action-policy.ts";
import type { IActionRunner } from "../actions/action-runner.ts";
import type { Logger } from "../logger.ts";
import type { FlowRunDetail, FlowRunner } from "./flow-runner.ts";
import type { FlowService } from "./flow-service.ts";
import type {
  FileCreatedFlowTrigger,
  FlowDefinition,
  FlowTriggerEvent,
  FlowTriggerState,
  IFlowStore,
  NewEmailFlowTrigger,
  ProviderEventFlowTrigger,
} from "./flow-types.ts";

import { matchCronSchedule } from "./cron-schedule.ts";
import { FlowError } from "./flow-service.ts";
import { createFlowPollPlan } from "./flow-trigger-adapters.ts";

export interface FlowTriggerEngineOptions {
  flows: Pick<FlowService, "list" | "getRequired">;
  runner: Pick<FlowRunner, "start">;
  store: IFlowStore;
  connections: Pick<ConnectionService, "getConnectionSummaryById">;
  catalog: CatalogStore;
  actions: IActionRunner;
  getPolicySnapshot(): Promise<ActionPolicySnapshot>;
  logger?: Logger;
}

const defaultTickIntervalMs = 15_000;
const maximumSeenIds = 1_000;

/** Detects schedule and connector events and dispatches them through the existing Flow runner. */
export class FlowTriggerEngine {
  private readonly options: FlowTriggerEngineOptions;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(options: FlowTriggerEngineOptions) {
    this.options = options;
  }

  start(intervalMs: number = defaultTickIntervalMs): void {
    if (this.timer) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    (this.timer as ReturnType<typeof setInterval> & { unref?(): void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async triggerApi(flowId: string, payload: unknown): Promise<FlowRunDetail> {
    const flow = await this.options.flows.getRequired(flowId);
    if (flow.trigger.type !== "api") {
      throw new FlowError("flow_trigger_mismatch", `Flow is not configured for API triggering: ${flowId}.`);
    }
    const event = createEvent("api", new Date(), payload);
    return await this.options.runner.start(flowId, { trigger: "api", event });
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const flows = await this.options.flows.list();
      for (const flow of flows) {
        if (flow.status !== "active" || this.inFlight.has(flow.id)) {
          continue;
        }
        try {
          if (flow.trigger.type === "schedule") {
            await this.checkSchedule(flow, now);
          } else if (
            flow.trigger.type === "event" ||
            flow.trigger.type === "new_email" ||
            flow.trigger.type === "file_created"
          ) {
            await this.checkConnectionEvent(flow, flow.trigger, now);
          }
        } catch (error) {
          await this.recordError(flow, now, error);
        }
      }
    } catch (error) {
      this.options.logger?.warn({ error }, "flow trigger tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async checkSchedule(flow: FlowDefinition, now: Date): Promise<void> {
    if (flow.trigger.type !== "schedule") {
      return;
    }
    const match = matchCronSchedule(flow.trigger.cron, flow.trigger.timeZone, now);
    if (!match.due) {
      return;
    }
    const state = await this.readState(flow, now);
    if (state.lastScheduleKey === match.key) {
      return;
    }
    const occurredAt = now.toISOString();
    await this.options.store.setTriggerState({
      ...state,
      initialized: true,
      lastScheduleKey: match.key,
      lastCheckedAt: occurredAt,
      lastTriggeredAt: occurredAt,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: occurredAt,
    });
    this.launch(
      flow,
      createEvent("schedule", now, {
        cron: flow.trigger.cron,
        timeZone: flow.trigger.timeZone,
        scheduledFor: match.key,
      }),
    );
  }

  private async checkConnectionEvent(
    flow: FlowDefinition,
    trigger: ProviderEventFlowTrigger | NewEmailFlowTrigger | FileCreatedFlowTrigger,
    now: Date,
  ): Promise<void> {
    const state = await this.readState(flow, now);
    if (!isPollDue(state.lastCheckedAt, trigger.pollIntervalSeconds, now)) {
      return;
    }
    const connection = await this.options.connections.getConnectionSummaryById(trigger.connectionId);
    if (!connection) {
      throw new Error(`Flow trigger connection is unavailable: ${trigger.connectionId}.`);
    }
    const provider = this.options.catalog.providers.find((candidate) => candidate.service === connection.service);
    if (!provider) {
      throw new Error(`Flow trigger provider is unavailable: ${connection.service}.`);
    }
    const plan = createFlowPollPlan(trigger, provider);
    const policy = await this.options.getPolicySnapshot();
    const actionRun = await this.options.actions.run({
      actionId: plan.actionId,
      connectionId: trigger.connectionId,
      input: plan.input,
      caller: "trigger",
      policy,
      flowId: flow.id,
      approvalPolicy: "bypass",
    });
    if (!actionRun?.result.ok) {
      throw new Error(actionRun?.result.error?.message ?? `Trigger detector action did not run: ${plan.actionId}.`);
    }
    const items = plan.readItems(actionRun.result.output);
    const currentIds = items.map((item) => item.id);
    const previousIds = new Set(state.seenIds);
    const newItems = state.initialized ? items.filter((item) => !previousIds.has(item.id)) : [];
    const checkedAt = now.toISOString();
    const nextState: FlowTriggerState = {
      ...state,
      initialized: true,
      seenIds: mergeSeenIds(currentIds, state.seenIds),
      lastCheckedAt: checkedAt,
      lastTriggeredAt: newItems.length > 0 ? checkedAt : state.lastTriggeredAt,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: checkedAt,
    };
    await this.options.store.setTriggerState(nextState);
    if (newItems.length === 0) {
      return;
    }
    for (const item of newItems) {
      const payload = await this.enrichEventItem(flow, trigger.connectionId, connection.service, item.payload, policy);
      this.launch(
        flow,
        createEvent(trigger.type, now, {
          connectionId: trigger.connectionId,
          service: connection.service,
          eventId: trigger.type === "event" ? trigger.eventId : undefined,
          detectorActionId: plan.actionId,
          items: [payload],
        }),
      );
    }
  }

  private async enrichEventItem(
    flow: FlowDefinition,
    connectionId: string,
    service: string,
    payload: unknown,
    policy: ActionPolicySnapshot,
  ): Promise<unknown> {
    const item = readRecord(payload);
    if (service !== "outlook" || item?.hasAttachments !== true || typeof item.id !== "string") {
      return payload;
    }

    const attachmentRun = await this.options.actions.run({
      actionId: "outlook.list_attachments",
      connectionId,
      input: { messageId: item.id },
      caller: "trigger",
      policy,
      flowId: flow.id,
      approvalPolicy: "bypass",
    });
    const output = attachmentRun?.result.ok ? readRecord(attachmentRun.result.output) : undefined;
    if (!Array.isArray(output?.attachments)) {
      this.options.logger?.warn(
        { flowId: flow.id, service, errorCode: attachmentRun?.result.error?.code },
        "trigger attachment metadata enrichment failed",
      );
      return payload;
    }

    return { ...item, attachments: output.attachments };
  }

  private launch(flow: FlowDefinition, event: FlowTriggerEvent): void {
    const previous = this.inFlight.get(flow.id);
    const start = (): Promise<unknown> =>
      this.options.runner.start(flow.id, { trigger: event.type, event }).catch((error: unknown) => {
        this.options.logger?.warn({ flowId: flow.id, trigger: event.type, error }, "triggered flow failed");
      });
    const running = (previous ? previous.then(start, start) : start()).finally(() => {
      if (this.inFlight.get(flow.id) === running) {
        this.inFlight.delete(flow.id);
      }
    });
    this.inFlight.set(flow.id, running);
  }

  private async readState(flow: FlowDefinition, now: Date): Promise<FlowTriggerState> {
    const state = await this.options.store.getTriggerState(flow.id);
    if (state?.flowRevision === flow.revision) {
      return state;
    }
    return {
      flowId: flow.id,
      flowRevision: flow.revision,
      initialized: false,
      seenIds: [],
      updatedAt: now.toISOString(),
    };
  }

  private async recordError(flow: FlowDefinition, now: Date, error: unknown): Promise<void> {
    const state = await this.readState(flow, now);
    const message = error instanceof Error ? error.message : "Flow trigger failed unexpectedly.";
    await this.options.store.setTriggerState({
      ...state,
      lastCheckedAt: now.toISOString(),
      errorCode: "flow_trigger_failed",
      errorMessage: message,
      updatedAt: now.toISOString(),
    });
    this.options.logger?.warn(
      { flowId: flow.id, trigger: flow.trigger.type, errorCode: "flow_trigger_failed" },
      message,
    );
  }
}

function createEvent(type: FlowTriggerEvent["type"], now: Date, payload: unknown): FlowTriggerEvent {
  return {
    type,
    occurredAt: now.toISOString(),
    payload,
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isPollDue(lastCheckedAt: string | undefined, intervalSeconds: number, now: Date): boolean {
  if (!lastCheckedAt) {
    return true;
  }
  const checkedAt = Date.parse(lastCheckedAt);
  return !Number.isFinite(checkedAt) || now.getTime() - checkedAt >= intervalSeconds * 1_000;
}

function mergeSeenIds(current: string[], previous: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of [...current, ...previous]) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
    if (merged.length === maximumSeenIds) {
      break;
    }
  }
  return merged;
}
