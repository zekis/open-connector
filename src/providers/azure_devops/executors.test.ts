import type { AzureDevOpsRuntimeDeps } from "./client.ts";

import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { azureDevOpsActionHandlers, credentialValidators } from "./executors.ts";

describe("Azure DevOps executors", () => {
  it("lists projects using the PAT connection organization and continuation token", async () => {
    const fetcher = createFetch(async () =>
      Response.json(
        { count: 1, value: [{ id: "project-1", name: "Roy Hill" }] },
        { headers: { "x-ms-continuationtoken": "42" } },
      ),
    );

    await expect(azureDevOpsActionHandlers.list_projects!({ top: 10 }, createDeps(fetcher))).resolves.toEqual({
      projects: [{ id: "project-1", name: "Roy Hill" }],
      nextCursor: "42",
    });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.origin).toBe("https://dev.azure.com");
    expect(url.pathname).toBe("/sgc-australia/_apis/projects");
    expect(url.searchParams.get("$top")).toBe("10");
    expect(url.searchParams.get("api-version")).toBe("7.1");
    expect(new Headers(init?.headers).get("authorization")).toBe("Basic pat-token");
  });

  it("hydrates WIQL references into complete work items", async () => {
    const fetcher = createFetch(async (request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname.endsWith("/_apis/wit/wiql")) {
        return Response.json({
          queryType: "flat",
          columns: [{ referenceName: "System.Id" }],
          workItems: [{ id: 2158, url: "https://dev.azure.com/sgc/_apis/wit/workItems/2158" }],
        });
      }
      return Response.json({
        count: 1,
        value: [{ id: 2158, rev: 7, fields: { "System.Title": "Roy Hill" } }],
      });
    });

    await expect(
      azureDevOpsActionHandlers.query_work_items!(
        {
          project: "Delivery",
          wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 2158",
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({
      workItems: [{ id: 2158, rev: 7, fields: { "System.Title": "Roy Hill" } }],
      relations: [],
      columns: [{ referenceName: "System.Id" }],
      queryType: "flat",
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [wiqlRequest, wiqlInit] = vi.mocked(fetcher).mock.calls[0]!;
    const wiqlUrl = new URL(wiqlRequest instanceof Request ? wiqlRequest.url : wiqlRequest.toString());
    expect(wiqlUrl.pathname).toBe("/sgc-australia/Delivery/_apis/wit/wiql");
    expect(JSON.parse(String(wiqlInit?.body))).toEqual({
      query: "SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 2158",
    });
    const [detailsRequest] = vi.mocked(fetcher).mock.calls[1]!;
    const detailsUrl = new URL(detailsRequest instanceof Request ? detailsRequest.url : detailsRequest.toString());
    expect(detailsUrl.searchParams.get("ids")).toBe("2158");
  });

  it("creates a PBI with convenience and custom fields as JSON Patch", async () => {
    const fetcher = createFetch(async () => Response.json({ id: 2158, rev: 1 }, { status: 200 }));

    await expect(
      azureDevOpsActionHandlers.create_work_item!(
        {
          project: "Delivery",
          type: "Product Backlog Item",
          title: "Archive Roy Hill emails",
          assignedTo: "zeke@example.com",
          tags: ["Obsidian", "Email"],
          fields: { "Microsoft.VSTS.Common.Priority": 1 },
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({ workItem: { id: 2158, rev: 1 } });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/sgc-australia/Delivery/_apis/wit/workitems/$Product%20Backlog%20Item");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json-patch+json");
    expect(JSON.parse(String(init?.body))).toEqual([
      { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 1 },
      { op: "add", path: "/fields/System.Title", value: "Archive Roy Hill emails" },
      { op: "add", path: "/fields/System.AssignedTo", value: "zeke@example.com" },
      { op: "add", path: "/fields/System.Tags", value: "Obsidian; Email" },
    ]);
  });

  it("updates work item fields with optimistic concurrency and JSON Pointer escaping", async () => {
    const fetcher = createFetch(async () => Response.json({ id: 2158, rev: 8 }));

    await expect(
      azureDevOpsActionHandlers.update_work_item!(
        {
          project: "Delivery",
          id: 2158,
          revision: 7,
          fields: { "Custom/Obsidian~Path": "SGC Australia/2158 - Roy Hill" },
          removeFields: ["System.Description"],
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({ workItem: { id: 2158, rev: 8 } });

    const [, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual([
      { op: "test", path: "/rev", value: 7 },
      { op: "add", path: "/fields/Custom~1Obsidian~0Path", value: "SGC Australia/2158 - Roy Hill" },
      { op: "remove", path: "/fields/System.Description" },
    ]);
  });

  it("rejects an OAuth action without an organization before sending credentials", async () => {
    const fetcher = createFetch(async () => Response.json({ value: [] }));

    await expect(
      azureDevOpsActionHandlers.list_projects!({}, { authorization: "Bearer access-token", fetcher }),
    ).rejects.toEqual(expect.objectContaining<Partial<ProviderRequestError>>({ status: 400 }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the Azure DevOps profile API to identify an OAuth connection", async () => {
    const fetcher = createFetch(async () =>
      Response.json({ id: "user-1", displayName: "Zeke Tierney", emailAddress: "zeke@example.com" }),
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

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.origin).toBe("https://app.vssps.visualstudio.com");
    expect(url.pathname).toBe("/_apis/profile/profiles/me");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
  });

  it("validates a PAT against its configured organization with Basic authentication", async () => {
    const fetcher = createFetch(async () => Response.json({ count: 0, value: [] }));

    await expect(
      credentialValidators.apiKey!(
        { apiKey: "personal-access-token", values: { organization: "SGC-Australia" } },
        { fetcher },
      ),
    ).resolves.toMatchObject({
      profile: { accountId: "azure-devops:sgc-australia", displayName: "SGC-Australia" },
      metadata: { organization: "SGC-Australia" },
    });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/SGC-Australia/_apis/projects");
    expect(new Headers(init?.headers).get("authorization")).toBe("Basic OnBlcnNvbmFsLWFjY2Vzcy10b2tlbg==");
  });
});

function createDeps(fetcher: typeof fetch): AzureDevOpsRuntimeDeps {
  return {
    authorization: "Basic pat-token",
    organization: "sgc-australia",
    fetcher,
  };
}

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
