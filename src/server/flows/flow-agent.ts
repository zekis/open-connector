import type { ActionPolicySnapshot } from "../../core/action-policy.ts";
import type { JsonSchema } from "../../core/types.ts";
import type { FlowDefinition } from "./flow-types.ts";

export interface FlowAgentTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface FlowAgentFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface FlowAgentTurn {
  responseId: string;
  text?: string;
  functionCall?: FlowAgentFunctionCall;
  usage?: unknown;
}

export interface FlowAgentHistoryItem {
  kind: "agent" | "action";
  actionId?: string;
  connectionId?: string;
  input?: unknown;
  output?: unknown;
}

export interface FlowAgentToolResult {
  type: "flow_tool_result";
  call: FlowAgentFunctionCall;
  result: unknown;
}

export interface FlowAgentTurnInput {
  flow: FlowDefinition;
  runId: string;
  stepId: string;
  instructions: string;
  tools: FlowAgentTool[];
  history: FlowAgentHistoryItem[];
  input: unknown;
  previousResponseId?: string;
  policy: ActionPolicySnapshot;
}

export interface IFlowAgent {
  respond(input: FlowAgentTurnInput): Promise<FlowAgentTurn>;
}

export class FlowAgentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function isFlowAgentToolResult(value: unknown): value is FlowAgentToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (value as { type?: unknown }).type === "flow_tool_result";
}
