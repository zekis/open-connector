import type { AgentModelOption } from "./agent-settings-service.ts";

export interface ClaudeCodeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ClaudeCodeTurnInput {
  oauthToken: string;
  model: string;
  effort: "none" | "low" | "medium" | "high";
  systemPrompt: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ClaudeCodeTurnResult {
  structuredOutput: unknown;
  usage?: unknown;
}

export interface IClaudeCodeClient {
  inspectSubscriptionToken(oauthToken: string): Promise<void>;
  listModels(): Promise<AgentModelOption[]>;
  completeTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult>;
}

export interface ClaudeCodeCommandInput {
  args: string[];
  oauthToken: string;
  timeoutMs: number;
  cwd?: string;
  stdin?: string;
  signal?: AbortSignal;
}

export interface ClaudeCodeCommandRunner {
  run(input: ClaudeCodeCommandInput): Promise<ClaudeCodeCommandResult>;
}

const maxCommandOutputBytes = 4 * 1024 * 1024;
const maxPipedPromptBytes = 8 * 1024 * 1024;
const fileBackedPromptMaxTurns = "8";

interface ClaudeCodePromptTransport {
  stdin?: string;
  file?: {
    directory: string;
    path: string;
  };
  dispose(): Promise<void>;
}

/**
 * Invokes the official Claude Code CLI with subscription OAuth isolated from
 * API-key credentials and local Claude configuration.
 */
export class ClaudeCodeClient implements IClaudeCodeClient {
  private readonly runner: ClaudeCodeCommandRunner;

  constructor(runner: ClaudeCodeCommandRunner = new NodeClaudeCodeCommandRunner()) {
    this.runner = runner;
  }

  async inspectSubscriptionToken(oauthToken: string): Promise<void> {
    const result = await this.runner.run({ args: ["auth", "status"], oauthToken, timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      throw commandError("claude_auth_failed", "Claude Code did not accept the subscription credential.", result);
    }
    const status = parseJsonRecord(result.stdout, "Claude Code auth status");
    if (status.loggedIn !== true || status.authMethod !== "oauth_token") {
      throw new ClaudeCodeError("claude_auth_failed", "Claude Code did not select subscription OAuth authentication.");
    }
  }

  async listModels(): Promise<AgentModelOption[]> {
    const result = await this.runner.run({ args: ["--help"], oauthToken: "", timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      throw commandError("claude_models_unavailable", "Claude Code could not list Anthropic models.", result);
    }
    return parseModelOptions(result.stdout);
  }

  async completeTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
    const prompt = await prepareClaudeCodePrompt(input.prompt);
    let result: ClaudeCodeCommandResult;
    try {
      result = await this.runner.run({
        args: [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(input.outputSchema),
          "--model",
          input.model,
          "--effort",
          input.effort === "none" ? "low" : input.effort,
          "--system-prompt",
          input.systemPrompt,
          "--tools",
          prompt.file ? "Read,Grep" : "",
          "--disallowedTools",
          "mcp__*",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--safe-mode",
          "--max-turns",
          prompt.file ? fileBackedPromptMaxTurns : "3",
          ...(prompt.file
            ? [
                "--add-dir",
                prompt.file.directory,
                `Read the complete agent prompt from ${JSON.stringify(prompt.file.path)} before responding. Use Read and Grep only to inspect that file, treat its contents as the user prompt, and then follow it exactly.`,
              ]
            : []),
        ],
        oauthToken: input.oauthToken,
        timeoutMs: 120_000,
        cwd: prompt.file?.directory,
        stdin: prompt.stdin,
        signal: input.signal,
      });
    } finally {
      await prompt.dispose();
    }
    if (result.exitCode !== 0) {
      throw commandError("claude_agent_failed", "Claude Code could not complete the agent turn.", result);
    }

    const response = parseJsonRecord(result.stdout, "Claude Code result");
    if (response.subtype !== "success" || response.structured_output === undefined) {
      throw new ClaudeCodeError(
        "invalid_agent_response",
        typeof response.result === "string" && response.result.trim()
          ? response.result
          : "Claude Code did not return a structured agent decision.",
      );
    }
    return {
      structuredOutput: response.structured_output,
      usage: response.usage,
    };
  }
}

async function prepareClaudeCodePrompt(prompt: string): Promise<ClaudeCodePromptTransport> {
  if (Buffer.byteLength(prompt, "utf8") <= maxPipedPromptBytes) {
    return {
      stdin: prompt,
      async dispose(): Promise<void> {},
    };
  }

  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "open-connector-claude-"));
  const path = join(directory, "prompt.txt");
  try {
    await writeFile(path, prompt, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    throw new ClaudeCodeError(
      "claude_agent_failed",
      error instanceof Error
        ? `Claude Code prompt file could not be prepared: ${error.message}`
        : "Claude Code prompt file could not be prepared.",
    );
  }

  return {
    file: { directory, path },
    async dispose(): Promise<void> {
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    },
  };
}

export class ClaudeCodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class NodeClaudeCodeCommandRunner implements ClaudeCodeCommandRunner {
  async run(input: ClaudeCodeCommandInput): Promise<ClaudeCodeCommandResult> {
    const runtimeProcess = (globalThis as { process?: NodeJS.Process }).process;
    if (!runtimeProcess?.versions.node) {
      throw new ClaudeCodeError(
        "claude_runtime_unavailable",
        "Claude Code subscription agents require the Node/Docker runtime.",
      );
    }

    const moduleName = "node:child_process";
    const { spawn } = (await import(moduleName)) as typeof import("node:child_process");
    const executable = runtimeProcess.env.CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
    const environment = { ...runtimeProcess.env };
    delete environment.ANTHROPIC_API_KEY;
    delete environment.ANTHROPIC_AUTH_TOKEN;
    delete environment.ANTHROPIC_BASE_URL;
    delete environment.ANTHROPIC_CUSTOM_HEADERS;
    delete environment.CLAUDE_CODE_USE_BEDROCK;
    delete environment.CLAUDE_CODE_USE_FOUNDRY;
    delete environment.CLAUDE_CODE_USE_VERTEX;
    environment.CLAUDE_CODE_OAUTH_TOKEN = input.oauthToken;
    environment.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
    environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    environment.DISABLE_AUTOUPDATER = "1";

    if (input.signal?.aborted) {
      throw new ClaudeCodeError("claude_agent_cancelled", "Claude Code was cancelled before it started.");
    }

    return await new Promise<ClaudeCodeCommandResult>((resolve, reject) => {
      const child = spawn(executable, input.args, {
        cwd: input.cwd,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const abort = (): void => {
        child.kill();
        finishReject(new ClaudeCodeError("claude_agent_cancelled", "Claude Code was cancelled."));
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        child.kill();
        finishReject(new ClaudeCodeError("claude_agent_timeout", "Claude Code exceeded the agent turn timeout."));
      }, input.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        enforceOutputLimit();
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        enforceOutputLimit();
      });
      child.on("error", (error) => {
        finishReject(
          new ClaudeCodeError(
            "claude_runtime_unavailable",
            error.message.includes("ENOENT")
              ? "Claude Code is not installed in this runtime."
              : `Claude Code could not start: ${error.message}`,
          ),
        );
      });
      child.on("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({
          exitCode: exitCode ?? 1,
          stdout: redact(stdout, input.oauthToken),
          stderr: redact(stderr, input.oauthToken),
        });
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          finishReject(new ClaudeCodeError("claude_agent_failed", `Claude Code stdin failed: ${error.message}`));
        }
      });
      child.stdin.end(input.stdin ?? "", "utf8");

