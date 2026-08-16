import type { SaynaVoiceConfiguration } from "./model";

const microphoneSampleRate = 16_000;
const voiceConnectionTimeoutMs = 30_000;
const playbackBufferLeadSeconds = 0.16;
const playbackSafetyMarginSeconds = 0.04;
const playbackCompletionGraceMs = 140;
const maxSpeechChunkCharacters = 900;

export type SaynaVoiceState = "offline" | "connecting" | "ready" | "listening" | "speaking" | "error";

export interface SaynaTranscript {
  text: string;
  final: boolean;
  speechFinal: boolean;
}

export interface SaynaVoiceCallbacks {
  onStateChange(state: SaynaVoiceState): void;
  onListeningChange(listening: boolean): void;
  onTranscript(transcript: SaynaTranscript): void;
  onError(message: string): void;
}

interface SaynaServerMessage {
  type: string;
  scope?: string;
  message?: string;
  transcript?: string;
  is_final?: boolean;
  is_speech_final?: boolean;
}

interface VoiceConnectionWaiter {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface QueuedSpeech {
  text: string;
  kind: "progress" | "response";
}

/** Browser voice session backed by Open Connector's authenticated Sayna bridge. */
export class SaynaVoiceClient {
  private socket?: WebSocket;
  private connection?: VoiceConnectionWaiter;
  private state: SaynaVoiceState = "offline";
  private microphoneStream?: MediaStream;
  private microphoneContext?: AudioContext;
  private microphoneSource?: MediaStreamAudioSourceNode;
  private microphoneProcessor?: ScriptProcessorNode;
  private microphoneSink?: GainNode;
  private playbackContext?: AudioContext;
  private playbackSources = new Set<AudioBufferSourceNode>();
  private nextPlaybackTime = 0;
  private speechQueue: QueuedSpeech[] = [];
  private speechInFlight?: QueuedSpeech;
  private speechGeneration = 0;
  private finalTranscriptSegments: string[] = [];
  private incomingMessages = Promise.resolve();
  private playbackComplete = false;
  private playbackCompletionTimer?: number;
  private recovery?: Promise<void>;
  private closed = false;

  constructor(
    private readonly configuration: SaynaVoiceConfiguration,
    private readonly callbacks: SaynaVoiceCallbacks,
  ) {}

  async startListening(): Promise<void> {
    if (this.microphoneStream) {
      this.stopListening();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail("Microphone access is unavailable in this browser or page context.");
      return;
    }

    if (this.state === "speaking") this.stopSpeaking();
    else this.stopPlayback();
    let stream: MediaStream | undefined;
    try {
      await this.resumePlayback();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      await this.ensureConnected();
      if (this.closed) {
        stopMediaStream(stream);
        return;
      }
      this.beginMicrophone(stream);
    } catch (error) {
      if (stream) stopMediaStream(stream);
      this.fail(describeVoiceError(error, "Could not start Sayna voice input."));
    }
  }

  stopListening(): void {
    this.microphoneProcessor?.disconnect();
    this.microphoneSource?.disconnect();
    this.microphoneSink?.disconnect();
    this.microphoneProcessor = undefined;
    this.microphoneSource = undefined;
    this.microphoneSink = undefined;
    if (this.microphoneStream) stopMediaStream(this.microphoneStream);
    this.microphoneStream = undefined;
    this.callbacks.onListeningChange(false);
    if (this.microphoneContext) void this.microphoneContext.close();
    this.microphoneContext = undefined;
    if (!this.closed && this.state === "listening") {
      this.setState(this.socket?.readyState === WebSocket.OPEN ? "ready" : "offline");
    }
  }

  async speak(markdown: string): Promise<void> {
    const text = plainTextForSpeech(markdown);
    if (!text) return;
    const generation = ++this.speechGeneration;
    await this.queueResponseSpeech(splitSpeechForPlayback(text), generation);
  }

  async speakProgress(text: string): Promise<void> {
    const normalized = plainTextForSpeech(text);
    if (!normalized) return;
    await this.queueSpeech({ text: normalized, kind: "progress" }, this.speechGeneration);
  }

