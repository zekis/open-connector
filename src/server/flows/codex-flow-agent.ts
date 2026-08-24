import type { AgentCredentialService } from "../agents/agent-credential-service.ts";
import type { CodexClient } from "../agents/codex-client.ts";
import type { FlowAgentTurn, FlowAgentTurnInput, IFlowAgent } from "./flow-agent.ts";

import { AgentCredentialError } from "../agents/agent-credential-service.ts";
import { ClaudeAgentDecisionError } from "../agents/claude-agent-decision.ts";
import { CodexError } from "../agents/codex-client.ts";
import {
  createFlowAgentTurnPrompt,
  flowAgentDecisionSchema,
  parseFlowAgentDecision,
} from "./claude-code-flow-agent.ts";
import { FlowAgentError } from "./flow-agent.ts";

/** Stateless Flow adapter backed by a local Codex CLI ChatGPT subscription login. */
export class CodexFlowAgent implements IFlowAgent {
  private readonly credentials: Pick<AgentCredentialService, "assertCodexConnection">;
  private readonly codex: Pick<CodexClient, "completeTurn">;

  constructor(
    credentials: Pick<AgentCredentialService, "assertCodexConnection">,
    codex: Pick<CodexClient, "completeTurn">,
  ) {
    this.credentials = credentials;
    this.codex = codex;
  }

  async respond(input: FlowAgentTurnInput): Promise<FlowAgentTurn> {
    try {
      await this.credentials.assertCodexConnection(input.flow.agent.connectionId);
      const result = await this.codex.completeTurn({
        model: input.flow.agent.model,
        effort: input.flow.agent.reasoningEffort,
        systemPrompt: input.instructions,
        prompt: createFlowAgentTurnPrompt(input),
        outputSchema: flowAgentDecisionSchema,
      });
      return parseFlowAgentDecision(result.structuredOutput, result.usage);
    } catch (error) {
      if (error instanceof FlowAgentError) {
        throw error;
      }
      if (
        error instanceof ClaudeAgentDecisionError ||
        error instanceof CodexError ||
        error instanceof AgentCredentialError
      ) {
        throw new FlowAgentError(error.code, error.message);
      }
      throw error;
    }
  }
}
