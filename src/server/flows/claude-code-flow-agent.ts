import type { AgentCredentialService } from "../agents/agent-credential-service.ts";
import type { IClaudeCodeClient } from "../agents/claude-code-client.ts";
import type { FlowAgentTurn, FlowAgentTurnInput, IFlowAgent } from "./flow-agent.ts";

import { AgentCredentialError } from "../agents/agent-credential-service.ts";
import { ClaudeCodeError } from "../agents/claude-code-client.ts";
import { FlowAgentError } from "./flow-agent.ts";

const decisionSchema = {
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

interface ClaudeFlowDecision {
  kind: "tool_call" | "final";
  toolName?: string;
  arguments?: Record<string, unknown>;
  text?: string;
}

/**
 * Stateless Claude Code turn adapter. Claude receives no built-in or MCP tools;
 * it returns one structured decision and the host retains execution and
 * approval authority.
 */
export class ClaudeCodeFlowAgent implements IFlowAgent {
  private readonly credentials: Pick<AgentCredentialService, "getClaudeOAuthToken">;
  private readonly claudeCode: IClaudeCodeClient;

  constructor(credentials: Pick<AgentCredentialService, "getClaudeOAuthToken">, claudeCode: IClaudeCodeClient) {
    this.credentials = credentials;
    this.claudeCode = claudeCode;
  }

  async respond(input: FlowAgentTurnInput): Promise<FlowAgentTurn> {
    try {
      const oauthToken = await this.credentials.getClaudeOAuthToken(input.flow.agent.connectionId);
      const result = await this.claudeCode.completeTurn({
        oauthToken,
        model: input.flow.agent.model,
        effort: input.flow.agent.reasoningEffort,
        systemPrompt: input.instructions,
        prompt: createTurnPrompt(input),
        outputSchema: decisionSchema,
      });
      return parseDecision(result.structuredOutput, result.usage);
    } catch (error) {
      if (error instanceof FlowAgentError) {
        throw error;
      }
      if (error instanceof ClaudeCodeError) {
        throw new FlowAgentError(error.code, error.message);
      }
      if (error instanceof AgentCredentialError) {
        throw new FlowAgentError(error.code, error.message);
      }
      throw error;
    }
  }
}

function createTurnPrompt(input: FlowAgentTurnInput): string {
  const tools = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
  return `Choose the next single action for this Flow.

Return kind "tool_call" with exactly one supplied toolName and an arguments object when another connector action is needed.
Return kind "final" with text only when the synchronization is complete or a concrete blocker remains.
Never claim an action succeeded unless its result appears in the history.

Available connector tools:
${JSON.stringify(tools)}

Completed Flow history:
${JSON.stringify(input.history)}

Current input:
${JSON.stringify(input.input)}`;
}

function parseDecision(value: unknown, usage: unknown): FlowAgentTurn {
  const decision = requiredDecision(value);
  const responseId = crypto.randomUUID();
  if (decision.kind === "tool_call") {
    if (!decision.toolName || !decision.arguments) {
      throw new FlowAgentError(
        "invalid_agent_response",
        "Claude Code returned a tool decision without a tool name and arguments.",
      );
    }
    return {
      responseId,
      functionCall: {
        callId: crypto.randomUUID(),
        name: decision.toolName,
        arguments: JSON.stringify(decision.arguments),
      },
      usage,
    };
  }
  if (!decision.text?.trim()) {
    throw new FlowAgentError("invalid_agent_response", "Claude Code returned a final decision without text.");
  }
  return {
    responseId,
    text: decision.text.trim(),
    usage,
  };
}

function requiredDecision(value: unknown): ClaudeFlowDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FlowAgentError("invalid_agent_response", "Claude Code Flow decision must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "tool_call" && record.kind !== "final") {
    throw new FlowAgentError("invalid_agent_response", "Claude Code Flow decision has an invalid kind.");
  }
  if (
    record.arguments !== undefined &&
    (!record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments))
  ) {
    throw new FlowAgentError("invalid_agent_response", "Claude Code tool arguments must be a JSON object.");
  }
  return {
    kind: record.kind,
    toolName: typeof record.toolName === "string" ? record.toolName : undefined,
    arguments: record.arguments as Record<string, unknown> | undefined,
    text: typeof record.text === "string" ? record.text : undefined,
  };
}
