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
      results: [{ id: 1, source_file: "Projects/example.md" }],
      reflex: { feeling: "relevant", active_regions: [{ name: "projects", activation: 0.8 }] },
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

  it("reads the learned map and session state without changing activation", async () => {
    const mapPayload = {
      counts: { memories: 4, concepts: 2, associations: 1, triggers: 1, pathways: 1 },
      regions: [{ id: 7, name: "Roy Hill", urgency: 0.8 }],
    };
    const sessionPayload = {
      session_id: "task/42",
      feeling: "focused",
      active_regions: [{ id: 7, name: "Roy Hill", activation: 0.7 }],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(mapPayload))
      .mockResolvedValueOnce(Response.json(sessionPayload));
    const context = createVaultGardenerMemoryContext(
      { baseUrl: "https://memory.example.test/memory" },
      "test-token",
      fetcher as typeof fetch,
    );

    await expect(
      vaultGardenerMemoryActionHandlers.memory_map!({ query: "Roy Hill", limit: 18 }, context),
    ).resolves.toEqual(mapPayload);
    await expect(
      vaultGardenerMemoryActionHandlers.memory_session_state!({ session_id: "task/42", limit: 12 }, context),
    ).resolves.toEqual(sessionPayload);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://memory.example.test/memory/v1/memory/map?query=Roy+Hill&limit=18",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://memory.example.test/memory/v1/sessions/task%2F42/state?limit=12",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("passes source-specific metadata through memory capture", async () => {
    const payload = {
      session_id: "task-42",
      path: "Sources/outlook/message-17.md",
      created: true,
      index_pending: true,
      content_digest: "digest-17",
    };
    const fetcher = vi.fn(async () => Response.json(payload));
    const context = createVaultGardenerMemoryContext(
      { baseUrl: "https://memory.example.test/memory" },
      "test-token",
      fetcher as typeof fetch,
    );

    await expect(
      vaultGardenerMemoryActionHandlers.memory_capture!(
        {
          title: "Project update",
          content: "Primary source body",
          source_type: "email",
          source_system: "outlook",
          source_id: "message-17",
          session_id: "task-42",
          occurred_at: "2026-08-14T13:00:00+08:00",
          metadata: { importance: "high", attachments: 2, labels: ["project"] },
        },
        context,
      ),
    ).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      "https://memory.example.test/memory/v1/knowledge/capture",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Project update",
          content: "Primary source body",
          source_type: "email",
          source_system: "outlook",
          source_id: "message-17",
          session_id: "task-42",
          occurred_at: "2026-08-14T13:00:00+08:00",
          metadata: { importance: "high", attachments: 2, labels: ["project"] },
        }),
      }),
    );
  });

  it("supports numeric feedback identities and URL-encodes session resets", async () => {
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
      vaultGardenerMemoryActionHandlers.memory_feedback!(
        { session_id: "task-42", verdict: "useful", memory_id: 17 },
        context,
      ),
    ).resolves.toBeNull();
    await expect(
      vaultGardenerMemoryActionHandlers.memory_session_reset!({ session_id: "task/42" }, context),
    ).resolves.toEqual({ session_id: "task/42", reset: true, response: null });
    expect(fetcher).toHaveBeenCalledWith(
      "https://memory.example.test/memory/v1/memory/feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ session_id: "task-42", verdict: "useful", memory_id: 17 }),
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://memory.example.test/memory/v1/sessions/task%2F42",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("maps curation inspection and queue operations to their REST contracts", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    const context = createVaultGardenerMemoryContext(
      { baseUrl: "https://memory.example.test/memory" },
      "test-token",
      fetcher as typeof fetch,
    );

    await vaultGardenerMemoryActionHandlers.curation_status!({}, context);
    await vaultGardenerMemoryActionHandlers.curation_scan!({ paths: ["Projects/Atlas note.md"], force: true }, context);
    await vaultGardenerMemoryActionHandlers.curation_review!(
      { path: "Projects/Atlas note.md", enqueue_if_missing: false },
      context,
    );
    await vaultGardenerMemoryActionHandlers.curation_list!(
      { status: "pending", action: "archive", limit: 25, offset: 5 },
      context,
    );

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://memory.example.test/memory/v1/curation/status",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://memory.example.test/memory/v1/curation/scan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ paths: ["Projects/Atlas note.md"], force: true }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "https://memory.example.test/memory/v1/curation/review?path=Projects%2FAtlas+note.md&enqueue_if_missing=false",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "https://memory.example.test/memory/v1/curation/proposals?status=pending&action=archive&limit=25&offset=5",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps each explicit curation decision to one proposal instance", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 17, status: "applied" }));
    const context = createVaultGardenerMemoryContext(
      { baseUrl: "https://memory.example.test/memory" },
      "test-token",
      fetcher as typeof fetch,
    );

    await vaultGardenerMemoryActionHandlers.curation_approve!(
      { proposal_id: 17, reviewed_by: "Zeke", notes: "Confirmed", apply: false },
      context,
    );
    await vaultGardenerMemoryActionHandlers.curation_reject!(
      { proposal_id: 18, reviewed_by: "Zeke", notes: "Keep active" },
      context,
    );
    await vaultGardenerMemoryActionHandlers.curation_undo!(
      { proposal_id: 19, requested_by: "Zeke", notes: "Restore note" },
      context,
    );

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://memory.example.test/memory/v1/curation/proposals/17/approve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reviewed_by: "Zeke", notes: "Confirmed", apply: false }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://memory.example.test/memory/v1/curation/proposals/18/reject",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reviewed_by: "Zeke", notes: "Keep active" }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "https://memory.example.test/memory/v1/curation/proposals/19/undo",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ requested_by: "Zeke", notes: "Restore note" }),
      }),
    );
    expect(() =>
      vaultGardenerMemoryActionHandlers.curation_approve!(
        { proposal_id: 0, reviewed_by: "Zeke", apply: true },
        context,
      ),
    ).toThrow(ProviderRequestError);
  });
});
