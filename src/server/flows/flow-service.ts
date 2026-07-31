import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { AgentCredentialService } from "../agents/agent-credential-service.ts";
import type { AgentSettingsService } from "../agents/agent-settings-service.ts";
import type {
  FlowApprovalMode,
  FlowDefinition,
  FlowReasoningEffort,
  FlowStatus,
  FlowToolGrant,
  IFlowStore,
} from "./flow-types.ts";

import { defaultAgentModel } from "../agents/agent-settings-service.ts";

const defaultReasoningEffort: FlowReasoningEffort = "medium";
const defaultMaxSteps = 8;

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

  list(): Promise<FlowDefinition[]> {
    return this.options.store.listFlows();
  }

  get(id: string): Promise<FlowDefinition | undefined> {
    return this.options.store.getFlow(id);
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
    return {
      name,
      status: readStatus(value.status),
      sourceConnectionId,
      destinationConnectionId,
      instructions,
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

function readApprovalMode(value: unknown, index: number): FlowApprovalMode {
  if (value === "always_allow" || value === "require_approval") {
    return value;
  }
  throw new FlowError("invalid_flow", `tools[${index}].approval must be always_allow or require_approval.`);
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
    return defaultMaxSteps;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 20) {
    throw new FlowError("invalid_flow", "maxSteps must be an integer between 1 and 20.");
  }
  return value as number;
}
