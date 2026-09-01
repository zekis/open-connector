import type { MicrosoftGraphAdminRuntimeDeps } from "./graph-client.ts";

import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { credentialValidators, microsoftGraphAdminActionHandlers } from "./executors.ts";

describe("Microsoft Graph Admin executors", () => {
  it("lists users with advanced query headers and normalized pagination", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        value: [{ id: "user-1", displayName: "Alex" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=next",
      }),
    );

    await expect(
      microsoftGraphAdminActionHandlers.list_users!(
        { top: 25, search: '"displayName:Alex"', count: true },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({
      users: [{ id: "user-1", displayName: "Alex" }],
      nextLink: "https://graph.microsoft.com/v1.0/users?$skiptoken=next",
    });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/users");
    expect(url.searchParams.get("$top")).toBe("25");
    expect(url.searchParams.get("$search")).toBe('"displayName:Alex"');
    expect(url.searchParams.get("$count")).toBe("true");
    expect(new Headers(init?.headers).get("ConsistencyLevel")).toBe("eventual");
  });

  it("creates, updates, and deletes user accounts with encoded identifiers", async () => {
    const fetcher = createFetch(async (request, init) => {
      const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
      if (init?.method === "PATCH" || init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: path === "/v1.0/users" ? "created-user" : "updated-user" }, { status: 201 });
    });
    const deps = createDeps(fetcher);

    await microsoftGraphAdminActionHandlers.create_user!(
      {
        accountEnabled: true,
        displayName: "New User",
        mailNickname: "new.user",
        userPrincipalName: "new.user@example.com",
        passwordProfile: { password: "temporary-password", forceChangePasswordNextSignIn: true },
      },
      deps,
    );
    await expect(
      microsoftGraphAdminActionHandlers.update_user!(
        { userId: "new.user@example.com", department: "Operations", usageLocation: "AU" },
        deps,
      ),
    ).resolves.toEqual({ id: "updated-user" });
    await expect(
      microsoftGraphAdminActionHandlers.delete_user!({ userId: "new.user@example.com" }, deps),
    ).resolves.toEqual({ deleted: true, userId: "new.user@example.com" });

    const [updateRequest, updateInit] = vi.mocked(fetcher).mock.calls[1]!;
    expect(new URL(updateRequest instanceof Request ? updateRequest.url : updateRequest.toString()).pathname).toBe(
      "/v1.0/users/new.user%40example.com",
    );
    expect(JSON.parse(String(updateInit?.body))).toEqual({ department: "Operations", usageLocation: "AU" });
    const [deleteRequest] = vi.mocked(fetcher).mock.calls[3]!;
    expect(new URL(deleteRequest instanceof Request ? deleteRequest.url : deleteRequest.toString()).pathname).toBe(
      "/v1.0/users/new.user%40example.com",
    );
  });

  it("assigns and removes licenses in one Microsoft Graph request", async () => {
    const fetcher = createFetch(async () => Response.json({ id: "user-1", assignedLicenses: [] }));

    await microsoftGraphAdminActionHandlers.assign_user_licenses!(
      {
        userId: "user-1",
        addLicenses: [{ skuId: "11111111-1111-1111-1111-111111111111", disabledPlans: [] }],
        removeLicenses: ["22222222-2222-2222-2222-222222222222"],
      },
      createDeps(fetcher),
    );

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(request instanceof Request ? request.url : request.toString()).pathname).toBe(
      "/v1.0/users/user-1/assignLicense",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      addLicenses: [{ skuId: "11111111-1111-1111-1111-111111111111", disabledPlans: [] }],
      removeLicenses: ["22222222-2222-2222-2222-222222222222"],
    });
  });

  it("uses dedicated operations for account blocking and password resets", async () => {
    const fetcher = createFetch(async () => new Response(null, { status: 204 }));
    const deps = createDeps(fetcher);

    await expect(
      microsoftGraphAdminActionHandlers.set_user_account_enabled!(
        { userId: "user@example.com", accountEnabled: false },
        deps,
      ),
    ).resolves.toEqual({ updated: true, userId: "user@example.com", accountEnabled: false });
    await expect(
      microsoftGraphAdminActionHandlers.reset_user_password!(
        {
          userId: "user@example.com",
          passwordProfile: { password: "replacement-password", forceChangePasswordNextSignIn: true },
        },
        deps,
      ),
    ).resolves.toEqual({ updated: true, userId: "user@example.com" });

    expect(vi.mocked(fetcher).mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { accountEnabled: false },
      { passwordProfile: { password: "replacement-password", forceChangePasswordNextSignIn: true } },
    ]);
  });

  it("rejects pagination URLs outside the expected administration endpoint", async () => {
    const fetcher = createFetch(async () => Response.json({ value: [] }));
    await expect(
      microsoftGraphAdminActionHandlers.list_users!(
        { nextLink: "https://graph.microsoft.com/v1.0/groups?$skiptoken=secret" },
        createDeps(fetcher),
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ProviderRequestError>>({ status: 400 }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the signed-in administrator as the connection profile", async () => {
    const fetcher = createFetch(async () =>
      Response.json({ id: "admin-1", displayName: "Tenant Admin", userPrincipalName: "admin@example.com" }),
    );
    await expect(
      credentialValidators.oauth2!(
        {
          authType: "oauth2",
          accessToken: "access-token",
          tokenType: "Bearer",
          profile: { accountId: "pending", displayName: "pending", grantedScopes: [] },
          metadata: {},
        },
        { fetcher },
      ),
    ).resolves.toMatchObject({ profile: { accountId: "admin-1", displayName: "admin@example.com" } });
  });
});

function createDeps(fetcher: typeof fetch): MicrosoftGraphAdminRuntimeDeps {
  return { accessToken: "access-token", tokenType: "Bearer", fetcher };
}

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
