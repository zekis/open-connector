import type { ClaudeCodeCommandInput, ClaudeCodeCommandRunner } from "./claude-code-client.ts";

import { describe, expect, it } from "vitest";
import { ClaudeCodeClient } from "./claude-code-client.ts";

describe("ClaudeCodeClient", () => {
  it("reads current model aliases from the Anthropic CLI", async () => {
    const runner = new FakeCommandRunner([
      {
        exitCode: 0,
        stdout: `  --model <model>  Model for the current session. Provide an alias for the latest model
                   (e.g. 'fable', 'opus', or 'sonnet') or a model's full name
                   (e.g. 'claude-fable-5').
  -n, --name <name>`,
        stderr: "",
      },
    ]);
    const client = new ClaudeCodeClient(runner);

    await expect(client.listModels()).resolves.toEqual([
      { id: "fable", displayName: "Fable 5" },
      { id: "opus", displayName: "Opus 5" },
      { id: "sonnet", displayName: "Sonnet 5" },
    ]);
    expect(runner.calls[0]).toEqual({
      args: ["--help"],
      oauthToken: "",
      timeoutMs: 15_000,
    });
  });

  it("recognizes a subscription OAuth token without putting it in command arguments", async () => {
    const runner = new FakeCommandRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "oauth_token",
          apiProvider: "firstParty",
        }),
        stderr: "",
      },
    ]);
    const client = new ClaudeCodeClient(runner);

    await client.inspectSubscriptionToken("secret-subscription-token");

    expect(runner.calls[0]).toMatchObject({
      args: ["auth", "status"],
      oauthToken: "secret-subscription-token",
    });
    expect(runner.calls[0]?.args).not.toContain("secret-subscription-token");
  });

  it("runs an isolated structured Flow turn", async () => {
    const runner = new FakeCommandRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          subtype: "success",
          structured_output: {
            kind: "final",
            text: "Synchronization complete.",
          },
          usage: { input_tokens: 10 },
        }),
        stderr: "",
      },
    ]);
    const client = new ClaudeCodeClient(runner);
    const prompt = "Choose the next action.".repeat(10_000);

    const result = await client.completeTurn({
      oauthToken: "secret-subscription-token",
      model: "sonnet",
      effort: "medium",
      systemPrompt: "Run the synchronization.",
      prompt,
      outputSchema: { type: "object" },
    });

    expect(result.structuredOutput).toEqual({
      kind: "final",
      text: "Synchronization complete.",
    });
    expect(runner.calls[0]?.oauthToken).toBe("secret-subscription-token");
    expect(runner.calls[0]?.stdin).toBe(prompt);
    expect(runner.calls[0]?.args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "json",
        "--model",
        "sonnet",
        "--tools",
        "",
        "--strict-mcp-config",
        "--safe-mode",
      ]),
    );
    expect(runner.calls[0]?.args).not.toContain(prompt);
    expect(runner.calls[0]?.args).not.toContain("secret-subscription-token");
  });
});

interface FakeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class FakeCommandRunner implements ClaudeCodeCommandRunner {
  readonly calls: ClaudeCodeCommandInput[] = [];
  private readonly results: FakeCommandResult[];

  constructor(results: FakeCommandResult[]) {
    this.results = results;
  }

  async run(input: ClaudeCodeCommandInput): Promise<FakeCommandResult> {
    this.calls.push(input);
    return this.results.shift()!;
  }
}
