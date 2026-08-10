import type { MicrosoftTodoRuntimeDeps } from "./graph-client.ts";

import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { credentialValidators, microsoftTodoActionHandlers } from "./executors.ts";

describe("Microsoft To Do executors", () => {
  it("lists tasks with encoded IDs, OData options, and normalized pagination", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        value: [{ id: "task-1", title: "Review delivery plan" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/todo/lists/list%201/tasks?$skiptoken=next",
      }),
    );

    await expect(
      microsoftTodoActionHandlers.list_tasks!(
        {
          taskListId: "list 1",
          top: 50,
          filter: "status ne 'completed'",
          orderby: "dueDateTime/dateTime asc",
          select: ["id", "title", "status", "dueDateTime"],
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({
      tasks: [{ id: "task-1", title: "Review delivery plan" }],
      nextLink: "https://graph.microsoft.com/v1.0/me/todo/lists/list%201/tasks?$skiptoken=next",
    });

    const [request] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/me/todo/lists/list%201/tasks");
    expect(url.searchParams.get("$top")).toBe("50");
    expect(url.searchParams.get("$filter")).toBe("status ne 'completed'");
    expect(url.searchParams.get("$orderby")).toBe("dueDateTime/dateTime asc");
    expect(url.searchParams.get("$select")).toBe("id,title,status,dueDateTime");
  });

  it("creates a task with Graph body, schedule, category, and linked-resource fields", async () => {
    const fetcher = createFetch(async () =>
      Response.json({ id: "task-1", title: "Review delivery plan" }, { status: 201 }),
    );

    await expect(
      microsoftTodoActionHandlers.create_task!(
        {
          taskListId: "list 1",
          title: "Review delivery plan",
          body: "Open the <strong>project plan</strong>.",
          categories: ["Roy Hill"],
          dueDateTime: { dateTime: "2026-08-12T17:00:00", timeZone: "W. Australia Standard Time" },
          importance: "high",
          linkedResources: [
            {
              applicationName: "Open Connector",
              displayName: "Project plan",
              webUrl: "https://example.com/projects/2158",
              externalId: "2158",
            },
          ],
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({ id: "task-1", title: "Review delivery plan" });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/me/todo/lists/list%201/tasks");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Review delivery plan",
      body: { content: "Open the <strong>project plan</strong>.", contentType: "html" },
      categories: ["Roy Hill"],
      dueDateTime: { dateTime: "2026-08-12T17:00:00", timeZone: "W. Australia Standard Time" },
      importance: "high",
      linkedResources: [
        {
          applicationName: "Open Connector",
          displayName: "Project plan",
          webUrl: "https://example.com/projects/2158",
          externalId: "2158",
        },
      ],
    });
  });

  it("rejects pagination URLs outside the expected Graph To Do endpoint", async () => {
    const fetcher = createFetch(async () => Response.json({ value: [] }));

    await expect(
      microsoftTodoActionHandlers.list_tasks!(
        {
          taskListId: "list-1",
          nextLink: "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=secret",
        },
        createDeps(fetcher),
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ProviderRequestError>>({ status: 400 }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("updates and deletes the requested task with optimistic concurrency", async () => {
    const fetcher = createFetch(async (_request, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: "task-1", status: "completed" }),
    );
    const deps = createDeps(fetcher);

    await expect(
      microsoftTodoActionHandlers.update_task!(
        {
          taskListId: "list 1",
          taskId: "task 1",
          status: "completed",
          ifMatch: 'W/"task-version"',
        },
        deps,
      ),
    ).resolves.toEqual({ id: "task-1", status: "completed" });
    await expect(
      microsoftTodoActionHandlers.delete_task!(
        {
          taskListId: "list 1",
          taskId: "task 1",
          ifMatch: 'W/"task-version-2"',
        },
        deps,
      ),
    ).resolves.toEqual({ success: true });

    const [updateRequest, updateInit] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(updateRequest instanceof Request ? updateRequest.url : updateRequest.toString()).pathname).toBe(
      "/v1.0/me/todo/lists/list%201/tasks/task%201",
    );
    expect(updateInit?.method).toBe("PATCH");
    expect(new Headers(updateInit?.headers).get("if-match")).toBe('W/"task-version"');
    expect(JSON.parse(String(updateInit?.body))).toEqual({ status: "completed" });

    const [, deleteInit] = vi.mocked(fetcher).mock.calls[1]!;
    expect(deleteInit?.method).toBe("DELETE");
    expect(new Headers(deleteInit?.headers).get("if-match")).toBe('W/"task-version-2"');
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

function createDeps(fetcher: typeof fetch): MicrosoftTodoRuntimeDeps {
  return {
    accessToken: "access-token",
    tokenType: "Bearer",
    fetcher,
  };
}

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
