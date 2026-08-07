import type { SharePointRuntimeDeps } from "./graph-client.ts";

import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { credentialValidators, sharePointActionHandlers } from "./executors.ts";

describe("SharePoint executors", () => {
  it("maps site search onto the Microsoft Graph sites endpoint", async () => {
    const fetcher = createFetch(async () => Response.json({ value: [{ id: "site-1", displayName: "Projects" }] }));

    await expect(sharePointActionHandlers.search_sites!({ query: "Roy Hill" }, createDeps(fetcher))).resolves.toEqual({
      items: [{ id: "site-1", displayName: "Projects" }],
      nextLink: null,
    });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/sites");
    expect(url.searchParams.get("search")).toBe("Roy Hill");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
  });

  it("rejects a nextLink outside Microsoft Graph before sending credentials", async () => {
    const fetcher = createFetch(async () => Response.json({ value: [] }));

    await expect(
      sharePointActionHandlers.list_folder_children!(
        { driveId: "drive-1", nextLink: "https://example.com/v1.0/drives/drive-1/root/children" },
        createDeps(fetcher),
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ProviderRequestError>>({ status: 400 }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uploads UTF-8 text to an encoded document-library path", async () => {
    const fetcher = createFetch(async () => Response.json({ id: "item-1", name: "report #1.csv" }, { status: 201 }));

    await expect(
      sharePointActionHandlers.upload_file!(
        {
          driveId: "drive 1",
          folderPath: "/Project Files/2026",
          name: "report #1.csv",
          mimeType: "text/csv",
          text: "name,status\nRoy Hill,active\n",
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({ id: "item-1", name: "report #1.csv" });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/drives/drive%201/root:/Project%20Files/2026/report%20%231.csv:/content");
    expect(url.searchParams.get("@microsoft.graph.conflictBehavior")).toBe("replace");
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("content-type")).toBe("text/csv");
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe("name,status\nRoy Hill,active\n");
  });

  it("updates only the supplied SharePoint list fields with an optional eTag", async () => {
    const fetcher = createFetch(async () => Response.json({ Title: "Ready", Progress: 100 }));

    await expect(
      sharePointActionHandlers.update_list_item_fields!(
        {
          siteId: "site-1",
          listId: "Project Tasks",
          itemId: "42",
          fields: { Title: "Ready", Progress: 100 },
          ifMatch: '"etag-1"',
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({ Title: "Ready", Progress: 100 });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/sites/site-1/lists/Project%20Tasks/items/42/fields");
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("if-match")).toBe('"etag-1"');
    expect(JSON.parse(String(init?.body))).toEqual({ Title: "Ready", Progress: 100 });
  });

  it("uses the connected Microsoft account as the credential profile", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        id: "user-1",
        displayName: "Zeke Tierney",
        mail: "zeke@example.com",
        userPrincipalName: "zeke@example.com",
      }),
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
    ).resolves.toMatchObject({
      profile: { accountId: "user-1", displayName: "zeke@example.com" },
    });
  });
});

function createDeps(fetcher: typeof fetch): SharePointRuntimeDeps {
  return {
    accessToken: "access-token",
    tokenType: "Bearer",
    fetcher,
  };
}

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
