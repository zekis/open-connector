import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import {
  createPaperclipContext,
  normalizePaperclipApiPath,
  normalizePaperclipBaseUrl,
  paperclipActionHandlers,
  validatePaperclipCredential,
} from "./runtime.ts";

describe("Paperclip runtime", () => {
  it("signs in as a board user and validates the returned session", async () => {
    const requests: Request[] = [];
    const fetcher = createPaperclipFetch(requests);

    const result = await validatePaperclipCredential(
      {
        baseUrl: "https://paperclip.example.com/",
        email: "board@example.com",
        password: "test-password",
      },
      fetcher,
    );

    expect(result).toMatchObject({
      profile: {
        accountId: "user-1",
        displayName: "Board User · paperclip.example.com",
      },
      metadata: { baseUrl: "https://paperclip.example.com" },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.get("origin")).toBe("https://paperclip.example.com");
    expect(requests[0]!.headers.get("cookie")).toBeNull();
    expect(await requests[0]!.json()).toEqual({ email: "board@example.com", password: "test-password" });
    expect(requests[1]!.headers.get("cookie")).toBe("paperclip-default.session_token=test-token");
  });

  it("adds the board cookie and trusted origin to mutations", async () => {
    const requests: Request[] = [];
    const fetcher = createPaperclipFetch(requests);
    const context = await createPaperclipContext(
      {
        baseUrl: "https://paperclip.example.com",
        email: "board@example.com",
        password: "test-password",
      },
      fetcher,
    );

    const output = await paperclipActionHandlers.create_issue!(
      {
        companyId: "company-1",
        issue: { title: "Investigate the incident", priority: "high" },
      },
      context,
    );

    expect(output).toEqual({ issue: { id: "issue-1", title: "Investigate the incident" } });
    const request = requests[1]!;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/api/companies/company-1/issues");
    expect(request.headers.get("origin")).toBe("https://paperclip.example.com");
    expect(request.headers.get("cookie")).toBe("paperclip-default.session_token=test-token");
    expect(await request.json()).toEqual({ title: "Investigate the incident", priority: "high" });
  });

  it("requires HTTPS unless private-network access is enabled", () => {
    expect(() => normalizePaperclipBaseUrl("http://paperclip.example.com", false)).toThrow(
      "http baseUrl URLs require private-network access to be enabled",
    );
    expect(normalizePaperclipBaseUrl("http://100.64.0.2:3100/", true)).toBe("http://100.64.0.2:3100");
  });

  it("rejects non-API and traversal paths for the generic request action", () => {
    expect(() => normalizePaperclipApiPath("/admin")).toThrow("path must begin with /api/");
    expect(() => normalizePaperclipApiPath("/api/../admin")).toThrow(
      "endpoint must not contain path traversal segments",
    );
    expect(() => normalizePaperclipApiPath("https://example.com/api/companies")).toThrow(
      "endpoint must be a relative path starting with /",
    );
  });
});

function createPaperclipFetch(requests: Request[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/auth/sign-in/email") {
      return jsonResponse(
        { user: { id: "user-1" } },
        200,
        "paperclip-default.session_token=test-token; Path=/; HttpOnly; SameSite=Lax",
      );
    }
    if (pathname === "/api/auth/get-session") {
      return jsonResponse({
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1", email: "board@example.com", name: "Board User" },
      });
    }
    if (pathname === "/api/companies/company-1/issues") {
      return jsonResponse({ id: "issue-1", title: "Investigate the incident" }, 201);
    }
    throw new ProviderRequestError(500, `Unexpected test request: ${request.method} ${pathname}`);
  }) as typeof fetch;
}

function jsonResponse(data: unknown, status = 200, setCookie?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(JSON.stringify(data), { status, headers });
}
