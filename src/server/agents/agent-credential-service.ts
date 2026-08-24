import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { AgentProvider } from "./agent-provider.ts";
import type { IClaudeCodeClient } from "./claude-code-client.ts";
import type { CodexClient } from "./codex-client.ts";

import { agentProviders } from "./agent-provider.ts";
import { ClaudeCodeError } from "./claude-code-client.ts";
import { CodexError } from "./codex-client.ts";

export type { AgentProvider } from "./agent-provider.ts";

export interface AgentConnectionSummary {
  id: string;
  provider: AgentProvider;
  authType: "subscription_oauth" | "chatgpt_subscription";
  configured: true;
  displayName: string;
  updatedAt?: string;
}

interface StoredClaudeCredential {
  authType: "custom_credential";
  values: {
    oauthToken: string;
  };
  profile: {
    accountId: string;
    displayName: string;
    grantedScopes: string[];
  };
  metadata: {
    agentProvider: "claude_code";
    authType: "subscription_oauth";
  };
}

interface StoredCodexCredential {
  authType: "custom_credential";
  values: {
    login: "verified";
  };
  profile: {
    accountId: string;
    displayName: string;
    grantedScopes: string[];
  };
  metadata: {
    agentProvider: "openai_codex";
    authType: "chatgpt_subscription";
  };
}

const connectionName = "default";

/**
 * Owns secret credentials for agent runtimes that are not connector providers.
 * Stored values never cross the public summary boundary.
 */
export class AgentCredentialService {
  private readonly store: Pick<IConnectionStore, "delete" | "get" | "set">;
  private readonly claudeCode: IClaudeCodeClient;
  private readonly codex: Pick<CodexClient, "inspectSubscriptionLogin">;

  constructor(
    store: Pick<IConnectionStore, "delete" | "get" | "set">,
    claudeCode: IClaudeCodeClient,
    codex: Pick<CodexClient, "inspectSubscriptionLogin">,
  ) {
    this.store = store;
    this.claudeCode = claudeCode;
    this.codex = codex;
  }

  async list(): Promise<AgentConnectionSummary[]> {
    const records = await Promise.all(
      agentProviders.map((provider) => this.store.get(internalService(provider), connectionName)),
    );
    return records.flatMap((stored) => (stored && isAgentCredential(stored) ? [toSummary(stored)] : []));
  }

  async connectClaudeSubscription(input: unknown): Promise<AgentConnectionSummary> {
    const token = readOAuthToken(input);
    try {
      await this.claudeCode.inspectSubscriptionToken(token);
    } catch (error) {
      if (error instanceof ClaudeCodeError) {
        throw mapClaudeCodeError(error);
      }
      throw error;
    }
    const stored = await this.store.set(internalService("claude_code"), connectionName, {
      authType: "custom_credential",
      values: { oauthToken: token },
      profile: {
        accountId: "claude-subscription",
        displayName: "Claude subscription",
        grantedScopes: [],
      },
      metadata: {
        agentProvider: "claude_code",
        authType: "subscription_oauth",
      },
    });
    return toSummary(stored);
  }

  async disconnectClaudeSubscription(): Promise<void> {
    await this.store.delete(internalService("claude_code"), connectionName);
  }

  async getClaudeOAuthToken(id: string): Promise<string> {
    const stored = await this.store.get(internalService("claude_code"), connectionName);
    if (!stored || stored.id !== id || !isClaudeCredential(stored)) {
      throw new AgentCredentialError("agent_connection_not_found", "Claude subscription connection not found.", 404);
    }
    return stored.credential.values.oauthToken;
  }

  async connectCodexSubscription(): Promise<AgentConnectionSummary> {
    try {
      await this.codex.inspectSubscriptionLogin();
    } catch (error) {
      if (error instanceof CodexError) {
        throw mapCodexError(error);
      }
      throw error;
    }
    const stored = await this.store.set(internalService("openai_codex"), connectionName, {
      authType: "custom_credential",
      values: { login: "verified" },
      profile: {
        accountId: "chatgpt-subscription",
        displayName: "ChatGPT subscription",
        grantedScopes: [],
      },
      metadata: {
        agentProvider: "openai_codex",
        authType: "chatgpt_subscription",
      },
    });
    return toSummary(stored);
  }

  async disconnectCodexSubscription(): Promise<void> {
    await this.store.delete(internalService("openai_codex"), connectionName);
  }

  async assertCodexConnection(id: string): Promise<void> {
    const stored = await this.store.get(internalService("openai_codex"), connectionName);
    if (!stored || stored.id !== id || !isCodexCredential(stored)) {
      throw new AgentCredentialError("agent_connection_not_found", "ChatGPT subscription connection not found.", 404);
    }
  }

  async getSummaryById(id: string): Promise<AgentConnectionSummary | undefined> {
    return (await this.list()).find((connection) => connection.id === id);
  }
}

export class AgentCredentialError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 503;

  constructor(code: string, message: string, status: 400 | 404 | 503 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function readOAuthToken(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentCredentialError("invalid_input", "Agent credential body must be a JSON object.");
  }
  const token = (input as { oauthToken?: unknown }).oauthToken;
  if (typeof token !== "string" || !token.trim()) {
    throw new AgentCredentialError("invalid_input", "oauthToken is required.");
  }
  const normalized = token.trim();
  if (normalized.length < 20 || normalized.length > 8_192) {
    throw new AgentCredentialError("invalid_input", "oauthToken has an invalid length.");
  }
  return normalized;
}

function isClaudeCredential(stored: StoredConnection): stored is StoredConnection & {
  credential: StoredClaudeCredential;
} {
  return (
    stored.credential.authType === "custom_credential" &&
    stored.credential.metadata.agentProvider === "claude_code" &&
    stored.credential.metadata.authType === "subscription_oauth" &&
    typeof stored.credential.values.oauthToken === "string"
  );
}

function isCodexCredential(stored: StoredConnection): stored is StoredConnection & {
  credential: StoredCodexCredential;
} {
  return (
    stored.credential.authType === "custom_credential" &&
    stored.credential.metadata.agentProvider === "openai_codex" &&
    stored.credential.metadata.authType === "chatgpt_subscription" &&
    stored.credential.values.login === "verified"
  );
}

function isAgentCredential(
  stored: StoredConnection,
): stored is StoredConnection & { credential: StoredClaudeCredential | StoredCodexCredential } {
  return isClaudeCredential(stored) || isCodexCredential(stored);
}

function toSummary(stored: StoredConnection): AgentConnectionSummary {
  if (!isAgentCredential(stored)) {
    throw new AgentCredentialError("invalid_agent_connection", "Stored agent credential is invalid.", 503);
  }
  return {
    id: stored.id,
    provider: stored.credential.metadata.agentProvider,
    authType: stored.credential.metadata.authType,
    configured: true,
    displayName: stored.credential.profile.displayName,
  };
}

export function mapClaudeCodeError(error: ClaudeCodeError): AgentCredentialError {
  return new AgentCredentialError(error.code, error.message, error.code === "claude_runtime_unavailable" ? 503 : 400);
}

export function mapCodexError(error: CodexError): AgentCredentialError {
  return new AgentCredentialError(error.code, error.message, error.code === "codex_runtime_unavailable" ? 503 : 400);
}

function internalService(provider: AgentProvider): string {
  return `agent_${provider}`;
}
