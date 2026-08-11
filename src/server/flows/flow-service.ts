import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { AgentCredentialService } from "../agents/agent-credential-service.ts";
import type { AgentSettingsService } from "../agents/agent-settings-service.ts";
import type {
  FlowApprovalSetting,
  FlowDefinition,
  FlowReasoningEffort,
  FlowStatus,
  FlowTrigger,
  FlowToolGrant,
  IFlowStore,
} from "./flow-types.ts";

import { defaultAgentModel } from "../agents/agent-settings-service.ts";
import { validateCronExpression, validateTimeZone } from "./cron-schedule.ts";
import { createFlowPollPlan, supportsConnectionFlowTrigger } from "./flow-trigger-adapters.ts";
import { defaultFlowMaxSteps, maximumFlowMaxSteps } from "./flow-types.ts";

const defaultReasoningEffort: FlowReasoningEffort = "medium";

export interface FlowServiceOptions {
  catalog: CatalogStore;
  connections: Pick<ConnectionService, "listConnections">;
  agents?: Pick<AgentCredentialService, "getSummaryById">;
  agentSettings?: Pick<AgentSettingsService, "get">;
  store: IFlowStore;
}

/**
 * Validates and persists directional flow definitions.
 */
export class FlowService {
  private readonly options: FlowServiceOptions;

  constructor(options: FlowServiceOptions) {
    this.options = options;
  }

  async create(input: unknown): Promise<FlowDefinition> {
    const normalized = await this.normalizeInput(input);
    const now = new Date().toISOString();
    const flow: FlowDefinition = {
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      ...normalized,
      createdAt: now,
      updatedAt: now,
    };
    await this.options.store.setFlow(flow);
    return flow;
  }