  private async queueSpeech(speech: QueuedSpeech, generation: number): Promise<void> {
    try {
      await this.ensureConnected();
      await this.resumePlayback();
      if (this.closed || generation !== this.speechGeneration || this.speechInFlight?.text === speech.text) return;
      if (speech.kind === "response") {
        this.speechQueue = this.speechQueue.filter((item) => item.kind === "response");
      } else {
        if (this.speechQueue.some((item) => item.kind === "response")) return;
        this.speechQueue = this.speechQueue.filter((item) => item.kind !== "progress");
      }
      if (this.speechQueue.at(-1)?.text !== speech.text) this.speechQueue.push(speech);
      this.startNextSpeech();
    } catch (error) {
      this.fail(describeVoiceError(error, "Could not speak the agent reply."));
    }
  }

  private async queueResponseSpeech(chunks: string[], generation: number): Promise<void> {
    if (chunks.length === 0) return;
    try {
      await this.ensureConnected();
      await this.resumePlayback();
      if (this.closed || generation !== this.speechGeneration) return;
      this.speechQueue = chunks.map((text) => ({ text, kind: "response" }));
      this.startNextSpeech();
    } catch (error) {
      this.fail(describeVoiceError(error, "Could not speak the agent reply."));
    }
  }

  async preparePlayback(): Promise<void> {
    try {
      await this.resumePlayback();
    } catch (error) {
      this.fail(describeVoiceError(error, "Could not enable spoken agent replies."));
    }
  }

  stopSpeaking(): void {
    this.speechGeneration += 1;
    const connected = this.socket?.readyState === WebSocket.OPEN;
    if (connected) this.socket?.send(JSON.stringify({ type: "clear" }));
    this.stopPlayback();
    if (!this.closed) {
      if (this.microphoneStream) this.setState("listening");
      else if (connected) this.setState("ready");
      else this.setState("offline");
    }
  }

  close(): void {
    this.closed = true;
    this.stopListening();
    this.stopPlayback();
    if (this.playbackContext) void this.playbackContext.close();
    this.playbackContext = undefined;
    this.socket?.close(1000, "Chat closed");
    this.socket = undefined;
    this.connection = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.configuration.enabled || !this.configuration.websocketPath) {
      throw new Error("Sayna voice is not configured.");
    }
    if (this.socket?.readyState === WebSocket.OPEN && this.state !== "connecting" && this.state !== "error") return;
    if (this.connection) return await this.connection.promise;

    this.closed = false;
    this.playbackComplete = false;
    this.setState("connecting");
    const socket = new WebSocket(webSocketUrl(this.configuration.websocketPath));
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    let resolveConnection = (): void => {};
    let rejectConnection = (_error: Error): void => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    const connection: VoiceConnectionWaiter = {
      promise,
      resolve: resolveConnection,
      reject: rejectConnection,
    };
    this.connection = connection;

    const timer = window.setTimeout(() => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      socket.close(1011, "Voice connection timed out");
      connection.reject(new Error("Sayna voice did not become ready within 30 seconds."));
    }, voiceConnectionTimeoutMs);

    socket.onmessage = (event) => {
      this.incomingMessages = this.incomingMessages
        .then(() => this.handleMessage(event.data, connection, timer))
        .catch((error: unknown) => this.fail(describeVoiceError(error, "Could not process Sayna voice data.")));
    };
    socket.onerror = () => {
      if (this.connection !== connection) return;
      window.clearTimeout(timer);
      this.connection = undefined;
      connection.reject(new Error("The Sayna WebSocket connection failed."));
    };
    socket.onclose = () => {
      if (this.socket !== socket && this.connection !== connection) return;
      if (this.connection === connection) {
        window.clearTimeout(timer);
        this.connection = undefined;
        connection.reject(new Error("Sayna disconnected before voice became ready."));
      }
      if (this.socket === socket) this.socket = undefined;
      this.stopListening();
      if (!this.closed && this.state !== "error") this.setState("offline");
    };

