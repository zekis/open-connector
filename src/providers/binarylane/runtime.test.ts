import type { ApiKeyProviderContext, ProviderFetch } from "../provider-runtime.ts";

import { describe, expect, it, vi } from "vitest";
import { binaryLaneActionHandlers, validateBinaryLaneCredential } from "./runtime.ts";

describe("BinaryLane runtime", () => {
  it("validates a Nova API key and returns the account identity", async () => {
    const fetcher = createJsonFetch({
      account: {
        email: "owner@example.com",
        status: "active",
        email_verified: true,
        two_factor_authentication_enabled: true,
      },
    });

    const result = await validateBinaryLaneCredential("nova-token", fetcher);

    expect(result).toEqual({
      profile: {
        accountId: "owner@example.com",
        displayName: "owner@example.com",
      },
      grantedScopes: [],
      metadata: {
        validationEndpoint: "/account",
        accountStatus: "active",
        emailVerified: true,
        twoFactorAuthenticationEnabled: true,
      },
    });
    const [input, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(input instanceof Request ? input.url : input.toString()).pathname).toBe("/v2/account");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer nova-token");
  });

  it("maps server filters and pagination onto BinaryLane query parameters", async () => {
    const fetcher = createJsonFetch({ servers: [{ id: 42, name: "api-1" }], meta: { total: 1 }, links: null });

    const result = await binaryLaneActionHandlers.list_servers!(
      { hostname: "api-1", page: 2, perPage: 50 },
      createContext(fetcher),
    );

    expect(result).toEqual({ servers: [{ id: 42, name: "api-1" }], meta: { total: 1 }, links: null });
    const [input] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.pathname).toBe("/v2/servers");
    expect(Object.fromEntries(url.searchParams)).toEqual({ hostname: "api-1", page: "2", per_page: "50" });
  });

  it("sends each server command as an exact action payload", async () => {
    const action = { id: 91, type: "power_off", status: "in-progress" };
    const fetcher = createJsonFetch({ action });

    const result = await binaryLaneActionHandlers.power_off_server!({ serverId: 42 }, createContext(fetcher));

    expect(result).toEqual({ accepted: true, action });
    const [input, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(input instanceof Request ? input.url : input.toString()).pathname).toBe("/v2/servers/42/actions");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ type: "power_off" });
  });

  it("accepts BinaryLane's empty 202 command response", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => new Response(null, { status: 202 })) as ProviderFetch;

    const result = await binaryLaneActionHandlers.reboot_server!({ serverId: 42 }, createContext(fetcher));

    expect(result).toEqual({ accepted: true, action: null });
  });
});

function createContext(fetcher: ProviderFetch): ApiKeyProviderContext {
  return { apiKey: "nova-token", fetcher };
}

function createJsonFetch(payload: unknown, status = 200): ProviderFetch {
  return vi.fn(async (): Promise<Response> => {
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as ProviderFetch;
}
