import type { WebSocketLike } from "../../core/guarded-websocket.ts";
import type { Logger } from "../logger.ts";
import type { SaynaVoiceConfiguration, SaynaVoiceRuntimeConfiguration } from "./sayna-voice-config.ts";
import type { SaynaVoiceSettingsService } from "./sayna-voice-settings-service.ts";
import type { Context, Hono } from "hono";
import type { WSContext } from "hono/ws";

import { upgradeWebSocket } from "@hono/node-server";
import WebSocket from "ws";
import { openGuardedWebSocket } from "../../core/guarded-websocket.ts";
import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { HttpRequestError, readJsonBody } from "../api/http-utils.ts";
import { embeddedSaynaWebSocketUrl, serializeSaynaVoiceConfiguration } from "./sayna-voice-config.ts";
import { SaynaVoiceSettingsError } from "./sayna-voice-settings-service.ts";

const maximumAudioFrameBytes = 1024 * 1024;
const maximumSpeechCharacters = 20_000;
const recoverableSttErrorPrefix = "STT streaming error: Network error:";

export interface SaynaVoiceProxyOptions {
  runtime?: SaynaVoiceRuntimeConfiguration;
  settings: SaynaVoiceSettingsService;
  logger?: Pick<Logger, "warn">;
}

/** Registers the Node-only, authenticated bridge between browser voice chat and Sayna. */
export function registerSaynaVoiceRoutes(app: Hono, options: SaynaVoiceProxyOptions): void {
  app.get("/api/agent-chat/voice/config", async (context) =>
    context.json(serializeSaynaVoiceConfiguration(options.runtime, await options.settings.getSummary())),
  );
  app.put("/api/agent-chat/voice/settings", async (context) => {
    try {
      const summary = await options.settings.update(await readJsonBody(context));
      return context.json(serializeSaynaVoiceConfiguration(options.runtime, summary));
    } catch (error) {
      return writeSettingsError(context, error);
    }
  });
  app.delete("/api/agent-chat/voice/settings", async (context) => {
    try {
      return context.json(serializeSaynaVoiceConfiguration(options.runtime, await options.settings.delete()));
    } catch (error) {
      return writeSettingsError(context, error);
    }
  });
  app.get(
    "/api/agent-chat/voice",
    upgradeWebSocket(() => createVoiceSessionEvents(options)),
  );
}

function createVoiceSessionEvents(options: SaynaVoiceProxyOptions) {
  let session: SaynaVoiceProxySession | undefined;
  return {
    onOpen(_event: Event, client: WSContext) {
      session = new SaynaVoiceProxySession(options, client);
      session.open();
    },
    onMessage(event: MessageEvent, _client: WSContext) {
      void session?.forwardClientMessage(event.data);
    },
    onClose() {
      session?.close();
    },
    onError() {
      session?.close();
    },
  };
}

class SaynaVoiceProxySession {
  private readonly options: SaynaVoiceProxyOptions;
  private readonly client: WSContext;
  private readonly abortController = new AbortController();
  private upstream?: WebSocketLike;
  private closed = false;

  constructor(options: SaynaVoiceProxyOptions, client: WSContext) {
    this.options = options;
    this.client = client;
  }

  open(): void {
    void this.connectUpstream();
  }

  async forwardClientMessage(value: unknown): Promise<void> {
    if (this.closed) return;
    if (!this.upstream) {
      this.reportClientError("Sayna is still connecting. Wait for voice readiness before sending audio.");
      return;
    }

    if (typeof value === "string") {
      const command = readSaynaVoiceClientCommand(value);
      if (!command.ok) {
        this.reportClientError(command.message);
        return;
      }
      this.upstream.send(command.serialized);
      return;
    }

    const audio = await readBinary(value);
    if (!audio) {
      this.reportClientError("Sayna received an unsupported browser audio frame.");
      return;
    }
    if (audio.byteLength > maximumAudioFrameBytes) {
      this.reportClientError("Sayna audio frames must not exceed 1 MB.");
      return;
    }
    this.upstream.send(audio);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.upstream?.close(1000, "Browser disconnected");
  }

  private async connectUpstream(): Promise<void> {
    try {
      const configuration = await this.options.settings.getConfiguration(this.options.runtime);
      if (!configuration) {
        this.fail("Configure an ElevenLabs API key in Chat voice settings first.");
        return;
      }
      const upstream = await openSaynaWebSocket(configuration, this.abortController.signal);
      if (this.closed) {
        upstream.close();
        return;
      }

      this.upstream = upstream;
      upstream.binaryType = "arraybuffer";
      upstream.addEventListener("message", (event) => void this.forwardUpstreamMessage(event.data));
      upstream.addEventListener("error", () => this.fail("Sayna voice connection failed."));
      upstream.addEventListener("close", (event) => {
        if (this.closed) return;
        this.closed = true;
        this.client.close(normalizeCloseCode(event.code), event.reason || "Sayna disconnected");
      });
      upstream.send(
        JSON.stringify({
          type: "config",
          stream_id: crypto.randomUUID(),
          audio: true,
          stt_config: configuration.sttConfig,
          tts_config: configuration.ttsConfig,
        }),
      );
    } catch (error) {
      if (this.closed) return;
      this.options.logger?.warn({ err: error }, "Sayna voice connection failed");
      this.fail("Sayna voice is unavailable. Check the embedded service and ElevenLabs settings.");
    }
  }

