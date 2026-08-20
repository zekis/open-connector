import type { FlowService } from "../flows/flow-service.ts";
import type { FlowDefinition, FlowDefinitionInput, FlowStatus } from "../flows/flow-types.ts";
import type { AgentChatExtensionTool } from "./agent-chat-service.ts";
import type { AgentChatToolActivity } from "./agent-chat-types.ts";

import { FlowError } from "../flows/flow-service.ts";
import { maximumFlowMaxSteps } from "../flows/flow-types.ts";

export interface AgentChatFlowToolOptions {
  flows: Pick<FlowService, "create" | "delete" | "getRequired" | "list" | "update">;
  agentConnectionId: string;
}

const listFlowsToolName = "list_flows";
const getFlowToolName = "get_flow";
const createFlowToolName = "create_flow";
const updateFlowToolName = "update_flow";
const setFlowStatusToolName = "set_flow_status";
const deleteFlowToolName = "delete_flow";

const flowToolNames = new Set([
  listFlowsToolName,
  getFlowToolName,
  createFlowToolName,
  updateFlowToolName,
  setFlowStatusToolName,
  deleteFlowToolName,
]);

const flowTriggerSchema = {
  oneOf: [
    objectSchema({ type: literalSchema("manual") }, ["type"]),
    objectSchema({ type: literalSchema("api") }, ["type"]),
    objectSchema(
      {
        type: literalSchema("schedule"),
        cron: { type: "string", description: "Five-field cron expression." },
        timeZone: { type: "string", description: "IANA time zone, such as Australia/Perth." },
      },
      ["type", "cron", "timeZone"],
    ),
    objectSchema(
      {
        type: literalSchema("event"),
        connectionId: { type: "string" },
        eventId: { type: "string" },
        pollIntervalSeconds: { type: "integer", minimum: 30, maximum: 86_400 },
      },
      ["type", "connectionId", "eventId", "pollIntervalSeconds"],
    ),
    objectSchema(
      {
        type: literalSchema("new_email"),
        connectionId: { type: "string" },
        pollIntervalSeconds: { type: "integer", minimum: 30, maximum: 86_400 },
        query: { type: "string" },
      },
      ["type", "connectionId", "pollIntervalSeconds"],
    ),
    objectSchema(
      {
        type: literalSchema("file_created"),
        connectionId: { type: "string" },
        pollIntervalSeconds: { type: "integer", minimum: 30, maximum: 86_400 },
        folder: { type: "string" },
        extension: { type: "string" },
      },
      ["type", "connectionId", "pollIntervalSeconds"],
    ),
  ],
};

const flowToolGrantSchema = objectSchema(
  {
    actionId: { type: "string" },
    connectionId: { type: "string" },
    role: { type: "string", enum: ["source", "destination"] },
    approval: { type: "string", enum: ["inherit", "always_allow", "require_approval"] },
  },
  ["actionId", "connectionId", "approval"],
);

const editableFlowProperties = {
  name: { type: "string", maxLength: 120 },
  status: { type: "string", enum: ["active", "paused"] },
  sourceConnectionId: { type: "string" },
  destinationConnectionId: { type: "string" },
  instructions: { type: "string", maxLength: 20_000 },
  trigger: flowTriggerSchema,
  tools: { type: "array", minItems: 1, maxItems: 32, items: flowToolGrantSchema },
  maxSteps: { type: "integer", minimum: 1, maximum: maximumFlowMaxSteps },
};

