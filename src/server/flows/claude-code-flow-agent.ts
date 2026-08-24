import type { JsonSchema } from "../../core/types.ts";
import type { AgentCredentialService } from "../agents/agent-credential-service.ts";
import type { IClaudeCodeClient } from "../agents/claude-code-client.ts";
import type { FlowAgentTurn, FlowAgentTurnInput, IFlowAgent } from "./flow-agent.ts";
import type { FlowFeedImageMotif, FlowFeedImagePalette, FlowFeedPost } from "./flow-types.ts";

import { AgentCredentialError } from "../agents/agent-credential-service.ts";
import { ClaudeAgentDecisionError, readClaudeAgentDecision } from "../agents/claude-agent-decision.ts";
import { ClaudeCodeError } from "../agents/claude-code-client.ts";
import { FlowAgentError } from "./flow-agent.ts";

const feedImageMotifs: FlowFeedImageMotif[] = [
  "automation",
  "calendar",
  "chart",
  "document",
  "files",
  "message",
  "people",
  "success",
  "warning",
];
const feedImagePalettes: FlowFeedImagePalette[] = ["amber", "blue", "rose", "slate", "teal", "violet"];
const flowAgentDecisionSchema: JsonSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["tool_call", "final"] },
    toolName: { type: "string" },
    arguments: { type: "object", additionalProperties: true },
    text: { type: "string" },
    feedPost: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 280 },
        image: {
          type: "object",
          properties: {
            alt: { type: "string", maxLength: 180 },
            headline: { type: "string", maxLength: 64 },
            motif: { type: "string", enum: feedImageMotifs },
            palette: { type: "string", enum: feedImagePalettes },
          },
          required: ["alt", "headline", "motif", "palette"],
          additionalProperties: false,
        },
      },
      required: ["text", "image"],
      additionalProperties: false,
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

/**
 * Stateless Claude Code turn adapter. Claude receives no connector or mutation
 * tools; oversized prompts may use read-only access to an isolated temporary
 * file. Claude returns one structured decision and the host retains execution
 * and approval authority.
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
        outputSchema: flowAgentDecisionSchema,
      });
      return parseDecision(result.structuredOutput, result.usage);
    } catch (error) {
      if (error instanceof FlowAgentError) {
        throw error;
      }
      if (error instanceof ClaudeAgentDecisionError) {
        throw new FlowAgentError(error.code, error.message);
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
Return kind "final" with factual text and feedPost when the synchronization is complete or a concrete blocker remains.
Never claim an action succeeded unless its result appears in the history.

Feed post rules:
- write feedPost.text as one or two natural sentences of at most 240 characters
- sound like a trusted work colleague sharing an update, not a formal report or literal API summary
- lead with the useful outcome, change, or blocker; omit raw ids, headings, tables, and boilerplate
- use contractions where natural and at most one fitting emoji
- make feedPost.image a related editorial illustration brief, with a punchy headline of no more than six words
- choose the closest supplied motif and palette; make alt describe the visual rather than repeat the post

Available connector tools:
${JSON.stringify(tools)}

Completed Flow history:
${JSON.stringify(input.history)}

Current input:
${JSON.stringify(input.input)}`;
}

function parseDecision(value: unknown, usage: unknown): FlowAgentTurn {
  const decision = readClaudeAgentDecision(value);
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
    feedPost: readFeedPost(value),
    usage,
  };
}

function readFeedPost(value: unknown): FlowFeedPost | undefined {
  const feedPost = record(record(value)?.feedPost);
  const image = record(feedPost?.image);
  const text = textField(feedPost, "text");
  const alt = textField(image, "alt");
  const headline = textField(image, "headline");
  const motif = image?.motif;
  const palette = image?.palette;
  if (!text || !alt || !headline || !isFeedImageMotif(motif) || !isFeedImagePalette(palette)) return undefined;
  return {
    text: text.slice(0, 280),
    image: {
      alt: alt.slice(0, 180),
      headline: headline.slice(0, 64),
      motif,
      palette,
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textField(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue.trim() : undefined;
}

function isFeedImageMotif(value: unknown): value is FlowFeedImageMotif {
  return typeof value === "string" && feedImageMotifs.includes(value as FlowFeedImageMotif);
}

function isFeedImagePalette(value: unknown): value is FlowFeedImagePalette {
  return typeof value === "string" && feedImagePalettes.includes(value as FlowFeedImagePalette);
}