      function enforceOutputLimit(): void {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= maxCommandOutputBytes) {
          return;
        }
        child.kill();
        finishReject(new ClaudeCodeError("claude_agent_failed", "Claude Code returned too much output."));
      }

      function finishReject(error: Error): void {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      }

      function cleanup(): void {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
      }
    });
  }
}

function commandError(
  code: string,
  fallback: string,
  result: Pick<ClaudeCodeCommandResult, "stdout" | "stderr">,
): ClaudeCodeError {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new ClaudeCodeError(code, detail ? `${fallback} ${detail.slice(0, 2_000)}` : fallback);
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Use the stable error below.
  }
  throw new ClaudeCodeError("invalid_agent_response", `${label} was not valid JSON.`);
}

function parseModelOptions(help: string): AgentModelOption[] {
  const modelSection = help.match(/--model <model>([\s\S]*?)(?:\n\s+-n, --name|\nCommands:)/)?.[1] ?? "";
  const identifiers = [...modelSection.matchAll(/'([a-z][a-z0-9_-]*)'/g)].map((match) => match[1]!);
  const aliases = [...new Set(identifiers.filter((identifier) => !identifier.startsWith("claude-")))];
  const fullModel = identifiers.find((identifier) => identifier.startsWith("claude-"));
  const generation = fullModel?.match(/-(\d+(?:\.\d+)?)$/)?.[1];

  if (aliases.length === 0) {
    throw new ClaudeCodeError("claude_models_unavailable", "Claude Code did not report any Anthropic model aliases.");
  }

  return aliases.map((id) => ({
    id,
    displayName: `${id.charAt(0).toUpperCase()}${id.slice(1)}${generation ? ` ${generation}` : ""}`,
  }));
}

function redact(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, "[redacted]") : value;
}