export const agentChatFlowTools: AgentChatExtensionTool[] = [
  {
    name: listFlowsToolName,
    description: "List existing OOMOL Connect Flows before creating or changing persistent automation.",
    inputSchema: objectSchema(
      { limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum Flows to return." } },
      [],
    ),
  },
  {
    name: getFlowToolName,
    description: "Get the complete persisted definition of one OOMOL Connect Flow.",
    inputSchema: objectSchema({ flowId: { type: "string" } }, ["flowId"]),
  },
  {
    name: createFlowToolName,
    description:
      "Create an OOMOL Connect Flow. Scheduling is supplied by OOMOL Connect through trigger.type schedule; it is not a connected-app action. Active Flows require explicit user authorization.",
    inputSchema: objectSchema(
      {
        ...editableFlowProperties,
        userConfirmedActivation: {
          type: "boolean",
          description:
            "True only when the latest user message explicitly authorizes creating this exact active persistent automation. A direct request to create and run a recurring Flow counts as confirmation.",
        },
      },
      [
        "name",
        "status",
        "sourceConnectionId",
        "destinationConnectionId",
        "instructions",
        "trigger",
        "tools",
        "userConfirmedActivation",
      ],
    ),
  },
  {
    name: updateFlowToolName,
    description:
      "Patch one OOMOL Connect Flow definition. Read the Flow first. Changing an active Flow or activating a Flow requires explicit user authorization.",
    inputSchema: objectSchema(
      {
        flowId: { type: "string" },
        changes: objectSchema(editableFlowProperties, [], 1),
        userConfirmedChange: {
          type: "boolean",
          description:
            "True only when the latest user message explicitly authorizes this exact change to active persistent automation.",
        },
      },
      ["flowId", "changes", "userConfirmedChange"],
    ),
  },
  {
    name: setFlowStatusToolName,
    description: "Activate or pause one OOMOL Connect Flow without changing its other fields.",
    inputSchema: objectSchema(
      {
        flowId: { type: "string" },
        status: { type: "string", enum: ["active", "paused"] },
        userConfirmedActivation: {
          type: "boolean",
          description: "True only when the latest user message explicitly authorizes activating this Flow.",
        },
      },
      ["flowId", "status", "userConfirmedActivation"],
    ),
  },
  {
    name: deleteFlowToolName,
    description: "Permanently delete one OOMOL Connect Flow after explicit user authorization.",
    inputSchema: objectSchema(
      {
        flowId: { type: "string" },
        userConfirmedDeletion: {
          type: "boolean",
          description: "True only when the latest user message explicitly authorizes deleting this exact Flow.",
        },
      },
      ["flowId", "userConfirmedDeletion"],
    ),
  },
];

export function isAgentChatFlowTool(toolName: string): boolean {
  return flowToolNames.has(toolName);
}

export async function runAgentChatFlowTool(
  toolName: string,
  input: Record<string, unknown>,
  options: AgentChatFlowToolOptions,
): Promise<AgentChatToolActivity | undefined> {
  if (!isAgentChatFlowTool(toolName)) return undefined;

  try {
    if (toolName === listFlowsToolName) return await listFlows(input, options);
    if (toolName === getFlowToolName) return await getFlow(input, options);
    if (toolName === createFlowToolName) return await createFlow(input, options);
    if (toolName === updateFlowToolName) return await updateFlow(input, options);
    if (toolName === setFlowStatusToolName) return await setFlowStatus(input, options);
    return await deleteFlow(input, options);
  } catch (error) {
    if (error instanceof FlowError || error instanceof AgentChatFlowToolError) {
      return failedFlowActivity(toolName, input, error.code, error.message);
    }
    throw error;
  }
}

async function listFlows(
  input: Record<string, unknown>,
  options: AgentChatFlowToolOptions,
): Promise<AgentChatToolActivity> {
  const limit = readOptionalInteger(input.limit, "limit", 1, 100) ?? 50;
  const allFlows = (await options.flows.list()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const flows = allFlows.slice(0, limit).map((flow) => ({
    id: flow.id,
    name: flow.name,
    status: flow.status,
    sourceConnectionId: flow.sourceConnectionId,
    destinationConnectionId: flow.destinationConnectionId,
    trigger: flow.trigger,
    updatedAt: flow.updatedAt,
  }));
  return completedFlowActivity(toolNameLabel(listFlowsToolName), input, {
    flows,
    total: allFlows.length,
    truncated: allFlows.length > flows.length,
  });
}

async function getFlow(
  input: Record<string, unknown>,
  options: AgentChatFlowToolOptions,
): Promise<AgentChatToolActivity> {
  const flowId = readRequiredText(input.flowId, "flowId");
  const flow = await options.flows.getRequired(flowId);
  return completedFlowActivity(toolNameLabel(getFlowToolName), input, { flow });
}

async function createFlow(
  input: Record<string, unknown>,
  options: AgentChatFlowToolOptions,
): Promise<AgentChatToolActivity> {
  const status = readFlowStatus(input.status);
  if (status === "active" && input.userConfirmedActivation !== true) {
    return confirmationRequired(
      createFlowToolName,
      input,
      "Explicit user confirmation is required before creating an active Flow.",
    );
  }
  const flow = await options.flows.create({
    ...readFlowFields(input),
    status,
    agent: { connectionId: options.agentConnectionId },
  });
  return completedFlowActivity(toolNameLabel(createFlowToolName), input, { flow });
}

async function updateFlow(
  input: Record<string, unknown>,
  options: AgentChatFlowToolOptions,
): Promise<AgentChatToolActivity> {
  const flowId = readRequiredText(input.flowId, "flowId");
  const changes = readRequiredObject(input.changes, "changes");
  if (Object.keys(changes).length === 0) {
    throw new AgentChatFlowToolError("flow_changes_required", "changes must contain at least one Flow field.");
  }
  const current = await options.flows.getRequired(flowId);
  const nextStatus = changes.status === undefined ? current.status : readFlowStatus(changes.status);
  if ((current.status === "active" || nextStatus === "active") && input.userConfirmedChange !== true) {
    return confirmationRequired(
      updateFlowToolName,
      input,
      "Explicit user confirmation is required before changing active persistent automation.",
    );
  }
  const flow = await options.flows.update(flowId, mergeFlowInput(current, changes));
  return completedFlowActivity(toolNameLabel(updateFlowToolName), input, { flow });
}

async function setFlowStatus(
  input: Record<string, unknown>,
  options: AgentChatFlowToolOptions,
): Promise<AgentChatToolActivity> {
  const flowId = readRequiredText(input.flowId, "flowId");
  const status = readFlowStatus(input.status);
  if (status === "active" && input.userConfirmedActivation !== true) {
    return confirmationRequired(
      setFlowStatusToolName,
      input,
      "Explicit user confirmation is required before activating a Flow.",
    );
  }
  const current = await options.flows.getRequired(flowId);
  const flow = await options.flows.update(flowId, mergeFlowInput(current, { status }));
  return completedFlowActivity(toolNameLabel(setFlowStatusToolName), input, { flow });
}

async function deleteFlow(
  input: Record<string, unknown>,
  options: AgentChatFlowToolOptions,
): Promise<AgentChatToolActivity> {
  const flowId = readRequiredText(input.flowId, "flowId");
  if (input.userConfirmedDeletion !== true) {
    return confirmationRequired(
      deleteFlowToolName,
      input,
      "Explicit user confirmation is required before deleting a Flow.",
    );
  }
  await options.flows.getRequired(flowId);
  await options.flows.delete(flowId);
  return completedFlowActivity(toolNameLabel(deleteFlowToolName), input, { id: flowId, deleted: true });
}

function readFlowFields(input: Record<string, unknown>): Omit<FlowDefinitionInput, "agent" | "status"> {
  return {
    name: input.name as string,
    sourceConnectionId: input.sourceConnectionId as string,
    destinationConnectionId: input.destinationConnectionId as string,
    instructions: input.instructions as string,
    trigger: input.trigger as FlowDefinitionInput["trigger"],
    tools: input.tools as FlowDefinitionInput["tools"],
    maxSteps: input.maxSteps as number | undefined,
  };
}

function mergeFlowInput(current: FlowDefinition, changes: Record<string, unknown>): FlowDefinitionInput {
  return {
    name: changedValue(changes, "name", current.name) as string,
    status: changedValue(changes, "status", current.status) as FlowStatus,
    sourceConnectionId: changedValue(changes, "sourceConnectionId", current.sourceConnectionId) as string,
    destinationConnectionId: changedValue(
      changes,
      "destinationConnectionId",
      current.destinationConnectionId,
    ) as string,
    instructions: changedValue(changes, "instructions", current.instructions) as string,
    trigger: changedValue(changes, "trigger", current.trigger) as FlowDefinitionInput["trigger"],
    agent: {
      provider: current.agent.provider,
      connectionId: current.agent.connectionId,
      reasoningEffort: current.agent.reasoningEffort,
    },
    tools: changedValue(changes, "tools", current.tools) as FlowDefinitionInput["tools"],
    maxSteps: changedValue(changes, "maxSteps", current.maxSteps) as number,
  };
}

function changedValue(changes: Record<string, unknown>, key: string, current: unknown): unknown {
  return Object.hasOwn(changes, key) ? changes[key] : current;
}

function readFlowStatus(value: unknown): FlowStatus {
  if (value === "active" || value === "paused") return value;
  throw new AgentChatFlowToolError("invalid_flow", "status must be active or paused.");
}

function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentChatFlowToolError("invalid_flow_tool_input", `${field} is required.`);
  }
  return value.trim();
}

function readRequiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentChatFlowToolError("invalid_flow_tool_input", `${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function readOptionalInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AgentChatFlowToolError(
      "invalid_flow_tool_input",
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value as number;
}

function confirmationRequired(
  toolName: string,
  input: Record<string, unknown>,
  message: string,
): AgentChatToolActivity {
  return failedFlowActivity(toolName, input, "flow_confirmation_required", message);
}

function completedFlowActivity(label: string, input: Record<string, unknown>, output: unknown): AgentChatToolActivity {
  return {
    id: crypto.randomUUID(),
    type: "action",
    label,
    ok: true,
    input,
    output,
  };
}

function failedFlowActivity(
  toolName: string,
  input: Record<string, unknown>,
  code: string,
  message: string,
): AgentChatToolActivity {
  return {
    id: crypto.randomUUID(),
    type: "action",
    label: toolNameLabel(toolName),
    ok: false,
    input,
    output: { error: { code, message } },
  };
}

function toolNameLabel(toolName: string): string {
  const words = toolName.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function literalSchema(value: string): Record<string, unknown> {
  return { type: "string", const: value };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
  minProperties?: number,
): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
  if (minProperties !== undefined) schema.minProperties = minProperties;
  return schema;
}

class AgentChatFlowToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
