import type { AgentTurnRequest } from "../agents/agent-turn.ts";
import type { FlowDefinition } from "./flow-types.ts";

import { describe, expect, it, vi } from "vitest";
import { ActionPolicyService } from "../../core/action-policy.ts";
import { CodexFlowAgent } from "./codex-flow-agent.ts";

describe("CodexFlowAgent", () => {
  it("verifies the configured connection and returns a structured Flow decision", async () => {
    const assertCodexConnection = vi.fn(async () => undefined);
    const completeTurn = vi.fn(async (_input: AgentTurnRequest) => ({
      structuredOutput: { kind: "final", text: "Finished." },
      usage: { input_tokens: 12 },
    }));
    const agent = new CodexFlowAgent({ assertCodexConnection }, { completeTurn });

    const result = await agent.respond({
      flow: flowDefinition(),
      runId: "run-1",
      stepId: "step-1",
      instructions: "Complete the job.",
      tools: [],
      history: [],
      input: { started: true },
      policy: new ActionPolicyService().createSnapshot(),
    });

    expect(assertCodexConnection).toHaveBeenCalledWith("codex-connection");
    expect(completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        effort: "medium",
      }),
    );
    expect(result).toMatchObject({ text: "Finished.", usage: { input_tokens: 12 } });
  });
});

function flowDefinition(): FlowDefinition {
  return {
    id: "flow-1",
    revision: "revision-1",
    name: "Codex flow",
    status: "active",
    sourceConnectionIds: ["source-1"],
    destinationConnectionId: "destination-1",
    instructions: "Complete the job.",
    trigger: { type: "manual" },
    agent: {
      provider: "openai_codex",
      connectionId: "codex-connection",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    tools: [],
    maxSteps: 20,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}
