import type { ClaudeCodeCommandInput, ClaudeCodeCommandRunner } from "./claude-code-client.ts";

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
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

  it("retries a transient API failure before returning the structured turn", async () => {
    const runner = new FakeCommandRunner([
      transientApiFailure(),
      {
        exitCode: 0,
        stdout: JSON.stringify({
          subtype: "success",
          structured_output: { kind: "final", text: "Recovered after the provider error." },
        }),
        stderr: "",
      },
    ]);
    const client = new ClaudeCodeClient(runner);

    await expect(
      client.completeTurn({
        oauthToken: "secret-subscription-token",
        model: "opus",
        effort: "medium",
        systemPrompt: "Run the synchronization.",
        prompt: "Choose the next action.",
        outputSchema: { type: "object" },
      }),
    ).resolves.toMatchObject({
      structuredOutput: { kind: "final", text: "Recovered after the provider error." },
    });
    expect(runner.calls).toHaveLength(2);
  });

  it("returns a concise API error after the transient retry is exhausted", async () => {
    const runner = new FakeCommandRunner([transientApiFailure(), transientApiFailure()]);
    const client = new ClaudeCodeClient(runner);

    await expect(
      client.completeTurn({
        oauthToken: "secret-subscription-token",
        model: "opus",
        effort: "medium",
        systemPrompt: "Run the synchronization.",
        prompt: "Choose the next action.",
        outputSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({
      code: "claude_agent_api_error",
      message: "Claude Code API failed after one retry. API Error: Server error mid-response.",
    });
    expect(runner.calls).toHaveLength(2);
  });

  it("passes oversized prompts through a temporary file and removes it after the turn", async () => {
    const runner = new FileInspectingCommandRunner();
    const client = new ClaudeCodeClient(runner);
    const prompt = "x".repeat(8 * 1024 * 1024 + 1);

    await client.completeTurn({
      oauthToken: "secret-subscription-token",
      model: "opus",
      effort: "medium",
      systemPrompt: "Inspect the supplied history.",
      prompt,
      outputSchema: { type: "object" },
    });

    expect(runner.promptFileContent).toBe(prompt);
    expect(runner.input?.cwd).toBe(runner.promptDirectory);
    expect(runner.input?.stdin).toBeUndefined();
    expect(argumentValue(runner.input!.args, "--tools")).toBe("Read,Grep");
    expect(argumentValue(runner.input!.args, "--max-turns")).toBe("8");
    expect(runner.input?.args.at(-1)).toContain("prompt.txt");
    expect(runner.input?.args).not.toContain(prompt);
    await expect(access(runner.promptDirectory!)).rejects.toThrow();
  });
});

interface FakeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function transientApiFailure(): FakeCommandResult {
  return {
    exitCode: 1,
    stdout: JSON.stringify({
      is_error: true,
      terminal_reason: "api_error",
      result: "API Error: Server error mid-response.",
      modelUsage: { opus: { cacheCreationInputTokens: 300_287 } },
    }),
    stderr: "",
  };
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

class FileInspectingCommandRunner implements ClaudeCodeCommandRunner {
  input?: ClaudeCodeCommandInput;
  promptDirectory?: string;
  promptFileContent?: string;

  async run(input: ClaudeCodeCommandInput): Promise<FakeCommandResult> {
    this.input = input;
    this.promptDirectory = argumentValue(input.args, "--add-dir");
    this.promptFileContent = await readFile(join(this.promptDirectory, "prompt.txt"), "utf8");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        subtype: "success",
        structured_output: { kind: "final", text: "Large prompt inspected." },
      }),
      stderr: "",
    };
  }
}

function argumentValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value) throw new Error(`${name} argument is missing`);
  return value;
}
