import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import {
  assetGatewayActionHandlers,
  createAssetGatewayContext,
  normalizeAssetGatewayApiBaseUrl,
  validateAssetGatewayCredential,
} from "./runtime.ts";

describe("Asset Gateway runtime", () => {
  it("validates a management token against metadata", async () => {
    const requests: Request[] = [];
    const fetcher = createAssetGatewayFetch(requests);

    const result = await validateAssetGatewayCredential(
      { baseUrl: "https://assets.example.com/" },
      "dp_test-token",
      fetcher,
    );

    expect(result).toEqual({
      profile: {
        accountId: "asset_gateway:assets.example.com",
        displayName: "Asset Gateway · assets.example.com",
      },
      grantedScopes: [],
      metadata: { apiBaseUrl: "https://assets.example.com/api/v1" },
    });
    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/metadata");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer dp_test-token");
  });

  it("normalizes portal roots and exact management API paths", () => {
    expect(normalizeAssetGatewayApiBaseUrl("https://assets.example.com/")).toBe("https://assets.example.com/api/v1");
    expect(normalizeAssetGatewayApiBaseUrl("https://assets.example.com/portal/api/v1/")).toBe(
      "https://assets.example.com/portal/api/v1",
    );
    expect(() => normalizeAssetGatewayApiBaseUrl("https://assets.example.com/admin")).toThrow(
      "baseUrl must be the portal root or end with /api/v1",
    );
    expect(() => normalizeAssetGatewayApiBaseUrl("http://assets.example.com", false)).toThrow(
      "http baseUrl URLs require private-network access to be enabled",
    );
    expect(normalizeAssetGatewayApiBaseUrl("http://10.20.30.40:8080", true)).toBe("http://10.20.30.40:8080/api/v1");
  });

  it("maps list filters and normalizes pagination", async () => {
    const requests: Request[] = [];
    const context = createAssetGatewayContext(
      { baseUrl: "https://assets.example.com/api/v1" },
      "dp_test-token",
      createAssetGatewayFetch(requests),
    );

    const result = await assetGatewayActionHandlers.list_devices!(
      { q: "laptop", companyName: "Acme", active: false, limit: 25, offset: 50 },
      context,
    );

    expect(result).toEqual({ devices: [{ id: 7, device_label: "Laptop" }], total: 1, limit: 25, offset: 50 });
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/devices");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "laptop",
      company_name: "Acme",
      active: "0",
      limit: "25",
      offset: "50",
    });
  });

  it("sends the current ETag and preserves omitted update fields", async () => {
    const requests: Request[] = [];
    const context = createAssetGatewayContext(
      { baseUrl: "https://assets.example.com/api/v1" },
      "dp_test-token",
      createAssetGatewayFetch(requests),
    );

    const result = await assetGatewayActionHandlers.update_request!(
      {
        requestId: 12,
        etag: '"revision-1"',
        changes: { status: "Delivered", purchased_on: "2026-09-08", delivered_on: "2026-09-09" },
      },
      context,
    );

    expect(result).toEqual({
      request: { id: 12, title: "Laptop", status: "Delivered" },
      revision: "revision-2",
      etag: '"revision-2"',
    });
    const request = requests[0]!;
    expect(request.method).toBe("PATCH");
    expect(new URL(request.url).pathname).toBe("/api/v1/requests/12");
    expect(request.headers.get("if-match")).toBe('"revision-1"');
    expect(await request.json()).toEqual({
      status: "Delivered",
      purchased_on: "2026-09-08",
      delivered_on: "2026-09-09",
    });
  });

  it("normalizes creates, history, and comments", async () => {
    const requests: Request[] = [];
    const context = createAssetGatewayContext(
      { baseUrl: "https://assets.example.com/api/v1" },
      "dp_test-token",
      createAssetGatewayFetch(requests),
    );

    await expect(
      assetGatewayActionHandlers.create_request!(
        { request: { title: "Laptop", recipient: "Alice", asset_type: "Computer" } },
        context,
      ),
    ).resolves.toEqual({
      request: { id: 12, title: "Laptop", recipient: "Alice" },
      revision: "revision-1",
      etag: '"revision-1"',
      location: "/api/v1/requests/12",
    });
    await expect(assetGatewayActionHandlers.list_ticket_history!({ ticketId: 4 }, context)).resolves.toEqual({
      events: [{ id: 9, body: "Investigating" }],
      nextBeforeId: null,
    });
    await expect(
      assetGatewayActionHandlers.add_device_comment!({ deviceId: 7, comment: { body: "Returned" } }, context),
    ).resolves.toEqual({ ok: true });

    expect(await requests[0]!.json()).toEqual({ title: "Laptop", recipient: "Alice", asset_type: "Computer" });
    expect(await requests[2]!.json()).toEqual({ body: "Returned" });
  });

  it("preserves revision conflicts returned by the portal", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> => jsonResponse({ error: "Record changed. Fetch it again before updating." }, 409),
    ) as typeof fetch;
    const context = createAssetGatewayContext(
      { baseUrl: "https://assets.example.com/api/v1" },
      "dp_test-token",
      fetcher,
    );

    await expect(
      assetGatewayActionHandlers.update_ticket!(
        { ticketId: 4, etag: '"old"', changes: { status: "Resolved" } },
        context,
      ),
    ).rejects.toMatchObject({ status: 409, message: "Record changed. Fetch it again before updating." });
  });
});

function createAssetGatewayFetch(requests: Request[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/metadata") {
      return jsonResponse({
        companies: [{ name: "Acme" }],
        asset_types: [{ name: "Computer", kind: "hardware" }],
        asset_templates: [],
        statuses: { requests: ["Requested"], tickets: ["Open"] },
        priorities: ["Low", "Normal", "High", "Urgent"],
      });
    }
    if (url.pathname === "/api/v1/devices") {
      return jsonResponse({ data: [{ id: 7, device_label: "Laptop" }], total: 1, limit: 25, offset: 50 });
    }
    if (url.pathname === "/api/v1/requests/12") {
      return jsonResponse({ data: { id: 12, title: "Laptop", status: "Delivered" }, revision: "revision-2" }, 200, {
        etag: '"revision-2"',
      });
    }
    if (url.pathname === "/api/v1/requests" && request.method === "POST") {
      return jsonResponse({ data: { id: 12, title: "Laptop", recipient: "Alice" }, revision: "revision-1" }, 201, {
        etag: '"revision-1"',
        location: "/api/v1/requests/12",
      });
    }
    if (url.pathname === "/api/v1/tickets/4/history") {
      return jsonResponse({ data: [{ id: 9, body: "Investigating" }], next_before_id: null });
    }
    if (url.pathname === "/api/v1/devices/7/comments") {
      return jsonResponse({ ok: true }, 201);
    }
    throw new ProviderRequestError(500, `Unexpected test request: ${request.method} ${url.pathname}`);
  }) as typeof fetch;
}

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}
