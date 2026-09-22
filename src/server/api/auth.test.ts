import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalAuthMiddleware,
  installMobileAuthCookie,
  isRuntimeActivityRequest,
  readRuntimeGrant,
} from "./auth.ts";

describe("createLocalAuthMiddleware", () => {
  it("allows runtime activity review and comments without granting administrative access", async () => {
    const grant = { tokenId: "maya", allowedActions: [], blockedActions: [], allowedProxies: [] };
    const app = new Hono();
    app.use(
      "*",
      createLocalAuthMiddleware({
        adminToken: "admin-secret",
        runtimeToken: "bootstrap",
        resolveRuntimeToken: async (token) => (token === "maya" ? grant : undefined),
        verifyRuntimeJwt: async (token) => token === "jwt",
      }),
    );
    app.all("*", (context) =>
      context.json({ runtime: isRuntimeActivityRequest(context), grant: readRuntimeGrant(context) }),
    );
    for (const [method, path] of [
      ["GET", "/api/feed"],
      ["POST", "/api/feed"],
      ["GET", "/api/flows"],
      ["GET", "/api/flows/flow-1"],
      ["GET", "/api/flow-runs"],
      ["GET", "/api/flow-runs/run-1"],
      ["POST", "/api/feed/flow%3Arun-1/comments"],
      ["HEAD", "/api/feed"],
    ]) {
      for (const token of ["maya", "bootstrap", "jwt"]) {
        const response = await app.request(path!, { method, headers: authorize("Bearer", token) });
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        if (method !== "HEAD") expect(await response.json()).toMatchObject({ runtime: true });
      }
      expect((await app.request(path!, { method })).status).toBe(401);
      const admin = await app.request(path!, { method, headers: authorize("Bearer", "admin-secret") });
      expect(admin.status).toBe(200);
      if (method !== "HEAD") expect(await admin.json()).toEqual({ runtime: false });
    }
    expect(await (await app.request("/api/feed", { headers: authorize("Bearer", "maya") })).json()).toEqual({
      runtime: true,
      grant,
    });
    for (const [method, path] of [
      ["POST", "/api/flows"],
      ["PUT", "/api/flows/flow-1"],
      ["DELETE", "/api/flows/flow-1"],
      ["POST", "/api/flows/flow-1/runs"],
      ["POST", "/api/flow-approvals/approval-1/approve"],
      ["GET", "/api/connections"],
      ["GET", "/api/runtime-tokens"],
      ["GET", "/api/feed/flow:run-1/previews/attachment-0"],
      ["GET", "/api/flows-extra"],
    ]) {
      expect((await app.request(path!, { method, headers: authorize("Bearer", "maya") })).status).toBe(401);
    }
  });

  it("does not open activity routes when only runtime authentication is configured", async () => {
    const app = new Hono();
    app.use("*", createLocalAuthMiddleware({ resolveRuntimeToken: async () => undefined }));
    app.all("*", (context) => context.json({ ok: true }));
    expect((await app.request("/api/feed")).status).toBe(401);
    expect((await app.request("/api/flows")).status).toBe(401);
    expect((await app.request("/api/feed/flow:run-1/comments", { method: "POST" })).status).toBe(401);
  });

  it("fails closed when a runtime token resolver is configured without a token-count callback", async () => {
    const app = new Hono();
    app.use(
      "*",
      createLocalAuthMiddleware({
        resolveRuntimeToken: async (token) =>
          token === "runtime-token"
            ? { tokenId: "token-1", allowedActions: [], blockedActions: [], allowedProxies: [] }
            : undefined,
      }),
    );
    app.get("/v1", (context) => context.json({ ok: true }));
    app.get("/v1/actions", (context) => context.json({ ok: true }));
    app.get("/mcp-not-runtime", (context) => context.json({ ok: true }));

    expect((await app.request("/v1")).status).toBe(401);
    expect((await app.request("/v1/actions")).status).toBe(401);
    expect(
      (
        await app.request("/v1/actions", {
          headers: { authorization: "Bearer runtime-token" },
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/mcp-not-runtime")).status).toBe(200);
  });

  it("does not open POST /v1/actions when runtime tokens exist but admin token is unset", async () => {
    const app = new Hono();
    app.use(
      "*",
      createLocalAuthMiddleware({
        hasRuntimeTokens: async () => true,
        resolveRuntimeToken: async (token) =>
          token === "oct_valid"
            ? { tokenId: "token-1", allowedActions: [], blockedActions: [], allowedProxies: [] }
            : undefined,
      }),
    );
    app.post("/v1/actions/:actionId", (context) => context.json({ ok: true, actionId: context.req.param("actionId") }));
    app.get("/v1/actions", (context) => context.json({ ok: true }));

    expect((await app.request("/v1/actions")).status).toBe(401);
    expect(
      (
        await app.request("/v1/actions/example.echo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: {} }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/v1/actions/example.echo", {
          method: "POST",
          headers: {
            authorization: "Bearer oct_valid",
            "content-type": "application/json",
          },
          body: JSON.stringify({ input: {} }),
        })
      ).status,
    ).toBe(200);
  });

  it.each(["Bearer", "bearer", "BEARER", "BeArEr"])(
    "accepts the %s authorization scheme on every auth scope",
    async (scheme) => {
      const app = createSchemeApp();

      expect((await app.request("/api/connections", { headers: authorize(scheme, "admin-secret") })).status).toBe(200);
      expect((await app.request("/v1/actions", { headers: authorize(scheme, "runtime-secret") })).status).toBe(200);
      expect((await app.request("/mcp/tools", { headers: authorize(scheme, "runtime-secret") })).status).toBe(200);
    },
  );

  it.each([
    "Basic admin-secret",
    "BearerX admin-secret",
    "Bearer-Foo admin-secret",
    "Bearer",
    "Bearer\tadmin-secret",
    // A case-insensitive scheme must not loosen anything else: the credentials stay
    // case-sensitive and are still matched byte-for-byte after a single separator space.
    "bearer admin-Secret",
    "bearer  admin-secret",
  ])("rejects the %j authorization header", async (authorization) => {
    const app = createSchemeApp();

    expect((await app.request("/api/connections", { headers: { authorization } })).status).toBe(401);
  });

  it("issues the admin session cookie for a lowercase bearer scheme", async () => {
    const app = createSchemeApp();

    const response = await app.request("/api/connections", {
      headers: authorize("bearer", "admin-secret"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("oomol_connect_admin_session=");
    expect(response.headers.get("set-cookie")).not.toContain("admin-secret");
  });

  it("resolves dynamic runtime tokens for a lowercase bearer scheme", async () => {
    const resolveRuntimeToken = vi.fn(async (token: string) =>
      token === "oct_valid"
        ? { tokenId: "token-1", allowedActions: [], blockedActions: [], allowedProxies: [] }
        : undefined,
    );
    const app = new Hono();
    app.use("*", createLocalAuthMiddleware({ hasRuntimeTokens: async () => true, resolveRuntimeToken }));
    app.get("/v1/actions", (context) => context.json({ ok: true }));

    const response = await app.request("/v1/actions", { headers: authorize("bearer", "oct_valid") });

    expect(response.status).toBe(200);
    expect(resolveRuntimeToken).toHaveBeenCalledWith("oct_valid");
  });

  it("challenges unauthenticated MCP callers when OAuth is enabled", async () => {
    const app = new Hono();
    app.use(
      "*",
      createLocalAuthMiddleware({
        hasRuntimeTokens: async () => false,
        resolveRuntimeToken: async () => undefined,
        mcpOAuth: {
          resource: "https://ocgw.example.test/mcp",
          resourceMetadataUrl: "https://ocgw.example.test/.well-known/oauth-protected-resource/mcp",
          requiredScopes: ["mcp:access"],
        },
      }),
    );
    app.post("/mcp", (context) => context.json({ ok: true }));

    const response = await app.request("/mcp", { method: "POST" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ocgw.example.test/.well-known/oauth-protected-resource/mcp", scope="mcp:access", error="invalid_token", error_description="OAuth access is required"',
    );
  });

  it("limits audience-bound OAuth tokens to the MCP resource while preserving legacy tokens", async () => {
    const app = new Hono();
    app.use(
      "*",
      createLocalAuthMiddleware({
        adminToken: "admin-secret",
        hasRuntimeTokens: async () => true,
        resolveRuntimeToken: async (token) => {
          if (token === "oauth-token") {
            return {
              tokenId: "oauth",
              allowedActions: [],
              blockedActions: [],
              allowedProxies: [],
              audience: "https://ocgw.example.test/mcp",
              scopes: ["mcp:access"],
            };
          }
          return token === "legacy-token"
            ? { tokenId: "legacy", allowedActions: [], blockedActions: [], allowedProxies: [] }
            : undefined;
        },
        mcpOAuth: {
          resource: "https://ocgw.example.test/mcp",
          resourceMetadataUrl: "https://ocgw.example.test/.well-known/oauth-protected-resource/mcp",
          requiredScopes: ["mcp:access"],
        },
      }),
    );
    app.post("/mcp", (context) => context.json({ ok: true }));
    app.get("/v1/actions", (context) => context.json({ ok: true }));

    app.get("/api/feed", (context) => context.json({ ok: true }));
    expect((await app.request("/api/feed", { headers: authorize("Bearer", "oauth-token") })).status).toBe(401);
    expect((await app.request("/api/feed", { headers: authorize("Bearer", "legacy-token") })).status).toBe(200);

    expect((await app.request("/mcp", { method: "POST", headers: authorize("Bearer", "oauth-token") })).status).toBe(
      200,
    );
    expect((await app.request("/v1/actions", { headers: authorize("Bearer", "oauth-token") })).status).toBe(401);
    expect((await app.request("/mcp", { method: "POST", headers: authorize("Bearer", "legacy-token") })).status).toBe(
      200,
    );
    expect((await app.request("/v1/actions", { headers: authorize("Bearer", "legacy-token") })).status).toBe(200);
  });

  it("allows configured admin tokens to elevate POST /v1/actions", async () => {
    const app = new Hono();
    app.use(
      "*",
      createLocalAuthMiddleware({
        adminToken: "admin-secret",
        hasRuntimeTokens: async () => true,
        resolveRuntimeToken: async () => undefined,
      }),
    );
    app.post("/v1/actions/:actionId", (context) => context.json({ ok: true }));

    expect(
      (
        await app.request("/v1/actions/example.echo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: {} }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/v1/actions/example.echo", {
          method: "POST",
          headers: {
            authorization: "Bearer admin-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({ input: {} }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/v1/actions/example.echo", {
          method: "POST",
          headers: { ...authorize("BEARER", "admin-secret"), "content-type": "application/json" },
          body: JSON.stringify({ input: {} }),
        })
      ).status,
    ).toBe(200);
  });

  it("accepts a revocable mobile cookie for admin APIs and action elevation", async () => {
    let active = true;
    const resolveMobileToken = vi.fn(async (token: string) =>
      active && token === "ocmd_phone" ? { id: "device-1" } : undefined,
    );
    const app = new Hono();
    app.use(
      "*",
      createLocalAuthMiddleware({
        adminToken: "admin-secret",
        hasRuntimeTokens: async () => true,
        resolveRuntimeToken: async () => undefined,
        resolveMobileToken,
      }),
    );
    app.get("/api/connections", (context) => context.json({ ok: true }));
    app.post("/v1/actions/:actionId", (context) => context.json({ ok: true }));
    const headers = { cookie: "oomol_connect_mobile_session=ocmd_phone" };

    expect((await app.request("/api/connections", { headers })).status).toBe(200);
    expect((await app.request("/v1/actions/example.echo", { method: "POST", headers })).status).toBe(200);
    active = false;
    expect((await app.request("/api/connections", { headers })).status).toBe(401);
    expect(resolveMobileToken).toHaveBeenCalledWith("ocmd_phone");
  });

  it("keeps the one-time mobile pairing exchange public", async () => {
    const app = new Hono();
    app.use("*", createLocalAuthMiddleware({ adminToken: "admin-secret", resolveMobileToken: async () => undefined }));
    app.post("/api/mobile-auth/exchange", (context) => {
      installMobileAuthCookie(context, "ocmd_phone");
      return context.json({ connected: true });
    });

    const response = await app.request("/api/mobile-auth/exchange", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("oomol_connect_mobile_session=ocmd_phone");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=34560000");
  });

  it("matches configured tokens byte-for-byte after the bearer scheme", async () => {
    const app = new Hono();
    app.use("*", createLocalAuthMiddleware({ adminToken: "admin-secret", runtimeToken: "runtime-secret" }));
    app.get("/api/connections", (context) => context.json({ ok: true }));
    app.get("/v1/actions", (context) => context.json({ ok: true }));

    const adminStatus = async (authorization: string): Promise<number> =>
      (await app.request("/api/connections", { headers: { authorization } })).status;

    expect(await adminStatus("Bearer admin-secret")).toBe(200);
    // Same length as the configured token, so a length check alone cannot reject it.
    expect(await adminStatus("Bearer admin-secreT")).toBe(401);
    expect(await adminStatus("Bearer admin-secre")).toBe(401);
    expect(await adminStatus("Bearer admin-secret-extra")).toBe(401);
    expect(await adminStatus("Bearer  admin-secret")).toBe(401);
    expect(await adminStatus("admin-secret")).toBe(401);
    // The runtime bootstrap token must not unlock the admin surface, and vice versa.
    expect(await adminStatus("Bearer runtime-secret")).toBe(401);
    expect((await app.request("/v1/actions", { headers: { authorization: "Bearer runtime-secret" } })).status).toBe(
      200,
    );
    expect((await app.request("/v1/actions", { headers: { authorization: "Bearer runtime-secreT" } })).status).toBe(
      401,
    );
  });
});

function createSchemeApp(): Hono {
  const app = new Hono();
  app.use("*", createLocalAuthMiddleware({ adminToken: "admin-secret", runtimeToken: "runtime-secret" }));
  app.get("/api/connections", (context) => context.json({ ok: true }));
  app.get("/v1/actions", (context) => context.json({ ok: true }));
  app.get("/mcp/tools", (context) => context.json({ ok: true }));
  return app;
}

function authorize(scheme: string, token: string): Record<string, string> {
  return { authorization: `${scheme} ${token}` };
}
