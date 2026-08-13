import { afterEach, describe, expect, it, vi } from "vitest";
import { apiDelete, ApiError, apiGet, apiPostNdjson } from "./api";

describe("readJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed payload for successful responses", async () => {
    stubFetch(Response.json({ authenticated: true }));

    await expect(apiGet("/api/auth/session")).resolves.toEqual({ authenticated: true });
  });

  it("rejects successful responses whose body is not JSON", async () => {
    // A gzip payload reaching the client undecoded is the real-world case: the
    // status is 200, so nothing else in the app treats the response as failed.
    stubFetch(new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), { status: 200 }));

    const error = await apiGet("/api/auth/session").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(200);
    expect((error as ApiError).message).toMatch(/not JSON/);
  });

  it("keeps returning null for successful responses with an empty body", async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(apiDelete("/api/runtime-tokens/token-1")).resolves.toBeNull();
  });

  it("reports the server error message when the failed body is JSON", async () => {
    stubFetch(Response.json({ errorMessage: "Connection not found." }, { status: 404 }));

    await expect(apiGet("/api/connections/example")).rejects.toThrow("Connection not found.");
  });

  it("falls back to the status when the failed body is not JSON", async () => {
    stubFetch(new Response("<html>502</html>", { status: 502 }));

    await expect(apiGet("/api/providers")).rejects.toThrow("Request failed with 502");
  });

  it("decodes NDJSON items split across browser stream chunks", async () => {
    const encoder = new TextEncoder();
    stubFetch(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('{"type":"progress","value":'));
            controller.enqueue(encoder.encode('1}\n{"type":"response","value":2}\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );
    const items: unknown[] = [];

    await apiPostNdjson("/api/agent-chat/messages/stream", { messages: [] }, (item) => items.push(item));

    expect(items).toEqual([
      { type: "progress", value: 1 },
      { type: "response", value: 2 },
    ]);
  });
});

function stubFetch(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}
