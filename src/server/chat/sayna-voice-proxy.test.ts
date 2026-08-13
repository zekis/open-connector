import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { embeddedSaynaWebSocketUrl } from "./sayna-voice-config.ts";
import {
  isRecoverableSaynaSttError,
  readSaynaVoiceClientCommand,
  registerSaynaVoiceRoutes,
} from "./sayna-voice-proxy.ts";
import { SaynaVoiceSettingsService } from "./sayna-voice-settings-service.ts";

describe("Sayna voice browser commands", () => {
  it("normalizes speech controls so the browser cannot disable interruption or append hidden audio", () => {
    const result = readSaynaVoiceClientCommand(
      JSON.stringify({ type: "speak", text: "Read the result.", flush: false, allow_interruption: false }),
    );

    expect(result).toEqual({
      ok: true,
      serialized: JSON.stringify({
        type: "speak",
        text: "Read the result.",
        flush: true,
        allow_interruption: true,
      }),
    });
  });

  it("accepts clear but rejects configuration and malformed commands", () => {
    expect(readSaynaVoiceClientCommand('{"type":"clear"}')).toEqual({
      ok: true,
      serialized: '{"type":"clear"}',
    });
    expect(readSaynaVoiceClientCommand('{"type":"config"}')).toMatchObject({ ok: false });
    expect(readSaynaVoiceClientCommand("not-json")).toMatchObject({ ok: false });
  });

  it("bounds text sent to speech synthesis", () => {
    expect(readSaynaVoiceClientCommand(JSON.stringify({ type: "speak", text: "x".repeat(20_001) }))).toMatchObject({
      ok: false,
    });
  });

  it("recognizes transient STT network failures without hiding provider or authentication errors", () => {
    expect(
      isRecoverableSaynaSttError(
        JSON.stringify({
          type: "error",
          message:
            "STT streaming error: Network error: WebSocket error: IO error: peer closed connection without sending TLS close_notify",
        }),
      ),
    ).toBe(true);
    expect(
      isRecoverableSaynaSttError(
        JSON.stringify({ type: "error", message: "STT streaming error: Authentication failed: invalid key" }),
      ),
    ).toBe(false);
    expect(isRecoverableSaynaSttError("not-json")).toBe(false);
  });

  it("configures voice through the authenticated console API without returning the key", async () => {
    const app = new Hono();
    const settings = new SaynaVoiceSettingsService(new MemoryConnectionStore());
    registerSaynaVoiceRoutes(app, {
      runtime: { targetUrl: embeddedSaynaWebSocketUrl, trustedEmbedded: true },
      settings,
    });

    expect(await (await app.request("/api/agent-chat/voice/config")).json()).toMatchObject({
      available: true,
      configured: false,
      enabled: false,
    });
    const response = await app.request("/api/agent-chat/voice/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "elevenlabs-secret-key", voiceId: "voice-123" }),
    });
    const configured = await response.json();

    expect(response.status).toBe(200);
    expect(configured).toMatchObject({ configured: true, enabled: true, voiceId: "voice-123" });
    expect(JSON.stringify(configured)).not.toContain("elevenlabs-secret-key");
  });
});

class MemoryConnectionStore implements Pick<IConnectionStore, "delete" | "get" | "set"> {
  private stored?: StoredConnection;

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    return this.stored?.service === service && this.stored.connectionName === connectionName ? this.stored : undefined;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    this.stored = {
      id: this.stored?.id ?? crypto.randomUUID(),
      revision: crypto.randomUUID(),
      service,
      connectionName,
      credential,
    };
    return this.stored;
  }

  async delete(): Promise<void> {
    this.stored = undefined;
  }
}
