import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import {
  createVaultGardenerMemoryContext,
  normalizeVaultGardenerMemoryBaseUrl,
  validateVaultGardenerMemoryCredential,
  vaultGardenerMemoryActionHandlers,
} from "./runtime.ts";

describe("VaultGardener Memory runtime", () => {
  it("normalizes a movable REST base URL and rejects operation paths", () => {
    expect(normalizeVaultGardenerMemoryBaseUrl("https://memory.example.test/services/memory/")).toBe(
      "https://memory.example.test/services/memory",
    );
    expect(() => normalizeVaultGardenerMemoryBaseUrl("https://memory.example.test/memory/mcp")).toThrow(
      /REST service root/,
    );
    expect(() => normalizeVaultGardenerMemoryBaseUrl("https://memory.example.test/memory/v1/knowledge/search")).toThrow(
      /REST service root/,
    );
  });

  it("requires the deployment opt-in for private overlay addresses", () => {
    expect(() => normalizeVaultGardenerMemoryBaseUrl("http://100.100.10.20:8080/memory", false)).toThrow(
      /private or reserved/,
    );
    expect(normalizeVaultGardenerMemoryBaseUrl("http://100.100.10.20:8080/memory", true)).toBe(
      "http://100.100.10.20:8080/memory",
    );
  });

  it("validates the bearer credential through authenticated health", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "ok", index: { ready: true } }));

    const result = await validateVaultGardenerMemoryCredential(
      { baseUrl: "https://memory.example.test/memory" },
      "test-token",
      fetcher as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://memory.example.test/memory/health",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer test-token" }),
      }),
    );
    expect(result).toMatchObject({
      profile: {
        accountId: "https://memory.example.test/memory",
        displayName: "VaultGardener Memory · memory.example.test",
      },
      metadata: { apiBaseUrl: "https://memory.example.test/memory", status: "ok" },
    });
  });

  it("preserves the complete search response and sends the stable session id", async () => {
    const payload = {
      results: [{ memory_id: "memory-1", source_file: "Projects/example.md" }],
      reflex: { feelings: [{ name: "relevant" }], activations: { projects: 0.8 } },
    };
    const fetcher = vi.fn(async () => Response.json(payload));
    const context = createVaultGardenerMemoryContext(
      { baseUrl: "https://memory.example.test/memory" },
      "test-token",
      fetcher as typeof fetch,
    );

    await expect(
      vaultGardenerMemoryActionHandlers.memory_search!({ query: "Roy Hill decisions", session_id: "task-42" }, context),
    ).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      "https://memory.example.test/memory/v1/knowledge/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "Roy Hill decisions", session_id: "task-42" }),
      }),
    );
  });

  it("requires a memory identity for feedback and URL-encodes session resets", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const context = createVaultGardenerMemoryContext(
      { baseUrl: "https://memory.example.test/memory" },
      "test-token",
      fetcher as typeof fetch,
    );

    expect(() =>
      vaultGardenerMemoryActionHandlers.memory_feedback!({ session_id: "task-42", verdict: "useful" }, context),
    ).toThrow(ProviderRequestError);
    await expect(
      vaultGardenerMemoryActionHandlers.memory_session_reset!({ session_id: "task/42" }, context),
    ).resolves.toEqual({ session_id: "task/42", reset: true, response: null });
    expect(fetcher).toHaveBeenCalledWith(
      "https://memory.example.test/memory/v1/sessions/task%2F42",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