  async update(id: string, input: unknown): Promise<FlowDefinition> {
    const current = await this.getRequired(id);
    const normalized = await this.normalizeInput(input);
    const flow: FlowDefinition = {
      ...current,
      ...normalized,
      revision: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    await this.options.store.setFlow(flow);
    return flow;
  }

  async list(): Promise<FlowDefinition[]> {
    return (await this.options.store.listFlows()).map(normalizeStoredFlow);
  }

  async get(id: string): Promise<FlowDefinition | undefined> {
    const flow = await this.options.store.getFlow(id);
    return flow ? normalizeStoredFlow(flow) : undefined;
  }

  async getRequired(id: string): Promise<FlowDefinition> {
    const flow = await this.get(id);
    if (!flow) {
      throw new FlowError("flow_not_found", `Flow not found: ${id}.`, 404);
    }
    return flow;
  }

  async delete(id: string): Promise<void> {
    if (!(await this.options.store.deleteFlow(id))) {
      throw new FlowError("flow_not_found", `Flow not found: ${id}.`, 404);
    }
  }

  private async normalizeInput(
    input: unknown,
  ): Promise<Omit<FlowDefinition, "id" | "revision" | "createdAt" | "updatedAt">> {
    const value = requiredObject(input, "Flow request body");
    const name = requiredText(value.name, "name", 120);
    const instructions = requiredText(value.instructions, "instructions", 20_000);
    const sourceConnectionId = requiredText(value.sourceConnectionId, "sourceConnectionId", 200);
    const destinationConnectionId = requiredText(value.destinationConnectionId, "destinationConnectionId", 200);
    if (sourceConnectionId === destinationConnectionId) {
      throw new FlowError(
        "invalid_flow",
        "sourceConnectionId and destinationConnectionId must identify different connections.",
      );
    }

    const connections = await this.connectionMap();
    const source = requiredConnection(connections, sourceConnectionId, "sourceConnectionId");
    const destination = requiredConnection(connections, destinationConnectionId, "destinationConnectionId");
    const agentInput = requiredObject(value.agent, "agent");
    const agentProvider = readAgentProvider(agentInput.provider);
    const agentConnectionId = requiredText(agentInput.connectionId, "agent.connectionId", 200);
    if (!(await this.options.agents?.getSummaryById(agentConnectionId))) {
      throw new FlowError("invalid_flow", "The Claude Code flow agent must use a configured subscription connection.");
    }
    const agentModel = (await this.options.agentSettings?.get(agentProvider))?.model ?? defaultAgentModel();

    const tools = this.normalizeTools(value.tools, connections, source, destination);
    const trigger = this.normalizeTrigger(value.trigger, source);
    return {
      name,
      status: readStatus(value.status),
      sourceConnectionId,
      destinationConnectionId,
      instructions,
      trigger,
      agent: {
        provider: agentProvider,
        connectionId: agentConnectionId,
        model: agentModel,
        reasoningEffort: readReasoningEffort(agentInput.reasoningEffort),
      },
      tools,
      maxSteps: readMaxSteps(value.maxSteps),
    };
  }

  private normalizeTrigger(input: unknown, source: ConnectionSummary): FlowTrigger {
    if (input === undefined) {
      return { type: "manual" };
    }
    const value = requiredObject(input, "trigger");
    if (value.type === "manual" || value.type === "api") {
      return { type: value.type };
    }
    if (value.type === "schedule") {
      const cron = requiredText(value.cron, "trigger.cron", 120);
      const timeZone = requiredText(value.timeZone, "trigger.timeZone", 100);
      try {
        validateCronExpression(cron);
        validateTimeZone(timeZone);
      } catch (error) {
        throw new FlowError("invalid_flow", error instanceof Error ? error.message : "Invalid Flow schedule.");
      }
      return { type: "schedule", cron, timeZone };
    }
    if (value.type === "new_email" || value.type === "file_created") {
      const connectionId = requiredText(value.connectionId, "trigger.connectionId", 200);
      if (connectionId !== source.id) {
        throw new FlowError("invalid_flow", "Connection-event triggers must use the Flow source connection.");
      }
      const pollIntervalSeconds = readPollInterval(value.pollIntervalSeconds);
      const trigger: FlowTrigger =
        value.type === "new_email"
          ? {
              type: "new_email",
              connectionId,
              pollIntervalSeconds,
              query: optionalText(value.query, "trigger.query", 2_000),
            }
          : {
              type: "file_created",
              connectionId,
              pollIntervalSeconds,
              folder: optionalText(value.folder, "trigger.folder", 1_000),
              extension: optionalText(value.extension, "trigger.extension", 100),
            };
      if (!supportsConnectionFlowTrigger(trigger, source.service)) {
        throw new FlowError("invalid_flow", `${source.service} does not support ${trigger.type} Flow triggers.`);
      }
      const action = this.options.catalog.actionsById.get(createFlowPollPlan(trigger, source.service).actionId);
      if (!action?.execution.locallyExecutable) {
        throw new FlowError("invalid_flow", `${source.service} event detection is not executable in this runtime.`);
      }
      return trigger;
    }
    throw new FlowError("invalid_flow", "trigger.type must be manual, api, schedule, new_email, or file_created.");
  }

  private normalizeTools(
    input: unknown,
    connections: Map<string, ConnectionSummary>,
    source: ConnectionSummary,
    destination: ConnectionSummary,
  ): FlowToolGrant[] {
    if (!Array.isArray(input) || input.length === 0) {
      throw new FlowError("invalid_flow", "tools must contain at least one tool grant.");
    }
    if (input.length > 32) {
      throw new FlowError("invalid_flow", "tools must not contain more than 32 tool grants.");
    }

    const endpointIds = new Set([source.id, destination.id]);
    const keys = new Set<string>();
    return input.map((item, index) => {
      const value = requiredObject(item, `tools[${index}]`);
      const actionId = requiredText(value.actionId, `tools[${index}].actionId`, 200);
      const connectionId = requiredText(value.connectionId, `tools[${index}].connectionId`, 200);
      const approval = readApprovalMode(value.approval, index);
      const action = this.options.catalog.actionsById.get(actionId);
      if (!action) {
        throw new FlowError("invalid_flow", `Unknown action: ${actionId}.`);
      }
      if (!action.execution.locallyExecutable) {
        throw new FlowError("invalid_flow", `Action is not executable in this runtime: ${actionId}.`);
      }
      if (action.inputSchema.type !== "object") {
        throw new FlowError("invalid_flow", `Action does not expose an object input schema: ${actionId}.`);
      }
      if (!endpointIds.has(connectionId)) {
        throw new FlowError("invalid_flow", `Tool ${actionId} must use the source or destination connection.`);
      }
      const connection = requiredConnection(connections, connectionId, `tools[${index}].connectionId`);
      if (connection.service !== action.service) {
        throw new FlowError("invalid_flow", `Tool ${actionId} cannot use a ${connection.service} connection.`);
      }
      const key = `${actionId}\0${connectionId}`;
      if (keys.has(key)) {
        throw new FlowError("invalid_flow", `Duplicate tool grant: ${actionId} on ${connectionId}.`);
      }
      keys.add(key);
      return { actionId, connectionId, approval };
    });
  }

  private async connectionMap(): Promise<Map<string, ConnectionSummary>> {
    return new Map((await this.options.connections.listConnections()).map((connection) => [connection.id, connection]));
  }
}

export class FlowError extends Error {
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
    throw new FlowError("invalid_flow", `${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FlowError("invalid_flow", `${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new FlowError("invalid_flow", `${field} must not exceed ${maxLength} characters.`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  return value === undefined || value === "" ? undefined : requiredText(value, field, maxLength);
}

function requiredConnection(connections: Map<string, ConnectionSummary>, id: string, field: string): ConnectionSummary {
  const connection = connections.get(id);
  if (!connection) {
    throw new FlowError("invalid_flow", `${field} does not identify an available connection.`);
  }
  return connection;
}

function readStatus(value: unknown): FlowStatus {
  if (value === undefined || value === "active") {
    return "active";
  }
  if (value === "paused") {
    return value;
  }
  throw new FlowError("invalid_flow", "status must be active or paused.");
}

function readApprovalMode(value: unknown, index: number): FlowApprovalSetting {
  if (value === "always_allow" || value === "require_approval" || value === "inherit") {
    return value;
  }
  throw new FlowError("invalid_flow", `tools[${index}].approval must be inherit, always_allow, or require_approval.`);
}

function readReasoningEffort(value: unknown): FlowReasoningEffort {
  if (value === undefined) {
    return defaultReasoningEffort;
  }
  if (value === "none" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new FlowError("invalid_flow", "agent.reasoningEffort must be none, low, medium, or high.");
}

function readAgentProvider(value: unknown): "claude_code" {
  if (value === undefined || value === "claude_code") {
    return "claude_code";
  }
  throw new FlowError("invalid_flow", "agent.provider must be claude_code.");
}

function readMaxSteps(value: unknown): number {
  if (value === undefined) {
    return defaultFlowMaxSteps;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximumFlowMaxSteps) {
    throw new FlowError("invalid_flow", `maxSteps must be an integer between 1 and ${maximumFlowMaxSteps}.`);
  }
  return value as number;
}

function readPollInterval(value: unknown): number {
  if (value === undefined) {
    return 60;
  }
  if (!Number.isInteger(value) || (value as number) < 30 || (value as number) > 86_400) {
    throw new FlowError("invalid_flow", "trigger.pollIntervalSeconds must be between 30 and 86400.");
  }
  return value as number;
}

function normalizeStoredFlow(flow: FlowDefinition): FlowDefinition {
  return flow.trigger ? flow : { ...flow, trigger: { type: "manual" } };
}
