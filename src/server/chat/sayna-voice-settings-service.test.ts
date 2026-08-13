import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";

import { describe, expect, it } from "vitest";
import { embeddedSaynaWebSocketUrl } from "./sayna-voice-config.ts";
import { SaynaVoiceSettingsService } from "./sayna-voice-settings-service.ts";

describe("SaynaVoiceSettingsService", () => {
  it("stores the ElevenLabs key without exposing it in summaries", async () => {
    const service = new SaynaVoiceSettingsService(new MemoryConnectionStore());

    const summary = await service.update({ apiKey: "elevenlabs-secret-key", voiceId: "voice-123" });
    const configuration = await service.getConfiguration({
      targetUrl: embeddedSaynaWebSocketUrl,
      trustedEmbedded: true,
    });

    expect(summary).toEqual({ configured: true, provider: "elevenlabs", voiceId: "voice-123" });
    expect(summary).not.toHaveProperty("apiKey");
    expect(configuration?.sttConfig).toMatchObject({ auth: { api_key: "elevenlabs-secret-key" } });
  });

  it("preserves the stored key when only the voice changes", async () => {
    const service = new SaynaVoiceSettingsService(new MemoryConnectionStore());
    await service.update({ apiKey: "elevenlabs-secret-key", voiceId: "voice-123" });

    await expect(service.update({ apiKey: "", voiceId: "voice-456" })).resolves.toMatchObject({
      voiceId: "voice-456",
    });
    expect(
      await service.getConfiguration({ targetUrl: embeddedSaynaWebSocketUrl, trustedEmbedded: true }),
    ).toMatchObject({ ttsConfig: { voice_id: "voice-456", auth: { api_key: "elevenlabs-secret-key" } } });
  });

  it("removes voice credentials", async () => {
    const service = new SaynaVoiceSettingsService(new MemoryConnectionStore());
    await service.update({ apiKey: "elevenlabs-secret-key" });

    expect(await service.delete()).toMatchObject({ configured: false });
    expect(
      await service.getConfiguration({ targetUrl: embeddedSaynaWebSocketUrl, trustedEmbedded: true }),
    ).toBeUndefined();
  });
});

class MemoryConnectionStore implements IConnectionStore {
  private readonly connections = new Map<string, StoredConnection>();

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    return this.connections.get(`${service}\0${connectionName}`);
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const stored = {
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      service,
      connectionName,
      credential,
    };
    this.connections.set(`${service}\0${connectionName}`, stored);
    return stored;
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    this.connections.set(`${input.service}\0${input.connectionName}`, input);
    return true;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    this.connections.delete(`${service}\0${connectionName}`);
  }

  async list(): Promise<StoredConnection[]> {
    return [...this.connections.values()];
  }
}
