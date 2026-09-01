import type { AgentModelOption, AgentModelSource } from "./agent-settings-service.ts";
import type { AgentTurnRequest, AgentTurnResult, IAgentTurnClient } from "./agent-turn.ts";

import { agentTurnAttachmentPrompt, stageAgentTurnAttachments } from "./agent-turn-attachments.ts";

export interface CodexCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexCommandInput {
  args: string[];
  timeoutMs: number;
  cwd?: string;
  stdin?: string;
  signal?: AbortSignal;
}

export interface CodexCommandRunner {
  run(input: CodexCommandInput): Promise<CodexCommandResult>;
}

const maxCommandOutputBytes = 4 * 1024 * 1024;
const defaultCodexModel = "gpt-5.6-sol";
const codexModels: AgentModelOption[] = [
  { id: defaultCodexModel, displayName: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
];

export function defaultCodexAgentModel(): string {
  return defaultCodexModel;
}

/** Runs schema-constrained Codex turns using the ChatGPT login owned by the local Codex CLI. */
export class CodexClient implements IAgentTurnClient, AgentModelSource {
  private readonly runner: CodexCommandRunner;

  constructor(runner: CodexCommandRunner = new NodeCodexCommandRunner()) {
    this.runner = runner;
  }

  async inspectSubscriptionLogin(): Promise<void> {
    const result = await this.runner.run({ args: ["login", "status"], timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      throw commandError("codex_auth_failed", "Codex CLI could not verify its login.", result);
    }
    const status = `${result.stdout}\n${result.stderr}`;
    if (!/logged in using chatgpt/i.test(status)) {
      throw new CodexError(
        "codex_auth_failed",
        "Codex CLI is not signed in with ChatGPT. Run codex login on the runtime host first.",
      );
    }
  }

  async listModels(): Promise<AgentModelOption[]> {
    return structuredClone(codexModels);
  }

  async completeTurn(input: AgentTurnRequest): Promise<AgentTurnResult> {
    const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "open-connector-codex-"));
    const schemaPath = join(directory, "decision.schema.json");
    const outputPath = join(directory, "decision.json");
    try {
      const attachments = await stageAgentTurnAttachments(directory, input.attachments);
      await writeFile(schemaPath, JSON.stringify(input.outputSchema), { encoding: "utf8", mode: 0o600 });
      const result = await this.runner.run({
        args: [
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--color",
          "never",
          "--model",
          input.model,
          "-c",
          `model_reasoning_effort="${codexReasoningEffort(input.effort)}"`,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "--json",
          ...attachments.flatMap((attachment) =>
            attachment.mimeType.startsWith("image/") ? ["--image", attachment.path] : [],
          ),
          "-",
        ],
        timeoutMs: 120_000,
        cwd: directory,
        stdin: `${createCodexPrompt(input)}${agentTurnAttachmentPrompt(attachments)}`,
        signal: input.signal,
      });
      if (result.exitCode !== 0) {
        throw commandError("codex_agent_failed", "Codex could not complete the agent turn.", result);
      }
      const output = await readFile(outputPath, "utf8").catch(() => "");
      return {
        structuredOutput: parseJsonRecord(output, "Codex result"),
        usage: readCodexUsage(result.stdout),
      };
    } finally {
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

export class CodexError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class NodeCodexCommandRunner implements CodexCommandRunner {
  async run(input: CodexCommandInput): Promise<CodexCommandResult> {
    const runtimeProcess = (globalThis as { process?: NodeJS.Process }).process;
    if (!runtimeProcess?.versions.node) {
      throw new CodexError("codex_runtime_unavailable", "Codex subscription agents require the Node/Docker runtime.");
    }
    if (input.signal?.aborted) {
      throw new CodexError("codex_agent_cancelled", "Codex was cancelled before it started.");
    }

    const moduleName = "node:child_process";
    const { spawn } = (await import(moduleName)) as typeof import("node:child_process");
    const executable = runtimeProcess.env.CODEX_EXECUTABLE?.trim() || "codex";
    const environment = { ...runtimeProcess.env };
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    delete environment.CODEX_ACCESS_TOKEN;

    return await new Promise<CodexCommandResult>((resolve, reject) => {
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
        finishReject(new CodexError("codex_agent_cancelled", "Codex was cancelled."));
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        child.kill();
        finishReject(new CodexError("codex_agent_timeout", "Codex exceeded the agent turn timeout."));
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
          new CodexError(
            "codex_runtime_unavailable",
            error.message.includes("ENOENT")
              ? "Codex CLI is not installed in this runtime."
              : `Codex could not start: ${error.message}`,
          ),
        );
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          finishReject(new CodexError("codex_agent_failed", `Codex stdin failed: ${error.message}`));
        }
      });
      child.stdin.end(input.stdin ?? "", "utf8");

      function enforceOutputLimit(): void {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= maxCommandOutputBytes) return;
        child.kill();
        finishReject(new CodexError("codex_agent_failed", "Codex returned too much output."));
      }

      function finishReject(error: Error): void {
        if (settled) return;
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

function createCodexPrompt(input: AgentTurnRequest): string {
  return `<system_instructions>\n${input.systemPrompt}\n</system_instructions>\n\n<agent_prompt>\n${input.prompt}\n</agent_prompt>`;
}

function codexReasoningEffort(effort: AgentTurnRequest["effort"]): "low" | "medium" | "high" {
  return effort === "none" ? "low" : effort;
}

function commandError(
  code: string,
  fallback: string,
  result: Pick<CodexCommandResult, "stdout" | "stderr">,
): CodexError {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new CodexError(code, detail ? `${fallback} ${detail.slice(0, 2_000)}` : fallback);
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
  throw new CodexError("invalid_agent_response", `${label} was not valid JSON.`);
}

function readCodexUsage(stdout: string): unknown {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const event = JSON.parse(line) as { type?: unknown; usage?: unknown };
      if (event.type === "turn.completed" && event.usage !== undefined) return event.usage;
    } catch {
      // Ignore non-event diagnostic lines.
    }
  }
  return undefined;
}
