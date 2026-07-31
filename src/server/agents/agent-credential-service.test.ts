import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { AgentModelOption } from "./agent-settings-service.ts";
import type { IClaudeCodeClient, ClaudeCodeTurnInput, ClaudeCodeTurnResult } from "./claude-code-client.ts";

import { describe, expect, it } from "vitest";
import { AgentCredentialService } from "./agent-credential-service.ts";

describe("AgentCredentialService", () => {
  it("stores a Claude subscription token without exposing it in summaries", async () => {
    const store = new MemoryConnectionStore();
    const claudeCode = new FakeClaudeCodeClient();
    const service = new AgentCredentialService(store, claudeCode);
    const oauthToken = "subscription-oauth-token-for-test";

    const summary = await service.connectClaudeSubscription({ oauthToken });

    expect(claudeCode.inspectedTokens).toEqual([oauthToken]);
    expect(summary).toMatchObject({
      provider: "claude_code",
      authType: "subscription_oauth",
      configured: true,
      displayName: "Claude subscription",
    });
    expect(summary).not.toHaveProperty("oauthToken");
    expect(await service.getClaudeOAuthToken(summary.id)).toBe(oauthToken);
    expect(await service.list()).toEqual([summary]);
  });

  it("removes the stored subscription connection", async () => {
    const service = new AgentCredentialService(new MemoryConnectionStore(), new FakeClaudeCodeClient());
    const summary = await service.connectClaudeSubscription({
      oauthToken: "subscription-oauth-token-for-test",
    });

    await service.disconnectClaudeSubscription();

    expect(await service.list()).toEqual([]);
    await expect(service.getClaudeOAuthToken(summary.id)).rejects.toMatchObject({
      code: "agent_connection_not_found",
    });
  });
});

class FakeClaudeCodeClient implements IClaudeCodeClient {
  readonly inspectedTokens: string[] = [];

  async inspectSubscriptionToken(oauthToken: string): Promise<void> {
    this.inspectedTokens.push(oauthToken);
  }

  async listModels(): Promise<AgentModelOption[]> {
    return [];
  }

  async completeTurn(_input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
    throw new Error("Not used.");
  }
}

class MemoryConnectionStore implements IConnectionStore {
  private readonly connections = new Map<string, StoredConnection>();

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    return this.connections.get(keyFor(service, connectionName));
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const key = keyFor(service, connectionName);
    const existing = this.connections.get(key);
    const stored = {
      id: existing?.id ?? crypto.randomUUID(),
      revision: crypto.randomUUID(),
      service,
      connectionName,
      credential,
    };
    this.connections.set(key, stored);
    return stored;
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    this.connections.set(keyFor(input.service, input.connectionName), input);
    return true;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    this.connections.delete(keyFor(service, connectionName));
  }

  async list(): Promise<StoredConnection[]> {
    return [...this.connections.values()];
  }
}

function keyFor(service: string, connectionName: string): string {
  return `${service}\0${connectionName}`;
}
