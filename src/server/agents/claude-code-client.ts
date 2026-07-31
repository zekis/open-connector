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

export interface ClaudeCodeCommandRunner {
  run(args: string[], oauthToken: string, timeoutMs: number): Promise<ClaudeCodeCommandResult>;
}

const maxCommandOutputBytes = 4 * 1024 * 1024;

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
    const result = await this.runner.run(["auth", "status"], oauthToken, 15_000);
    if (result.exitCode !== 0) {
      throw commandError("claude_auth_failed", "Claude Code did not accept the subscription credential.", result);
    }
    const status = parseJsonRecord(result.stdout, "Claude Code auth status");
    if (status.loggedIn !== true || status.authMethod !== "oauth_token") {
      throw new ClaudeCodeError("claude_auth_failed", "Claude Code did not select subscription OAuth authentication.");
    }
  }

  async listModels(): Promise<AgentModelOption[]> {
    const result = await this.runner.run(["--help"], "", 15_000);
    if (result.exitCode !== 0) {
      throw commandError("claude_models_unavailable", "Claude Code could not list Anthropic models.", result);
    }
    return parseModelOptions(result.stdout);
  }

  async completeTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
    const result = await this.runner.run(
      [
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
        "",
        "--disallowedTools",
        "mcp__*",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--safe-mode",
        "--max-turns",
        "3",
        input.prompt,
      ],
      input.oauthToken,
      120_000,
    );
    if (result.exitCode !== 0) {
      throw commandError("claude_agent_failed", "Claude Code could not complete the Flow turn.", result);
    }

    const response = parseJsonRecord(result.stdout, "Claude Code result");
    if (response.subtype !== "success" || response.structured_output === undefined) {
      throw new ClaudeCodeError(
        "invalid_agent_response",
        typeof response.result === "string" && response.result.trim()
          ? response.result
          : "Claude Code did not return a structured Flow decision.",
      );
    }
    return {
      structuredOutput: response.structured_output,
      usage: response.usage,
    };
  }
}

export class ClaudeCodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class NodeClaudeCodeCommandRunner implements ClaudeCodeCommandRunner {
  async run(args: string[], oauthToken: string, timeoutMs: number): Promise<ClaudeCodeCommandResult> {
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
    environment.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    environment.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
    environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    environment.DISABLE_AUTOUPDATER = "1";

    return await new Promise<ClaudeCodeCommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill();
        finishReject(new ClaudeCodeError("claude_agent_timeout", "Claude Code exceeded the Flow turn timeout."));
      }, timeoutMs);

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
        clearTimeout(timeout);
        resolve({
          exitCode: exitCode ?? 1,
          stdout: redact(stdout, oauthToken),
          stderr: redact(stderr, oauthToken),
        });
      });

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
        clearTimeout(timeout);
        reject(error);
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
