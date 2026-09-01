import type { JsonSchema } from "../../core/types.ts";

export interface AgentTurnRequest {
  model: string;
  effort: "none" | "low" | "medium" | "high";
  systemPrompt: string;
  prompt: string;
  outputSchema: JsonSchema;
  attachments?: AgentTurnAttachment[];
  signal?: AbortSignal;
}

export interface AgentTurnAttachment {
  id: string;
  file: File;
}

export interface AgentTurnResult {
  structuredOutput: unknown;
  usage?: unknown;
}

export interface IAgentTurnClient {
  completeTurn(input: AgentTurnRequest): Promise<AgentTurnResult>;
}