    return await promise;
  }

  private async handleMessage(value: unknown, connection: VoiceConnectionWaiter, timer: number): Promise<void> {
    if (value instanceof ArrayBuffer) {
      await this.playPcm(value);
      return;
    }
    if (typeof value !== "string") return;
    const message = parseSaynaMessage(value);
    if (!message) return;

    if (message.type === "ready") {
      if (this.connection === connection) {
        window.clearTimeout(timer);
        this.connection = undefined;
        this.setState("ready");
        connection.resolve();
      }
      return;
    }
    if (message.type === "error") {
      const error = new Error(message.message || "Sayna reported a voice processing error.");
      if (this.connection === connection) {
        window.clearTimeout(timer);
        this.connection = undefined;
        connection.reject(error);
      }
      this.fail(error.message);
      return;
    }
    if (message.type === "recoverable_error" && message.scope === "stt") {
      this.recoverSpeechRecognition();
      return;
    }
    if (message.type === "tts_playback_complete") {
      if (!this.speechInFlight) return;
      this.playbackComplete = true;
      if (this.playbackSources.size === 0) this.schedulePlaybackCompletion();
      return;
    }
    if (message.type === "stt_result") this.handleTranscript(message);
  }

  private recoverSpeechRecognition(): void {
    if (this.closed || this.recovery) return;
    const resumeListening = Boolean(this.microphoneStream);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "Refreshing speech recognition");

    if (!resumeListening) {
      this.setState("offline");
      return;
    }

    this.setState("connecting");
    this.recovery = this.ensureConnected()
      .then(() => {
        if (!this.closed) {
          this.setState(this.playbackSources.size > 0 ? "speaking" : this.microphoneStream ? "listening" : "ready");
        }
      })
      .catch((error: unknown) => {
        this.fail(describeVoiceError(error, "Could not reconnect speech recognition."));
      })
      .finally(() => {
        this.recovery = undefined;
      });
  }

  private beginMicrophone(stream: MediaStream): void {
    this.finalTranscriptSegments = [];
    this.microphoneStream = stream;
    this.callbacks.onListeningChange(true);
    const context = new AudioContext({ sampleRate: microphoneSampleRate });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (!this.microphoneStream || this.socket?.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleAudio(input, context.sampleRate, microphoneSampleRate);
      this.socket.send(float32ToPcm16(resampled));
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    this.microphoneContext = context;
    this.microphoneSource = source;
    this.microphoneProcessor = processor;
    this.microphoneSink = sink;
    this.setState("listening");
  }

  private handleTranscript(message: SaynaServerMessage): void {
    const transcript = message.transcript?.trim();
    if (!transcript) return;
    if (this.state === "speaking") {
      if (!message.is_final) return;
      if (isLikelyPlaybackEcho(transcript, this.speechInFlight?.text)) {
        if (message.is_speech_final) this.finalTranscriptSegments = [];
        return;
      }
      this.interruptPlayback();
    }
    if (message.is_final && this.finalTranscriptSegments.at(-1) !== transcript) {
      this.finalTranscriptSegments.push(transcript);
    }
    const segments = message.is_final ? this.finalTranscriptSegments : [...this.finalTranscriptSegments, transcript];
    const text = segments.join(" ").trim();
    this.callbacks.onTranscript({
      text,
      final: message.is_final === true,
      speechFinal: message.is_speech_final === true,
    });
    if (message.is_speech_final) {
      this.finalTranscriptSegments = [];
    }
  }

  private async playPcm(value: ArrayBuffer): Promise<void> {
    if (value.byteLength < 2 || !this.speechInFlight) return;
    this.clearPlaybackCompletionTimer();
    const context = await this.resumePlayback();
    const samples = new Int16Array(value, 0, Math.floor(value.byteLength / 2));
    const buffer = context.createBuffer(1, samples.length, this.configuration.ttsSampleRate ?? 24_000);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) channel[index] = samples[index] / 32_768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const hasBufferedAudio = this.nextPlaybackTime > context.currentTime + playbackSafetyMarginSeconds;
    const startAt = hasBufferedAudio ? this.nextPlaybackTime : context.currentTime + playbackBufferLeadSeconds;
    this.nextPlaybackTime = startAt + buffer.duration;
    this.playbackSources.add(source);
    source.onended = () => {
      this.playbackSources.delete(source);
      if (this.playbackSources.size !== 0 || this.closed) return;
      if (this.playbackComplete) this.schedulePlaybackCompletion();
    };
    source.start(startAt);
    this.setState("speaking");
  }

  private async resumePlayback(): Promise<AudioContext> {
    this.playbackContext ??= new AudioContext({ latencyHint: "playback" });
    if (this.playbackContext.state === "suspended") await this.playbackContext.resume();
    return this.playbackContext;
  }

  private stopPlayback(): void {
    this.clearPlaybackCompletionTimer();
    for (const source of this.playbackSources) {
      try {
        source.stop();
      } catch {
        // A source may already have completed between iteration and stop().
      }
    }
    this.playbackSources.clear();
    this.nextPlaybackTime = 0;
    this.playbackComplete = false;
    this.speechQueue = [];
    this.speechInFlight = undefined;
  }

  private interruptPlayback(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "clear" }));
    this.stopPlayback();
    if (!this.closed && this.microphoneStream) this.setState("listening");
  }

  private finishPlayback(): void {
    this.clearPlaybackCompletionTimer();
    this.playbackComplete = false;
    this.speechInFlight = undefined;
    this.nextPlaybackTime = 0;
    if (this.closed) return;
    if (this.speechQueue.length > 0) {
      this.startNextSpeech();
      return;
    }
    this.setState(this.microphoneStream ? "listening" : "ready");
  }

  private startNextSpeech(): void {
    if (this.speechInFlight || this.closed || this.socket?.readyState !== WebSocket.OPEN) return;
    const speech = this.speechQueue.shift();
    if (!speech) return;
    this.speechInFlight = speech;
    this.playbackComplete = false;
    this.nextPlaybackTime = 0;
    this.socket.send(JSON.stringify({ type: "speak", text: speech.text }));
    this.setState("speaking");
  }

  private schedulePlaybackCompletion(): void {
    this.clearPlaybackCompletionTimer();
    this.playbackCompletionTimer = window.setTimeout(() => {
      this.playbackCompletionTimer = undefined;
      if (this.playbackComplete && this.playbackSources.size === 0) this.finishPlayback();
    }, playbackCompletionGraceMs);
  }

  private clearPlaybackCompletionTimer(): void {
    if (this.playbackCompletionTimer !== undefined) window.clearTimeout(this.playbackCompletionTimer);
    this.playbackCompletionTimer = undefined;
  }

  private setState(state: SaynaVoiceState): void {
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  private fail(message: string): void {
    this.setState("error");
    this.callbacks.onError(message);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1011, "Voice session failed");
  }
}

