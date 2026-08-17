import { describe, expect, it, vi } from "vitest";
import { stackOverflowActionHandlers, validateStackOverflowCredential } from "./runtime.ts";

describe("Stack Overflow Internal executors", () => {
  it("validates a PAT against the configured team and current user", async () => {
    const fetcher = createFetch(async () =>
      Response.json({ items: [{ user_id: 42, display_name: "Zeke Tierney", reputation: 2158 }] }),
    );

    await expect(validateStackOverflowCredential("pat-token", "sgc-australia", fetcher)).resolves.toEqual({
      profile: {
        accountId: "stack-overflow:sgc-australia:42",
        displayName: "Zeke Tierney · sgc-australia",
      },
      grantedScopes: [],
      metadata: { team: "sgc-australia", userId: 42 },
    });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.origin).toBe("https://api.stackoverflowteams.com");
    expect(url.pathname).toBe("/2.3/me");
    expect(url.searchParams.get("team")).toBe("sgc-australia");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(new Headers(init?.headers).get("x-api-access-token")).toBe("pat-token");
  });

  it("searches with normalized tags and exposes wrapper pagination", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        items: [{ question_id: 2158, title: "Schedule Planning exception", body: "Failure details" }],
        has_more: true,
        quota_remaining: 999,
        quota_max: 1000,
        backoff: 2,
      }),
    );

    await expect(
      stackOverflowActionHandlers.search_questions!(
        { q: "ObjectDisposedException", tagged: ["c#", "devexpress"], page: 2, pageSize: 25 },
        createContext(fetcher),
      ),
    ).resolves.toEqual({
      questions: [{ question_id: 2158, title: "Schedule Planning exception", body: "Failure details" }],
      hasMore: true,
      nextPage: 3,
      quotaRemaining: 999,
      quotaMax: 1000,
      backoffSeconds: 2,
    });

    const [request] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/2.3/search/advanced");
    expect(url.searchParams.get("q")).toBe("ObjectDisposedException");
    expect(url.searchParams.get("tagged")).toBe("c#;devexpress");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pagesize")).toBe("25");
    expect(url.searchParams.get("filter")).toBe("withbody");
  });

  it("creates a question with a form body while keeping the PAT out of the URL", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        items: [{ question_id: 2158, title: "How do I fix this?", body: "Failure details", tags: ["c#"] }],
      }),
    );

    await expect(
      stackOverflowActionHandlers.create_question!(
        { title: "How do I fix this?", body: "Failure details", tags: ["c#", "devexpress"] },
        createContext(fetcher),
      ),
    ).resolves.toEqual({
      question: { question_id: 2158, title: "How do I fix this?", body: "Failure details", tags: ["c#"] },
    });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/2.3/questions/add");
    expect(url.searchParams.get("team")).toBe("sgc-australia");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("title")).toBe("How do I fix this?");
    expect(form.get("body")).toBe("Failure details");
    expect(form.get("tags")).toBe("c#;devexpress");
  });

  it("maps an invalid PAT wrapper to an authorization error", async () => {
    const fetcher = createFetch(async () =>
      Response.json(
        { error_id: 402, error_name: "invalid_access_token", error_message: "The access token is invalid." },
        { status: 400 },
      ),
    );

    await expect(stackOverflowActionHandlers.get_current_user!({}, createContext(fetcher))).rejects.toMatchObject({
      status: 401,
      message: "The access token is invalid.",
    });
  });
});

function createContext(fetcher: typeof fetch) {
  return {
    personalAccessToken: "pat-token",
    team: "sgc-australia",
    fetcher,
  };
}

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
