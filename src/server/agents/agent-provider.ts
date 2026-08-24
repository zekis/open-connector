export type AgentProvider = "claude_code" | "openai_codex";

export const agentProviders: readonly AgentProvider[] = ["claude_code", "openai_codex"];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "claude_code" || value === "openai_codex";
}
