import type { AgentModelOption } from "../agents/agent-settings-service.ts";
import type { ClaudeCodeTurnInput, ClaudeCodeTurnResult, IClaudeCodeClient } from "../agents/claude-code-client.ts";
import type { FlowAgentTurnInput } from "./flow-agent.ts";

import { describe, expect, it } from "vitest";
import { ActionPolicyService } from "../../core/action-policy.ts";
import { ClaudeCodeFlowAgent } from "./claude-code-flow-agent.ts";

describe("ClaudeCodeFlowAgent", () => {
  it("turns a structured Claude decision into a host-controlled tool call", async () => {
    const client = new FakeClaudeCodeClient({
      structuredOutput: {
        kind: "tool_call",
        toolName: "flow_1_source_read",
        arguments: { query: "today" },
      },
      usage: { input_tokens: 42 },
    });
    const agent = new ClaudeCodeFlowAgent(
      {
        async getClaudeOAuthToken(id: string): Promise<string> {
          expect(id).toBe("claude-subscription-1");
          return "secret-subscription-token";
        },
      },
      client,
    );

    const turn = await agent.respond(createTurnInput());

    expect(turn.functionCall).toMatchObject({
      name: "flow_1_source_read",
      arguments: JSON.stringify({ query: "today" }),
    });
    expect(client.inputs[0]).toMatchObject({
      oauthToken: "secret-subscription-token",
      model: "sonnet",
      effort: "medium",
    });
    expect(client.inputs[0]?.prompt).toContain("flow_1_source_read");
    expect(client.inputs[0]?.prompt).toContain("previous source result");
  });

  it("returns final text from a completed Claude decision", async () => {
    const agent = new ClaudeCodeFlowAgent(
      {
        async getClaudeOAuthToken(): Promise<string> {
          return "secret-subscription-token";
        },
      },
      new FakeClaudeCodeClient({
        structuredOutput: {
          kind: "final",
          text: "Synchronized one source item.",
        },
      }),
    );

    await expect(agent.respond(createTurnInput())).resolves.toMatchObject({
      text: "Synchronized one source item.",
    });
  });
});

class FakeClaudeCodeClient implements IClaudeCodeClient {
  readonly inputs: ClaudeCodeTurnInput[] = [];
  private readonly result: ClaudeCodeTurnResult;

  constructor(result: ClaudeCodeTurnResult) {
    this.result = result;
  }

  async inspectSubscriptionToken(): Promise<void> {}

  async listModels(): Promise<AgentModelOption[]> {
    return [];
  }

  async completeTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
    this.inputs.push(input);
    return this.result;
  }
}

function createTurnInput(): FlowAgentTurnInput {
  return {
    flow: {
      id: "flow-1",
      revision: "revision-1",
      name: "Source sync",
      status: "active",
      sourceConnectionId: "source-1",
      destinationConnectionId: "destination-1",
      instructions: "Synchronize today's records.",
      agent: {
        provider: "claude_code",
        connectionId: "claude-subscription-1",
        model: "sonnet",
        reasoningEffort: "medium",
      },
      tools: [],
      maxSteps: 4,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    },
    runId: "run-1",
    stepId: "step-1",
    instructions: "Use only supplied tools.",
    tools: [
      {
        name: "flow_1_source_read",
        description: "Read source records.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
    ],
    history: [
      {
        kind: "action",
        output: "previous source result",
      },
    ],
    input: "Run the Flow.",
    policy: new ActionPolicyService().createSnapshot(),
  };
}
