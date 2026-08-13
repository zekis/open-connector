import { describe, expect, it } from "vitest";
import { float32ToPcm16, parseSaynaMessage, plainTextForSpeech, resampleAudio } from "./sayna-voice";

describe("Sayna voice helpers", () => {
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
  });

  it("turns formatted agent output into clean speech", () => {
    expect(plainTextForSpeech("## Result\n\n- **Sent** [the email](https://example.com).")).toBe(
      "Result Sent the email.",
    );
  });
});
