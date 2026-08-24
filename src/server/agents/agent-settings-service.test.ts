import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { AgentModelSource } from "./agent-settings-service.ts";

import { describe, expect, it } from "vitest";
import { AgentSettingsService } from "./agent-settings-service.ts";

describe("AgentSettingsService", () => {
  it("returns provider defaults before settings are stored", async () => {
    const service = new AgentSettingsService(new MemoryConnectionStore(), new FakeAgentModelSource());

    await expect(service.list()).resolves.toEqual([
      { provider: "claude_code", model: "opus" },
      { provider: "openai_codex", model: "gpt-5.6-sol" },
    ]);
    await expect(service.listModels("claude_code")).resolves.toEqual([
      { id: "opus", displayName: "Opus 5" },
      { id: "sonnet", displayName: "Sonnet 5" },
    ]);
  });

  it("persists and returns a model for one agent provider", async () => {
    const store = new MemoryConnectionStore();
    const service = new AgentSettingsService(store, new FakeAgentModelSource());

    await expect(service.update("claude_code", { model: "sonnet" })).resolves.toEqual({
      provider: "claude_code",
      model: "sonnet",
    });
    await expect(service.get("claude_code")).resolves.toEqual({
      provider: "claude_code",
      model: "sonnet",
    });
    expect((await store.get("agent_settings_claude_code", "default"))?.credential).toMatchObject({
      values: { model: "sonnet" },
      metadata: {
        agentProvider: "claude_code",
        configType: "agent_runtime_settings",
      },
    });
  });

  it("rejects unknown providers and invalid model identifiers", async () => {
    const service = new AgentSettingsService(new MemoryConnectionStore(), new FakeAgentModelSource());

    await expect(service.update("unknown", { model: "test" })).rejects.toMatchObject({
      code: "agent_provider_not_found",
      status: 404,
    });
    await expect(service.update("openai", { model: "opus" })).rejects.toMatchObject({
      code: "agent_provider_not_found",
      status: 404,
    });
    await expect(service.update("claude_code", { model: "haiku" })).rejects.toMatchObject({
      code: "invalid_model",
    });
  });
});

class FakeAgentModelSource implements AgentModelSource {
  async listModels() {
    return [
      { id: "sonnet", displayName: "Sonnet 5" },
      { id: "opus", displayName: "Opus 5" },
    ];
  }
}

class MemoryConnectionStore implements Pick<IConnectionStore, "get" | "set"> {
  private readonly records = new Map<string, StoredConnection>();

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    return this.records.get(`${service}\0${connectionName}`);
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const key = `${service}\0${connectionName}`;
    const previous = this.records.get(key);
    const stored: StoredConnection = {
      id: previous?.id ?? crypto.randomUUID(),
      revision: crypto.randomUUID(),
      service,
      connectionName,
      credential,
    };
    this.records.set(key, stored);
    return stored;
  }
}
