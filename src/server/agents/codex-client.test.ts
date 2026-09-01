import type { CodexCommandInput, CodexCommandResult, CodexCommandRunner } from "./codex-client.ts";

import { access, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CodexClient } from "./codex-client.ts";

describe("CodexClient", () => {
  it("accepts a local ChatGPT subscription login", async () => {
    const runner = new FakeCodexCommandRunner([{ exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" }]);
    const client = new CodexClient(runner);

    await client.inspectSubscriptionLogin();

    expect(runner.calls[0]).toEqual({ args: ["login", "status"], timeoutMs: 15_000 });
  });

  it("rejects a non-ChatGPT Codex login", async () => {
    const runner = new FakeCodexCommandRunner([{ exitCode: 0, stdout: "Logged in using an API key\n", stderr: "" }]);

    await expect(new CodexClient(runner).inspectSubscriptionLogin()).rejects.toMatchObject({
      code: "codex_auth_failed",
    });
  });

  it("runs an ephemeral read-only structured turn", async () => {
    const runner = new StructuredCodexCommandRunner();
    const client = new CodexClient(runner);

    const result = await client.completeTurn({
      model: "gpt-5.6-sol",
      effort: "medium",
      systemPrompt: "Use only host tools.",
      prompt: "Choose the next action.",
      outputSchema: { type: "object", properties: { kind: { type: "string" } } },
    });

    expect(result).toEqual({
      structuredOutput: { kind: "final", text: "Synchronization complete." },
      usage: { input_tokens: 42, output_tokens: 8 },
    });
    expect(runner.input?.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--output-schema",
        "--output-last-message",
        "--json",
      ]),
    );
    expect(runner.input?.args.at(-1)).toBe("-");
    expect(runner.input?.stdin).toContain("Use only host tools.");
    expect(runner.input?.stdin).toContain("Choose the next action.");
    expect(runner.schema).toMatchObject({ type: "object" });
    await expect(access(runner.input!.cwd!)).rejects.toThrow();
  });

  it("stages incoming images for a structured turn and removes them afterward", async () => {
    const runner = new StructuredCodexCommandRunner();
    const client = new CodexClient(runner);

    await client.completeTurn({
      model: "gpt-5.6-sol",
      effort: "medium",
      systemPrompt: "Use only host tools.",
      prompt: "Describe the attached status image.",
      outputSchema: { type: "object", properties: { kind: { type: "string" } } },
      attachments: [{ id: "teams-image-1", file: new File(["image bytes"], "status.png", { type: "image/png" }) }],
    });

    expect(runner.attachmentContent).toBe("image bytes");
    expect(runner.input?.stdin).toContain("teams-image-1");
    expect(runner.input?.stdin).toContain("untrusted data");
    expect(argumentValue(runner.input!.args, "--image")).toContain("status.png");
    await expect(access(runner.input!.cwd!)).rejects.toThrow();
  });

  it("lists the current recommended subscription models", async () => {
    await expect(new CodexClient(new FakeCodexCommandRunner([])).listModels()).resolves.toEqual([
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
    ]);
  });
});

class FakeCodexCommandRunner implements CodexCommandRunner {
  readonly calls: CodexCommandInput[] = [];
  private readonly results: CodexCommandResult[];

  constructor(results: CodexCommandResult[]) {
    this.results = results;
  }

  async run(input: CodexCommandInput): Promise<CodexCommandResult> {
    this.calls.push(input);
    return this.results.shift()!;
  }
}

class StructuredCodexCommandRunner implements CodexCommandRunner {
  input?: CodexCommandInput;
  schema?: Record<string, unknown>;
  attachmentContent?: string;

  async run(input: CodexCommandInput): Promise<CodexCommandResult> {
    this.input = input;
    const schemaPath = argumentValue(input.args, "--output-schema");
    const outputPath = argumentValue(input.args, "--output-last-message");
    this.schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
    if (input.args.includes("--image")) {
      this.attachmentContent = await readFile(argumentValue(input.args, "--image"), "utf8");
    }
    await writeFile(outputPath, JSON.stringify({ kind: "final", text: "Synchronization complete." }));
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 42, output_tokens: 8 } })}\n`,
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
