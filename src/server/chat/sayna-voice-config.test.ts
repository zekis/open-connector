import { describe, expect, it } from "vitest";
import {
  createSaynaVoiceConfiguration,
  defaultElevenLabsVoiceId,
  embeddedSaynaWebSocketUrl,
  readSaynaVoiceRuntimeConfiguration,
  serializeSaynaVoiceConfiguration,
} from "./sayna-voice-config.ts";

describe("Sayna voice configuration", () => {
  it("uses the fixed loopback endpoint for the embedded runtime", () => {
    expect(readSaynaVoiceRuntimeConfiguration({ embedded: "true" })).toEqual({
      targetUrl: embeddedSaynaWebSocketUrl,
      trustedEmbedded: true,
    });
  });

  it("normalizes an optional external Sayna endpoint", () => {
    expect(readSaynaVoiceRuntimeConfiguration({ url: "https://voice.example.com" })).toEqual({
      targetUrl: "wss://voice.example.com/ws",
      trustedEmbedded: false,
    });
    expect(readSaynaVoiceRuntimeConfiguration({})).toBeUndefined();
  });

  it("injects the server-side ElevenLabs key into both Sayna profiles", () => {
    const configuration = createSaynaVoiceConfiguration(
      { targetUrl: embeddedSaynaWebSocketUrl, trustedEmbedded: true },
      "elevenlabs-secret-key",
      "custom-voice",
    );

    expect(configuration.sttConfig).toMatchObject({
      provider: "elevenlabs",
      model: "scribe_v2_realtime",
      sample_rate: 16_000,
      auth: { api_key: "elevenlabs-secret-key" },
    });
    expect(configuration.ttsConfig).toMatchObject({
      provider: "elevenlabs",
      model: "eleven_flash_v2_5",
      voice_id: "custom-voice",
      sample_rate: 24_000,
      auth: { api_key: "elevenlabs-secret-key" },
    });
  });

  it("advertises setup without exposing the provider credential", () => {
    const runtime = { targetUrl: embeddedSaynaWebSocketUrl, trustedEmbedded: true };
    const configured = serializeSaynaVoiceConfiguration(runtime, {
      configured: true,
      provider: "elevenlabs",
      voiceId: "custom-voice",
    });

    expect(configured).toEqual({
      available: true,
      configured: true,
      enabled: true,
      provider: "sayna",
      speechProvider: "elevenlabs",
      voiceId: "custom-voice",
      websocketPath: "/api/agent-chat/voice",
      ttsSampleRate: 24_000,
    });
    expect(JSON.stringify(configured)).not.toContain("secret");
    expect(
      serializeSaynaVoiceConfiguration(runtime, {
        configured: false,
        provider: "elevenlabs",
        voiceId: defaultElevenLabsVoiceId,
      }),
    ).toMatchObject({ available: true, configured: false, enabled: false });
  });
});
