import type { SaynaVoiceSettingsSummary } from "./sayna-voice-settings-service.ts";

export const embeddedSaynaWebSocketUrl = "ws://127.0.0.1:3001/ws";
export const defaultElevenLabsVoiceId = "21m00Tcm4TlvDq8ikWAM";

const ttsSampleRate = 24_000;

export interface SaynaVoiceEnvironment {
  embedded?: string;
  url?: string;
}

export interface SaynaVoiceRuntimeConfiguration {
  targetUrl: string;
  trustedEmbedded: boolean;
}

export interface SaynaVoiceConfiguration extends SaynaVoiceRuntimeConfiguration {
  sttConfig: Record<string, unknown>;
  ttsConfig: Record<string, unknown>;
  ttsSampleRate: number;
}

export interface SaynaVoiceClientConfiguration {
  available: boolean;
  configured: boolean;
  enabled: boolean;
  provider: "sayna";
  speechProvider: "elevenlabs";
  voiceId: string;
  websocketPath?: string;
  ttsSampleRate?: number;
}

/** Reads the Node deployment's embedded or external Sayna runtime endpoint. */
export function readSaynaVoiceRuntimeConfiguration(
  environment: SaynaVoiceEnvironment,
): SaynaVoiceRuntimeConfiguration | undefined {
  if (readBoolean(environment.embedded)) {
    return {
      targetUrl: embeddedSaynaWebSocketUrl,
      trustedEmbedded: true,
    };
  }

  const url = environment.url?.trim();
  return url
    ? {
        targetUrl: normalizeWebSocketUrl(url),
        trustedEmbedded: false,
      }
    : undefined;
}

/** Builds a secret-bearing Sayna session profile that never crosses the server boundary. */
export function createSaynaVoiceConfiguration(
  runtime: SaynaVoiceRuntimeConfiguration,
  apiKey: string,
  voiceId: string,
): SaynaVoiceConfiguration {
  const auth = { api_key: apiKey };
  return {
    ...runtime,
    sttConfig: {
      provider: "elevenlabs",
      language: "en",
      sample_rate: 16_000,
      channels: 1,
      punctuation: true,
      encoding: "linear16",
      model: "scribe_v2_realtime",
      auth,
    },
    ttsConfig: {
      provider: "elevenlabs",
      model: "eleven_flash_v2_5",
      voice_id: voiceId,
      speaking_rate: 1,
      audio_format: "linear16",
      sample_rate: ttsSampleRate,
      auth,
    },
    ttsSampleRate,
  };
}

/** Returns only the non-secret voice capability advertised to the web console. */
export function serializeSaynaVoiceConfiguration(
  runtime: SaynaVoiceRuntimeConfiguration | undefined,
  settings: SaynaVoiceSettingsSummary,
): SaynaVoiceClientConfiguration {
  const enabled = Boolean(runtime && settings.configured);
  return {
    available: Boolean(runtime),
    configured: settings.configured,
    enabled,
    provider: "sayna",
    speechProvider: "elevenlabs",
    voiceId: settings.voiceId,
    ...(enabled ? { websocketPath: "/api/agent-chat/voice", ttsSampleRate } : {}),
  };
}

function normalizeWebSocketUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("OOMOL_CONNECT_SAYNA_URL must be a valid ws:// or wss:// URL.");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("OOMOL_CONNECT_SAYNA_URL must be a valid ws:// or wss:// URL.");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
  return url.toString();
}

function readBoolean(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