  private async forwardUpstreamMessage(value: unknown): Promise<void> {
    if (this.closed) return;
    if (typeof value === "string") {
      if (isRecoverableSaynaSttError(value)) {
        sendJson(this.client, {
          type: "recoverable_error",
          scope: "stt",
          message: "Speech recognition disconnected and will reconnect automatically.",
        });
        this.retire();
        return;
      }
      this.client.send(value);
      return;
    }
    const binary = await readBinary(value);
    if (binary) this.client.send(binary);
  }

  private reportClientError(message: string): void {
    sendJson(this.client, { type: "error", message });
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.reportClientError(message);
    this.closed = true;
    this.abortController.abort();
    this.upstream?.close(1011, "Voice proxy failed");
    this.client.close(1011, "Voice proxy failed");
  }

  private retire(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.upstream?.close(1000, "Refreshing speech recognition");
    this.client.close(1012, "Refreshing speech recognition");
  }
}

async function openSaynaWebSocket(configuration: SaynaVoiceConfiguration, signal: AbortSignal): Promise<WebSocketLike> {
  if (configuration.trustedEmbedded) {
    if (configuration.targetUrl !== embeddedSaynaWebSocketUrl) {
      throw new TypeError("Embedded Sayna must use the fixed loopback endpoint.");
    }
    return await openTrustedEmbeddedSayna(signal);
  }
  return await openGuardedWebSocket(configuration.targetUrl, {
    allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    signal,
    fieldName: "Sayna WebSocket URL",
  });
}

function openTrustedEmbeddedSayna(signal: AbortSignal): Promise<WebSocketLike> {
  return new Promise<WebSocketLike>((resolve, reject) => {
    const socket = new WebSocket(embeddedSaynaWebSocketUrl);
    const timer = setTimeout(() => fail(new Error("Embedded Sayna connection timed out.")), 15_000);
    let settled = false;

    const abort = (): void => fail(new Error("Embedded Sayna connection was aborted."));
    signal.addEventListener("abort", abort, { once: true });

    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close();
      reject(error);
    }

    socket.once("open", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket as unknown as WebSocketLike);
    });
    socket.once("error", () => fail(new Error("Embedded Sayna connection failed.")));
    socket.once("close", () => fail(new Error("Embedded Sayna closed before connecting.")));
    if (signal.aborted) abort();
  });
}

export interface ValidSaynaVoiceClientCommand {
  ok: true;
  serialized: string;
}

export interface InvalidSaynaVoiceClientCommand {
  ok: false;
  message: string;
}

export type SaynaVoiceClientCommandResult = ValidSaynaVoiceClientCommand | InvalidSaynaVoiceClientCommand;

/** Identifies the transient ElevenLabs STT disconnect that requires a fresh Sayna session. */
export function isRecoverableSaynaSttError(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      isRecord(parsed) &&
      parsed.type === "error" &&
      typeof parsed.message === "string" &&
      parsed.message.startsWith(recoverableSttErrorPrefix)
    );
  } catch {
    return false;
  }
}

/** Restricts browser text messages to bounded Chat speech controls. */
export function readSaynaVoiceClientCommand(value: string): SaynaVoiceClientCommandResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, message: "Sayna voice commands must contain valid JSON." };
  }
  if (!isRecord(parsed) || (parsed.type !== "speak" && parsed.type !== "clear")) {
    return { ok: false, message: "Sayna voice only accepts speak and clear commands from Chat." };
  }
  if (parsed.type === "speak") {
    if (typeof parsed.text !== "string" || !parsed.text.trim() || parsed.text.length > maximumSpeechCharacters) {
      return { ok: false, message: "Sayna speech text must contain between 1 and 20000 characters." };
    }
    return {
      ok: true,
      serialized: JSON.stringify({ type: "speak", text: parsed.text, flush: true, allow_interruption: true }),
    };
  }
  return { ok: true, serialized: JSON.stringify({ type: "clear" }) };
}

async function readBinary(value: unknown): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return undefined;
}

function sendJson(client: WSContext, value: Record<string, unknown>): void {
  try {
    client.send(JSON.stringify(value));
  } catch {
    // A closing browser socket cannot receive the diagnostic.
  }
}

function normalizeCloseCode(value: number | undefined): number {
  return value && value >= 1000 && value <= 4999 ? value : 1011;
}

function writeSettingsError(context: Context, error: unknown): Response {
  if (error instanceof SaynaVoiceSettingsError) {
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof HttpRequestError) {
    return context.json({ error: { code: "invalid_input", message: error.message } }, 400);
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
