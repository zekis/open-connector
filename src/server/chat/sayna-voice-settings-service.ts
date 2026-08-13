import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { SaynaVoiceConfiguration, SaynaVoiceRuntimeConfiguration } from "./sayna-voice-config.ts";

import { createSaynaVoiceConfiguration, defaultElevenLabsVoiceId } from "./sayna-voice-config.ts";

export interface SaynaVoiceSettingsSummary {
  configured: boolean;
  provider: "elevenlabs";
  voiceId: string;
}

interface StoredSaynaVoiceCredential {
  authType: "custom_credential";
  values: {
    apiKey: string;
    voiceId: string;
  };
  profile: {
    accountId: string;
    displayName: string;
    grantedScopes: string[];
  };
  metadata: {
    configType: "sayna_voice_settings";
    speechProvider: "elevenlabs";
  };
}

const internalService = "chat_voice_sayna";
const connectionName = "default";

/** Owns the ElevenLabs credential used by server-side Sayna voice sessions. */
export class SaynaVoiceSettingsService {
  private readonly store: Pick<IConnectionStore, "delete" | "get" | "set">;

  constructor(store: Pick<IConnectionStore, "delete" | "get" | "set">) {
    this.store = store;
  }

  async getSummary(): Promise<SaynaVoiceSettingsSummary> {
    const stored = await this.store.get(internalService, connectionName);
    if (!stored) return defaultSummary();
    if (!isSaynaVoiceCredential(stored)) {
      throw new SaynaVoiceSettingsError("invalid_voice_settings", "Stored Sayna voice settings are invalid.", 503);
    }
    return {
      configured: true,
      provider: "elevenlabs",
      voiceId: stored.credential.values.voiceId,
    };
  }

  async update(input: unknown): Promise<SaynaVoiceSettingsSummary> {
    const current = await this.readStoredCredential();
    const values = readSettingsInput(input, current?.credential.values);
    const stored = await this.store.set(internalService, connectionName, {
      authType: "custom_credential",
      values,
      profile: {
        accountId: "elevenlabs",
        displayName: "ElevenLabs voice",
        grantedScopes: [],
      },
      metadata: {
        configType: "sayna_voice_settings",
        speechProvider: "elevenlabs",
      },
    });
    if (!isSaynaVoiceCredential(stored)) {
      throw new SaynaVoiceSettingsError("invalid_voice_settings", "Stored Sayna voice settings are invalid.", 503);
    }
    return {
      configured: true,
      provider: "elevenlabs",
      voiceId: stored.credential.values.voiceId,
    };
  }

  async delete(): Promise<SaynaVoiceSettingsSummary> {
    await this.store.delete(internalService, connectionName);
    return defaultSummary();
  }

  async getConfiguration(
    runtime: SaynaVoiceRuntimeConfiguration | undefined,
  ): Promise<SaynaVoiceConfiguration | undefined> {
    if (!runtime) return undefined;
    const stored = await this.readStoredCredential();
    return stored
      ? createSaynaVoiceConfiguration(runtime, stored.credential.values.apiKey, stored.credential.values.voiceId)
      : undefined;
  }

  private async readStoredCredential(): Promise<
    (StoredConnection & { credential: StoredSaynaVoiceCredential }) | undefined
  > {
    const stored = await this.store.get(internalService, connectionName);
    if (!stored) return undefined;
    if (!isSaynaVoiceCredential(stored)) {
      throw new SaynaVoiceSettingsError("invalid_voice_settings", "Stored Sayna voice settings are invalid.", 503);
    }
    return stored;
  }
}

export class SaynaVoiceSettingsError extends Error {
  readonly code: string;
  readonly status: 400 | 503;

  constructor(code: string, message: string, status: 400 | 503 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function defaultSummary(): SaynaVoiceSettingsSummary {
  return {
    configured: false,
    provider: "elevenlabs",
    voiceId: defaultElevenLabsVoiceId,
  };
}

function readSettingsInput(
  input: unknown,
  current: StoredSaynaVoiceCredential["values"] | undefined,
): StoredSaynaVoiceCredential["values"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SaynaVoiceSettingsError("invalid_input", "Voice settings body must be a JSON object.");
  }
  const record = input as { apiKey?: unknown; voiceId?: unknown };
  const apiKey = typeof record.apiKey === "string" && record.apiKey.trim() ? record.apiKey.trim() : current?.apiKey;
  if (!apiKey || apiKey.length < 10 || apiKey.length > 4_096) {
    throw new SaynaVoiceSettingsError("invalid_input", "A valid ElevenLabs API key is required.");
  }
  const voiceId =
    typeof record.voiceId === "string" && record.voiceId.trim()
      ? record.voiceId.trim()
      : (current?.voiceId ?? defaultElevenLabsVoiceId);
  if (voiceId.length > 200 || /\s/.test(voiceId)) {
    throw new SaynaVoiceSettingsError(
      "invalid_input",
      "ElevenLabs voice ID must be a single value under 200 characters.",
    );
  }
  return { apiKey, voiceId };
}

function isSaynaVoiceCredential(
  stored: StoredConnection,
): stored is StoredConnection & { credential: StoredSaynaVoiceCredential } {
  return (
    stored.credential.authType === "custom_credential" &&
    stored.credential.metadata.configType === "sayna_voice_settings" &&
    stored.credential.metadata.speechProvider === "elevenlabs" &&
    typeof stored.credential.values.apiKey === "string" &&
    typeof stored.credential.values.voiceId === "string" &&
    Boolean(stored.credential.values.apiKey) &&
    Boolean(stored.credential.values.voiceId)
  );
}
