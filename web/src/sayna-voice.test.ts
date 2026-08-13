import { afterEach, describe, expect, it, vi } from "vitest";
import { float32ToPcm16, parseSaynaMessage, plainTextForSpeech, resampleAudio, SaynaVoiceClient } from "./sayna-voice";

describe("Sayna voice helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("encodes clamped little-endian PCM16 samples", () => {
    const pcm = new Int16Array(float32ToPcm16(new Float32Array([-2, -0.5, 0, 0.5, 2])));
    expect([...pcm]).toEqual([-32_768, -16_384, 0, 16_383, 32_767]);
  });

  it("resamples a microphone frame to the Sayna input rate", () => {
    const result = resampleAudio(new Float32Array([0, 0.25, 0.5, 0.75]), 32_000, 16_000);
    expect([...result]).toEqual([0, 0.5]);
  });

  it("parses Sayna protocol messages and ignores malformed input", () => {
    expect(parseSaynaMessage('{"type":"stt_result","transcript":"hello","is_final":true}')).toMatchObject({
      type: "stt_result",
      transcript: "hello",
      is_final: true,
    });
    expect(parseSaynaMessage("not json")).toBeUndefined();
    expect(parseSaynaMessage('{"type":"recoverable_error","scope":"stt"}')).toMatchObject({
      type: "recoverable_error",
      scope: "stt",
    });
    expect(parseSaynaMessage('{"type":"tts_playback_complete","timestamp":123}')).toMatchObject({
      type: "tts_playback_complete",
    });
  });

  it("turns formatted agent output into clean speech", () => {
    expect(plainTextForSpeech("## Result\n\n- **Sent** [the email](https://example.com).")).toBe(
      "Result Sent the email.",
    );
  });

  it("keeps the microphone and Sayna session open after a finalized conversational turn", async () => {
    const runtime = installVoiceRuntime();
    const listening: boolean[] = [];
    const transcripts: string[] = [];
    const client = new SaynaVoiceClient(createConfiguration(), {
      onStateChange: () => {},
      onListeningChange: (value) => listening.push(value),
      onTranscript: (transcript) => transcripts.push(transcript.text),
      onError: (message) => {
        throw new Error(message);
      },
    });

    const starting = client.startListening();
    await vi.waitFor(() => expect(runtime.sockets).toHaveLength(1));
    runtime.sockets[0]!.receive('{"type":"ready"}');
    await starting;
    runtime.sockets[0]!.receive(
      '{"type":"stt_result","transcript":"check my email","is_final":true,"is_speech_final":true}',
    );
    await vi.waitFor(() => expect(transcripts).toEqual(["check my email"]));

    expect(listening.at(-1)).toBe(true);
    expect(runtime.track.stop).not.toHaveBeenCalled();
    expect(runtime.sockets[0]!.closed).toBe(false);
    client.close();
  });

  it("serializes speech and drops stale progress before the final response", async () => {
    const runtime = installVoiceRuntime();
    const client = createClient();
    const starting = client.startListening();
    await vi.waitFor(() => expect(runtime.sockets).toHaveLength(1));
    runtime.sockets[0]!.receive('{"type":"ready"}');
    await starting;

    await client.speakProgress("Hmm, I'm checking that.");
    await client.speakProgress("Okay, I'm checking Outlook now.");
    await client.speakProgress("Yes, I can see the messages from Outlook.");
    await client.speak("Here are today's important emails.");

    expect(sentSpeech(runtime.sockets[0]!)).toEqual(["Hmm, I'm checking that."]);
    runtime.sockets[0]!.receive('{"type":"tts_playback_complete"}');
    await vi.waitFor(() =>
      expect(sentSpeech(runtime.sockets[0]!)).toEqual([
        "Hmm, I'm checking that.",
        "Here are today's important emails.",
      ]),
    );
    client.close();
  });

  it("primes PCM playback with enough look-ahead for Chromium scheduling jitter", async () => {
    const runtime = installVoiceRuntime();
    const client = createClient();
    const starting = client.startListening();
    await vi.waitFor(() => expect(runtime.sockets).toHaveLength(1));
    runtime.sockets[0]!.receive('{"type":"ready"}');
    await starting;
    await client.speakProgress("Checking Outlook now.");

    runtime.sockets[0]!.receive(new Int16Array(480).buffer);
    await vi.waitFor(() => expect(runtime.playbackStarts).toHaveLength(1));

    expect(runtime.playbackStarts[0]).toBeGreaterThanOrEqual(1.16);
    client.close();
  });
});

interface VoiceRuntime {
  sockets: FakeWebSocket[];
  track: { stop: ReturnType<typeof vi.fn> };
  playbackStarts: number[];
}

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly sent: unknown[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "blob";
  closed = false;
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  onclose?: () => void;

  send(value: unknown): void {
    this.sent.push(value);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function installVoiceRuntime(): VoiceRuntime {
  const sockets: FakeWebSocket[] = [];
  const track = { stop: vi.fn() };
  playbackStarts = [];
  vi.stubGlobal("window", {
    location: { href: "https://connector.example/chat" },
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
    },
  });
  vi.stubGlobal(
    "WebSocket",
    class extends FakeWebSocket {
      static override readonly OPEN = FakeWebSocket.OPEN;

      constructor() {
        super();
        sockets.push(this);
      }
    },
  );
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return { sockets, track, playbackStarts };
}

let playbackStarts: number[] = [];

class FakeAudioContext {
  readonly sampleRate: number;
  readonly state = "running";
  readonly destination = {};
  readonly currentTime = 1;

  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate ?? 48_000;
  }

  createMediaStreamSource(): Pick<MediaStreamAudioSourceNode, "connect" | "disconnect"> {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor(): Pick<ScriptProcessorNode, "connect" | "disconnect" | "onaudioprocess"> {
    return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
  }

  createGain(): Pick<GainNode, "connect" | "disconnect" | "gain"> {
    return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } as AudioParam };
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    return {
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    return {
      buffer: null,
      connect: vi.fn(),
      start: (when?: number) => playbackStarts.push(when ?? 0),
      stop: vi.fn(),
      onended: null,
    } as unknown as AudioBufferSourceNode;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }
}

function createClient(): SaynaVoiceClient {
  return new SaynaVoiceClient(createConfiguration(), {
    onStateChange: () => {},
    onListeningChange: () => {},
    onTranscript: () => {},
    onError: (message) => {
      throw new Error(message);
    },
  });
}

function sentSpeech(socket: FakeWebSocket): string[] {
  return socket.sent.flatMap((value) => {
    if (typeof value !== "string") return [];
    const parsed = JSON.parse(value) as { type?: unknown; text?: unknown };
    return parsed.type === "speak" && typeof parsed.text === "string" ? [parsed.text] : [];
  });
}

function createConfiguration() {
  return {
    available: true,
    configured: true,
    enabled: true,
    provider: "sayna" as const,
    speechProvider: "elevenlabs" as const,
    voiceId: "voice-1",
    websocketPath: "/api/agent-chat/voice",
    ttsSampleRate: 24_000,
  };
}
