import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { AgentCredentialService } from "../agents/agent-credential-service.ts";
import type { AgentSettingsService } from "../agents/agent-settings-service.ts";
import type { SynapseService } from "../synapse/synapse-service.ts";
import type {
  FlowApprovalSetting,
  FlowConnectionRole,
  FlowDefinition,
  FlowReasoningEffort,
  FlowStatus,
  FlowTrigger,
  FlowTriggerBinding,
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
  synapses?: Pick<SynapseService, "create" | "get">;
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
      destinationConnectionId: normalized.destinationConnectionId,
      destinationSynapseId: normalized.destinationSynapseId,
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

  async listTriggers(): Promise<FlowTriggerBinding[]> {
    return (await this.list()).flatMap((flow) =>
      flow.trigger.type === "manual"
        ? []
        : [
            {
              flowId: flow.id,
              flowName: flow.name,
              flowStatus: flow.status,
              trigger: flow.trigger,
              updatedAt: flow.updatedAt,
            },
          ],
    );
  }

  async updateTrigger(id: string, input: unknown): Promise<FlowDefinition> {
    const current = await this.getRequired(id);
    const connections = await this.connectionMap();
    const source = requiredConnection(connections, current.sourceConnectionId, "sourceConnectionId");
    const trigger = this.normalizeTrigger(input, source);
    const flow: FlowDefinition = {
      ...current,
      trigger,
      revision: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    await this.options.store.setFlow(flow);
    return flow;
  }

  async removeTrigger(id: string): Promise<FlowDefinition> {
    return await this.updateTrigger(id, { type: "manual" });
  }

  private async normalizeInput(
    input: unknown,
  ): Promise<Omit<FlowDefinition, "id" | "revision" | "createdAt" | "updatedAt">> {
    const value = requiredObject(input, "Flow request body");
    const name = requiredText(value.name, "name", 120);
    const instructions = requiredText(value.instructions, "instructions", 20_000);
    const sourceConnectionId = requiredText(value.sourceConnectionId, "sourceConnectionId", 200);
    const destinationConnectionId = optionalText(value.destinationConnectionId, "destinationConnectionId", 200);
    const requestedSynapseId = optionalText(value.destinationSynapseId, "destinationSynapseId", 200);
    const destinationSynapseName = optionalText(value.destinationSynapseName, "destinationSynapseName", 120);
    if ([destinationConnectionId, requestedSynapseId, destinationSynapseName].filter(Boolean).length !== 1) {
      throw new FlowError(
        "invalid_flow",
        "Set exactly one of destinationConnectionId, destinationSynapseId, or destinationSynapseName.",
      );
    }
    const connections = await this.connectionMap();
    const source = requiredConnection(connections, sourceConnectionId, "sourceConnectionId");
    const destination = destinationConnectionId
      ? requiredConnection(connections, destinationConnectionId, "destinationConnectionId")
      : undefined;
    const agentInput = requiredObject(value.agent, "agent");
    const agentProvider = readAgentProvider(agentInput.provider);
    const agentConnectionId = requiredText(agentInput.connectionId, "agent.connectionId", 200);
    if (!(await this.options.agents?.getSummaryById(agentConnectionId))) {
      throw new FlowError("invalid_flow", "The Claude Code flow agent must use a configured subscription connection.");
    }
    const agentModel = (await this.options.agentSettings?.get(agentProvider))?.model ?? defaultAgentModel();

    const tools = this.normalizeTools(value.tools, connections, source, destination);
    const trigger = this.normalizeTrigger(value.trigger, source);
    const destinationSynapseId = await this.resolveDestinationSynapse(requestedSynapseId, destinationSynapseName);
    return {
      name,
      status: readStatus(value.status),
      sourceConnectionId,
      ...(destinationConnectionId ? { destinationConnectionId } : {}),
      ...(destinationSynapseId ? { destinationSynapseId } : {}),
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
    if (value.type === "event") {
      const connectionId = requiredText(value.connectionId, "trigger.connectionId", 200);
      if (connectionId !== source.id) {
        throw new FlowError("invalid_flow", "Provider-event triggers must use the Flow source connection.");
      }
      const eventId = requiredText(value.eventId, "trigger.eventId", 200);
      const pollIntervalSeconds = readPollInterval(value.pollIntervalSeconds);
      const trigger: FlowTrigger = { type: "event", connectionId, eventId, pollIntervalSeconds };
      const provider = this.options.catalog.providers.find((candidate) => candidate.service === source.service);
      if (!provider || !supportsConnectionFlowTrigger(trigger, provider)) {
        throw new FlowError("invalid_flow", `${source.service} does not declare the ${eventId} event.`);
      }
      const action = this.options.catalog.actionsById.get(createFlowPollPlan(trigger, provider).actionId);
      if (!action || action.service !== source.service) {
        throw new FlowError("invalid_flow", `${eventId} does not use an action owned by ${source.service}.`);
      }
      if (!action.execution.locallyExecutable) {
        throw new FlowError("invalid_flow", `${source.service} event detection is not executable in this runtime.`);
      }
      return trigger;
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
    throw new FlowError(
      "invalid_flow",
      "trigger.type must be manual, api, schedule, event, new_email, or file_created.",
    );
  }

  private normalizeTools(
    input: unknown,
    connections: Map<string, ConnectionSummary>,
    source: ConnectionSummary,
    destination: ConnectionSummary | undefined,
  ): FlowToolGrant[] {
    if (!Array.isArray(input) || input.length === 0) {
      throw new FlowError("invalid_flow", "tools must contain at least one tool grant.");
    }
    if (input.length > 32) {
      throw new FlowError("invalid_flow", "tools must not contain more than 32 tool grants.");
    }

    const keys = new Set<string>();
    return input.map((item, index) => {
      const value = requiredObject(item, `tools[${index}]`);
      const actionId = requiredText(value.actionId, `tools[${index}].actionId`, 200);
      const connectionId = requiredText(value.connectionId, `tools[${index}].connectionId`, 200);
      const role = readToolRole(value.role, connectionId, source, destination, index);
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
      const endpoint = role === "source" ? source : destination;
      if (!endpoint) {
        throw new FlowError("invalid_flow", "Synapse destination Flows can grant source connector tools only.");
      }
      if (connectionId !== endpoint.id) {
        throw new FlowError("invalid_flow", `Tool ${actionId} does not use the Flow ${role} connection.`);
      }
      const connection = requiredConnection(connections, connectionId, `tools[${index}].connectionId`);
      if (connection.service !== action.service) {
        throw new FlowError("invalid_flow", `Tool ${actionId} cannot use a ${connection.service} connection.`);
      }
      const key = `${role}\0${actionId}\0${connectionId}`;
      if (keys.has(key)) {
        throw new FlowError("invalid_flow", `Duplicate tool grant: ${actionId} on ${connectionId}.`);
      }
      keys.add(key);
      return { actionId, connectionId, role, approval };
    });
  }

  private async connectionMap(): Promise<Map<string, ConnectionSummary>> {
    return new Map((await this.options.connections.listConnections()).map((connection) => [connection.id, connection]));
  }

  private async resolveDestinationSynapse(
    requestedId: string | undefined,
    requestedName: string | undefined,
  ): Promise<string | undefined> {
    if (!requestedId && !requestedName) return undefined;
    if (!this.options.synapses) {
      throw new FlowError("invalid_flow", "Synapse canvas destinations are unavailable in this runtime.");
    }
    if (requestedId) {
      try {
        return (await this.options.synapses.get(requestedId)).id;
      } catch {
        throw new FlowError("invalid_flow", `Synapse canvas not found: ${requestedId}.`);
      }
    }
    return (await this.options.synapses.create({ name: requestedName })).id;
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

function readToolRole(
  value: unknown,
  connectionId: string,
  source: ConnectionSummary,
  destination: ConnectionSummary | undefined,
  index: number,
): FlowConnectionRole {
  if (value === "source" || value === "destination") {
    return value;
  }
  if (value !== undefined) {
    throw new FlowError("invalid_flow", `tools[${index}].role must be source or destination.`);
  }
  if (!destination) {
    if (connectionId === source.id) return "source";
    throw new FlowError("invalid_flow", `tools[${index}] must use the source connection for a Synapse destination.`);
  }
  if (source.id === destination.id) {
    throw new FlowError(
      "invalid_flow",
      `tools[${index}].role is required when the source and destination use the same connection.`,
    );
  }
  return connectionId === source.id ? "source" : "destination";
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
  const normalized = flow.trigger ? flow : { ...flow, trigger: { type: "manual" as const } };
  return {
    ...normalized,
    tools: normalized.tools.map((tool) => ({
      ...tool,
      role: tool.role ?? (tool.connectionId === normalized.sourceConnectionId ? "source" : "destination"),
    })),
  };
}
