import type { IRuntimeTokenStore, RuntimeTokenRecord } from "../storage/runtime-token-service.ts";
import type {
  IMcpOAuthStore,
  McpOAuthAuthorizationCode,
  McpOAuthClientRegistration,
  McpOAuthRefreshToken,
} from "./mcp-oauth-service.ts";

import { describe, expect, it } from "vitest";
import { RuntimeTokenService } from "../storage/runtime-token-service.ts";
import { McpOAuthError, McpOAuthService, mcpOAuthScope } from "./mcp-oauth-service.ts";

const origin = "https://ocgw.example.test";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = "v".repeat(64);

describe("McpOAuthService", () => {
  it("publishes MCP and OAuth discovery metadata", () => {
    const { service } = createService();

    expect(service.protectedResourceMetadata()).toEqual(
      expect.objectContaining({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: [mcpOAuthScope],
      }),
    );
    expect(service.authorizationServerMetadata()).toEqual(
      expect.objectContaining({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      }),
    );
  });

  it("registers a public ChatGPT client and completes authorization code plus PKCE", async () => {
    const { service, runtimeTokens } = createService();
    const client = await registerChatGptClient(service);
    const code = await authorize(service, client.client_id);

    const token = await service.exchangeToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      }),
    );

    expect(token).toEqual(
      expect.objectContaining({
        token_type: "Bearer",
        expires_in: 3_600,
        scope: mcpOAuthScope,
      }),
    );
    expect(token.access_token).toMatch(/^oct_/u);
    expect(token.refresh_token).toMatch(/^ocg_mcp_refresh_/u);
    await expect(runtimeTokens.resolveToken(token.access_token)).resolves.toEqual(
      expect.objectContaining({ audience: `${origin}/mcp`, scopes: [mcpOAuthScope] }),
    );
  });

  it("rotates refresh tokens and revokes the previous access token", async () => {
    const { service, runtimeTokens } = createService();
    const client = await registerChatGptClient(service);
    const first = await exchangeAuthorizationCode(service, client.client_id);

    const second = await service.exchangeToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: first.refresh_token,
        resource: `${origin}/mcp`,
      }),
    );

    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(runtimeTokens.resolveToken(first.access_token)).resolves.toBeUndefined();
    await expect(runtimeTokens.resolveToken(second.access_token)).resolves.toBeDefined();
    await expect(
      service.exchangeToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: first.refresh_token,
          resource: `${origin}/mcp`,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects invalid PKCE and does not allow an authorization code to be replayed", async () => {
    const { service } = createService();
    const client = await registerChatGptClient(service);
    const code = await authorize(service, client.client_id);
    const input = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: "x".repeat(64),
      resource: `${origin}/mcp`,
    });

    await expect(service.exchangeToken(input)).rejects.toMatchObject({ code: "invalid_grant" });
    input.set("code_verifier", verifier);
    await expect(service.exchangeToken(input)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects non-ChatGPT redirect URIs on a public deployment", async () => {
    const { service } = createService();

    await expect(
      service.registerClient({
        client_name: "Untrusted client",
        redirect_uris: ["https://attacker.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    ).rejects.toBeInstanceOf(McpOAuthError);
  });
});

async function registerChatGptClient(service: McpOAuthService) {
  return await service.registerClient({
    client_name: "ChatGPT",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

async function exchangeAuthorizationCode(service: McpOAuthService, clientId: string) {
  const code = await authorize(service, clientId);
  return await service.exchangeToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  );
}

async function authorize(service: McpOAuthService, clientId: string): Promise<string> {
  const url = new URL("/oauth/authorize", origin);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
    scope: mcpOAuthScope,
    state: "test-state",
  }).toString();
  const request = await service.readAuthorizationRequest(url);
  const redirect = new URL(await service.approveAuthorization(request));
  expect(redirect.searchParams.get("state")).toBe("test-state");
  expect(redirect.searchParams.get("iss")).toBe(origin);
  return redirect.searchParams.get("code")!;
}

function createService(): { service: McpOAuthService; runtimeTokens: RuntimeTokenService } {
  const runtimeTokens = new RuntimeTokenService(new MemoryRuntimeTokenStore());
  return {
    service: new McpOAuthService({ origin, store: new MemoryMcpOAuthStore(), runtimeTokens }),
    runtimeTokens,
  };
}

async function challenge(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

class MemoryMcpOAuthStore implements IMcpOAuthStore {
  private readonly clients = new Map<string, McpOAuthClientRegistration>();
  private readonly codes = new Map<string, McpOAuthAuthorizationCode>();
  private readonly refreshTokens = new Map<string, McpOAuthRefreshToken>();

  async addClient(client: McpOAuthClientRegistration): Promise<void> {
    this.clients.set(client.id, client);
  }

  async getClient(id: string): Promise<McpOAuthClientRegistration | undefined> {
    return this.clients.get(id);
  }

  async addAuthorizationCode(code: McpOAuthAuthorizationCode): Promise<void> {
    this.codes.set(code.codeHash, code);
  }

  async takeAuthorizationCode(codeHash: string, now: string): Promise<McpOAuthAuthorizationCode | undefined> {
    const code = this.codes.get(codeHash);
    this.codes.delete(codeHash);
    return code && code.expiresAt > now ? code : undefined;
  }

  async addRefreshToken(token: McpOAuthRefreshToken): Promise<void> {
    this.refreshTokens.set(token.tokenHash, token);
  }

  async takeRefreshToken(tokenHash: string, now: string): Promise<McpOAuthRefreshToken | undefined> {
    const token = this.refreshTokens.get(tokenHash);
    this.refreshTokens.delete(tokenHash);
    return token && token.expiresAt > now ? token : undefined;
  }
}

class MemoryRuntimeTokenStore implements IRuntimeTokenStore {
  private readonly records = new Map<string, RuntimeTokenRecord>();

  async add(record: RuntimeTokenRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    return [...this.records.values()];
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    return [...this.records.values()].find((record) => record.tokenHash === tokenHash);
  }

  async updatePolicy(): Promise<RuntimeTokenRecord | undefined> {
    return undefined;
  }

  async revoke(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    const record = this.records.get(id);
    if (record) record.lastUsedAt = usedAt;
  }
}
