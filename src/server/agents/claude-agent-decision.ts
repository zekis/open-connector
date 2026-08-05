import type { JsonSchema } from "../../core/types.ts";

export const claudeAgentDecisionSchema: JsonSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["tool_call", "final"],
    },
    toolName: {
      type: "string",
    },
    arguments: {
      type: "object",
      additionalProperties: true,
    },
    text: {
      type: "string",
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

export interface ClaudeAgentDecision {
  kind: "tool_call" | "final";
  toolName?: string;
  arguments?: Record<string, unknown>;
  text?: string;
}

export class ClaudeAgentDecisionError extends Error {
  readonly code = "invalid_agent_response";
}

/** Read the shared structured decision returned by tool-using Claude agents. */
export function readClaudeAgentDecision(value: unknown): ClaudeAgentDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeAgentDecisionError("Claude Code agent decision must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "tool_call" && record.kind !== "final") {
    throw new ClaudeAgentDecisionError("Claude Code agent decision has an invalid kind.");
  }
  if (
    record.arguments !== undefined &&
    (!record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments))
  ) {
    throw new ClaudeAgentDecisionError("Claude Code tool arguments must be a JSON object.");
  }
  return {
    kind: record.kind,
    toolName: typeof record.toolName === "string" ? record.toolName : undefined,
    arguments: record.arguments as Record<string, unknown> | undefined,
    text: typeof record.text === "string" ? record.text : undefined,
  };
}