export function parseSaynaMessage(value: string): SaynaServerMessage | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && typeof parsed.type === "string" ? (parsed as unknown as SaynaServerMessage) : undefined;
  } catch {
    return undefined;
  }
}

/** Converts browser float samples into Sayna's required signed 16-bit PCM frames. */
export function float32ToPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 32_768 : sample * 32_767;
  }
  return pcm.buffer;
}

/** Resamples one microphone frame when the browser cannot create a 16 kHz context. */
export function resampleAudio(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (samples.length === 0) return samples;
  if (sourceRate === targetRate) return samples;
  const outputLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[index] = samples[left] + (samples[right] - samples[left]) * fraction;
  }
  return output;
}

/** Removes common Markdown controls before passing an agent response to speech synthesis. */
export function plainTextForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?|```$/g, ""))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
}

/** Splits a long reply at natural pauses while preserving every spoken word. */
export function splitSpeechForPlayback(text: string, maximumCharacters = maxSpeechChunkCharacters): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const limit = Math.max(80, maximumCharacters);
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [normalized];
  const chunks: string[] = [];
  let current = "";

  const append = (part: string): void => {
    const candidate = current ? `${current} ${part}` : part;
    if (candidate.length <= limit) {
      current = candidate;
      return;
    }
    if (current) chunks.push(current);
    current = part;
  };

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length <= limit) {
      append(trimmed);
      continue;
    }
    for (const word of trimmed.split(" ")) {
      if (word.length <= limit) append(word);
      else {
        if (current) chunks.push(current);
        current = "";
        for (let offset = 0; offset < word.length; offset += limit) chunks.push(word.slice(offset, offset + limit));
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Identifies microphone transcripts that are probably the currently playing speaker audio. */
export function isLikelyPlaybackEcho(transcript: string, spokenText: string | undefined): boolean {
  if (!spokenText) return false;
  const heard = normalizedSpeechWords(transcript);
  const spoken = normalizedSpeechWords(spokenText);
  if (heard.length === 0 || spoken.length === 0) return false;
  if (heard.length === 1) return heard[0]!.length >= 4 && spoken.slice(0, 3).includes(heard[0]!);
  return spoken.join(" ").includes(heard.join(" "));
}

function normalizedSpeechWords(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function webSocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function describeVoiceError(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone permission was denied. Allow microphone access to use Sayna voice chat.";
  }
  return error instanceof Error ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
