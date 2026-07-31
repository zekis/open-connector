import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { IClaudeCodeClient } from "./claude-code-client.ts";

import { ClaudeCodeError } from "./claude-code-client.ts";

export type AgentProvider = "claude_code";

export interface AgentConnectionSummary {
  id: string;
  provider: AgentProvider;
  authType: "subscription_oauth";
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
    agentProvider: AgentProvider;
    authType: "subscription_oauth";
  };
}

const internalService = "agent_claude_code";
const connectionName = "default";

/**
 * Owns secret credentials for agent runtimes that are not connector providers.
 * Stored values never cross the public summary boundary.
 */
export class AgentCredentialService {
  private readonly store: Pick<IConnectionStore, "delete" | "get" | "set">;
  private readonly claudeCode: IClaudeCodeClient;

  constructor(store: Pick<IConnectionStore, "delete" | "get" | "set">, claudeCode: IClaudeCodeClient) {
    this.store = store;
    this.claudeCode = claudeCode;
  }

  async list(): Promise<AgentConnectionSummary[]> {
    const stored = await this.store.get(internalService, connectionName);
    return stored && isClaudeCredential(stored) ? [toSummary(stored)] : [];
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
    const stored = await this.store.set(internalService, connectionName, {
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
    await this.store.delete(internalService, connectionName);
  }

  async getClaudeOAuthToken(id: string): Promise<string> {
    const stored = await this.store.get(internalService, connectionName);
    if (!stored || stored.id !== id || !isClaudeCredential(stored)) {
      throw new AgentCredentialError("agent_connection_not_found", "Claude subscription connection not found.", 404);
    }
    return stored.credential.values.oauthToken;
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

function toSummary(stored: StoredConnection): AgentConnectionSummary {
  if (!isClaudeCredential(stored)) {
    throw new AgentCredentialError("invalid_agent_connection", "Stored Claude credential is invalid.", 503);
  }
  return {
    id: stored.id,
    provider: "claude_code",
    authType: "subscription_oauth",
    configured: true,
    displayName: stored.credential.profile.displayName,
  };
}

export function mapClaudeCodeError(error: ClaudeCodeError): AgentCredentialError {
  return new AgentCredentialError(error.code, error.message, error.code === "claude_runtime_unavailable" ? 503 : 400);
}
