import type { TransitFileWriter } from "../../core/types.ts";
import type { AzureDevOpsRuntimeDeps } from "./client.ts";

import { describe, expect, it, vi } from "vitest";
import { azureDevOpsActionHandlers, credentialValidators, executors } from "./executors.ts";

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

  it("lists Git refs with normalized branch filters and pagination", async () => {
    const fetcher = createFetch(async () =>
      Response.json(
        { count: 1, value: [{ name: "refs/heads/main", objectId: "abc123" }] },
        { headers: { "x-ms-continuationtoken": "next-ref" } },
      ),
    );

    await expect(
      azureDevOpsActionHandlers.list_git_refs!(
        { project: "Delivery", repository: "YardCraft", filter: "refs/heads/", top: 25 },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({
      refs: [{ name: "refs/heads/main", objectId: "abc123" }],
      nextCursor: "next-ref",
    });

    const [request] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/sgc-australia/Delivery/_apis/git/repositories/YardCraft/refs");
    expect(url.searchParams.get("filter")).toBe("heads/");
    expect(url.searchParams.get("$top")).toBe("25");
  });

  it("browses a bounded repository tree at a selected branch", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        count: 3,
        value: [
          { path: "/src", isFolder: true },
          { path: "/src/index.ts", isFolder: false },
          { path: "/src/runtime.ts", isFolder: false },
        ],
      }),
    );

    await expect(
      azureDevOpsActionHandlers.list_repository_items!(
        {
          project: "Delivery",
          repository: "YardCraft",
          scopePath: "/src",
          recursionLevel: "full",
          version: "main",
          versionType: "branch",
          maxItems: 2,
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({
      items: [
        { path: "/src", isFolder: true },
        { path: "/src/index.ts", isFolder: false },
      ],
      totalCount: 3,
      truncated: true,
    });

    const [request] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.searchParams.get("scopePath")).toBe("/src");
    expect(url.searchParams.get("recursionLevel")).toBe("full");
    expect(url.searchParams.get("includeContentMetadata")).toBe("true");
    expect(url.searchParams.get("versionDescriptor.version")).toBe("main");
    expect(url.searchParams.get("versionDescriptor.versionType")).toBe("branch");
  });

  it("reads a bounded line range without returning duplicate full-file content", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        objectId: "blob-1",
        commitId: "commit-1",
        path: "/src/index.ts",
        isFolder: false,
        contentMetadata: { contentType: "text/plain", isBinary: false },
        content: "line 1\nline 2\nline 3\nline 4",
      }),
    );

    await expect(
      azureDevOpsActionHandlers.read_repository_file!(
        {
          project: "Delivery",
          repository: "YardCraft",
          path: "/src/index.ts",
          version: "commit-1",
          versionType: "commit",
          startLine: 2,
          lineCount: 2,
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({
      item: {
        objectId: "blob-1",
        commitId: "commit-1",
        path: "/src/index.ts",
        isFolder: false,
        contentMetadata: { contentType: "text/plain", isBinary: false },
      },
      content: "line 2\nline 3",
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      nextStartLine: 4,
      truncated: true,
    });

    const [request] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.searchParams.get("path")).toBe("/src/index.ts");
    expect(url.searchParams.get("includeContent")).toBe("true");
    expect(url.searchParams.get("versionDescriptor.versionType")).toBe("commit");
  });

  it("downloads a versioned repository ZIP into transit file storage", async () => {
    const fetcher = createFetch(
      async () => new Response(Uint8Array.from([80, 75, 3, 4]), { headers: { "content-type": "application/zip" } }),
    );
    const create = vi.fn(async (file: File) => ({
      fileId: "archive-1",
      downloadUrl: "/api/files/archive-1",
      sizeBytes: file.size,
      name: file.name,
      mimeType: file.type,
    }));
    const transitFiles: TransitFileWriter = {
      maxBytes: 1024,
      create,
      async read() {
        throw new Error("not used");
      },
      async delete() {
        return false;
      },
    };

    await expect(
      azureDevOpsActionHandlers.download_repository_archive!(
        {
          project: "Delivery",
          repository: "YardCraft API",
          version: "release/1.0",
          versionType: "branch",
          zipForUnix: true,
        },
        createDeps(fetcher, transitFiles),
      ),
    ).resolves.toEqual({
      archive: {
        fileId: "archive-1",
        downloadUrl: "/api/files/archive-1",
        sizeBytes: 4,
        name: "YardCraft-API-release-1.0.zip",
        mimeType: "application/zip",
      },
    });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.searchParams.get("$format")).toBe("zip");
    expect(url.searchParams.get("scopePath")).toBe("/");
    expect(url.searchParams.get("zipForUnix")).toBe("true");
    expect(new Headers(init?.headers).get("accept")).toBe("application/zip");
    expect(create).toHaveBeenCalledOnce();
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

  it("uploads a transit file and attaches it to a work item in one action", async () => {
    const attachmentUrl =
      "https://dev.azure.com/sgc-australia/Delivery/_apis/wit/attachments/attachment-1?fileName=screenshot.png";
    const fetcher = createFetch(async (request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname.endsWith("/_apis/wit/attachments")) {
        return Response.json({ id: "attachment-1", url: attachmentUrl });
      }
      return Response.json({ id: 2158, rev: 8, relations: [{ rel: "AttachedFile", url: attachmentUrl }] });
    });
    const transitFiles: TransitFileWriter = {
      maxBytes: 1024,
      async create() {
        throw new Error("not used");
      },
      async read(fileId) {
        expect(fileId).toBe("image-1");
        const file = new File([Uint8Array.from([137, 80, 78, 71])], "screenshot.png", { type: "image/png" });
        return { file, sizeBytes: file.size, name: file.name, mimeType: file.type };
      },
      async delete() {
        return false;
      },
    };

    await expect(
      azureDevOpsActionHandlers.add_work_item_attachment!(
        {
          project: "Delivery",
          id: 2158,
          file: { fileId: "image-1" },
          comment: "Failure shown in Schedule Planning",
          revision: 7,
        },
        createDeps(fetcher, transitFiles),
      ),
    ).resolves.toEqual({
      attachment: { id: "attachment-1", url: attachmentUrl },
      workItem: { id: 2158, rev: 8, relations: [{ rel: "AttachedFile", url: attachmentUrl }] },
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [uploadRequest, uploadInit] = vi.mocked(fetcher).mock.calls[0]!;
    const uploadUrl = new URL(uploadRequest instanceof Request ? uploadRequest.url : uploadRequest.toString());
    expect(uploadUrl.pathname).toBe("/sgc-australia/Delivery/_apis/wit/attachments");
    expect(uploadUrl.searchParams.get("fileName")).toBe("screenshot.png");
    expect(uploadInit?.method).toBe("POST");
    expect(new Headers(uploadInit?.headers).get("content-type")).toBe("application/octet-stream");
    const uploadBody = uploadInit?.body;
    expect(uploadBody).toBeInstanceOf(File);
    if (!(uploadBody instanceof File)) throw new Error("Expected Azure DevOps upload body to be a File.");
    expect(Array.from(new Uint8Array(await uploadBody.arrayBuffer()))).toEqual([137, 80, 78, 71]);

    const [updateRequest, updateInit] = vi.mocked(fetcher).mock.calls[1]!;
    const updateUrl = new URL(updateRequest instanceof Request ? updateRequest.url : updateRequest.toString());
    expect(updateUrl.pathname).toBe("/sgc-australia/Delivery/_apis/wit/workitems/2158");
    expect(updateInit?.method).toBe("PATCH");
    expect(new Headers(updateInit?.headers).get("content-type")).toBe("application/json-patch+json");
    expect(JSON.parse(String(updateInit?.body))).toEqual([
      { op: "test", path: "/rev", value: 7 },
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "AttachedFile",
          url: attachmentUrl,
          attributes: { comment: "Failure shown in Schedule Planning" },
        },
      },
    ]);
  });

  it("rejects a legacy OAuth connection before executing an action", async () => {
    await expect(
      executors["azure_devops.list_projects"]!(
        {},
        {
          async getCredential() {
            return {
              authType: "oauth2",
              accessToken: "access-token",
              tokenType: "Bearer",
              profile: { accountId: "user-1", displayName: "Zeke Tierney", grantedScopes: [] },
              metadata: {},
            };
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
        message: "Configure a personal access token for this provider first.",
      },
    });
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

function createDeps(fetcher: typeof fetch, transitFiles?: TransitFileWriter): AzureDevOpsRuntimeDeps {
  const deps: AzureDevOpsRuntimeDeps = {
    authorization: "Basic pat-token",
    organization: "sgc-australia",
    fetcher,
  };
  if (transitFiles) deps.transitFiles = transitFiles;
  return deps;
}

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
