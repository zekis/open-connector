import type { TokenPolicy } from "../../core/action-policy.ts";
import type { RuntimeTokenService } from "../storage/runtime-token-service.ts";

import { optionalRecord, optionalString, optionalStringArray, requiredString } from "../../core/cast.ts";
import { hashRuntimeToken } from "../storage/runtime-token-service.ts";

export const mcpOAuthScope = "mcp:access";
export const mcpOAuthAccessTokenLifetimeSeconds = 3_600;
export const mcpOAuthAuthorizationCodeLifetimeSeconds = 300;
export const mcpOAuthRefreshTokenLifetimeSeconds = 7_776_000;

const dcrClientIdPrefix = "ocg_mcp_client_";
const authorizationCodePrefix = "ocg_mcp_code_";
const refreshTokenPrefix = "ocg_mcp_refresh_";
const chatGptStableRedirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const chatGptCallbackRedirectPattern = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/u;
const pkceValuePattern = /^[A-Za-z0-9._~-]{43,128}$/u;
const emptyTokenPolicy: TokenPolicy = { allowedActions: [], blockedActions: [], allowedProxies: [] };

export interface McpOAuthClientRegistration {
  id: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  createdAt: string;
}

export interface McpOAuthAuthorizationCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
}

export interface McpOAuthRefreshToken {
  tokenHash: string;
  clientId: string;
  runtimeTokenId: string;
  resource: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
}

export interface IMcpOAuthStore {
  addClient(client: McpOAuthClientRegistration): Promise<void>;
  getClient(id: string): Promise<McpOAuthClientRegistration | undefined>;
  addAuthorizationCode(code: McpOAuthAuthorizationCode): Promise<void>;
  takeAuthorizationCode(codeHash: string, now: string): Promise<McpOAuthAuthorizationCode | undefined>;
  addRefreshToken(token: McpOAuthRefreshToken): Promise<void>;
  takeRefreshToken(tokenHash: string, now: string): Promise<McpOAuthRefreshToken | undefined>;
}

export interface McpOAuthServiceOptions {
  origin: string;
  store: IMcpOAuthStore;
  runtimeTokens: RuntimeTokenService;
  now?: () => Date;
}

export interface McpOAuthAuthorizationRequest {
  client: McpOAuthClientRegistration;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  state?: string;
}

export interface McpOAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface McpOAuthClientRegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: ["code"];
  token_endpoint_auth_method: "none";
}

export type McpOAuthErrorCode =
  | "access_denied"
  | "invalid_client"
  | "invalid_client_metadata"
  | "invalid_grant"
  | "invalid_redirect_uri"
  | "invalid_request"
  | "invalid_scope"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type";

export class McpOAuthError extends Error {
  readonly code: McpOAuthErrorCode;
  readonly status: 400 | 401;

  constructor(code: McpOAuthErrorCode, message: string, status: 400 | 401 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** OAuth 2.1 authorization server dedicated to the Open Connector MCP resource. */
export class McpOAuthService {
  readonly issuer: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string;

  private readonly store: IMcpOAuthStore;
  private readonly runtimeTokens: RuntimeTokenService;
  private readonly now: () => Date;

  constructor(options: McpOAuthServiceOptions) {
    this.issuer = normalizeOrigin(options.origin);
    this.resource = `${this.issuer}/mcp`;
    this.resourceMetadataUrl = `${this.issuer}/.well-known/oauth-protected-resource/mcp`;
    this.store = options.store;
    this.runtimeTokens = options.runtimeTokens;
    this.now = options.now ?? (() => new Date());
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [mcpOAuthScope],
      bearer_methods_supported: ["header"],
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [mcpOAuthScope],
      authorization_response_iss_parameter_supported: true,
    };
  }

  async registerClient(input: unknown): Promise<McpOAuthClientRegistrationResponse> {
    const body = optionalRecord(input);
    if (!body) {
      throw new McpOAuthError("invalid_client_metadata", "Registration body must be a JSON object.");
    }

    const redirectUris = optionalStringArray(body.redirect_uris);
    if (!redirectUris?.length || redirectUris.length > 10) {
      throw new McpOAuthError("invalid_redirect_uri", "redirect_uris must contain between 1 and 10 URLs.");
    }
    for (const redirectUri of redirectUris) {
      this.validateRedirectUri(redirectUri);
    }

    const tokenEndpointAuthMethod = optionalString(body.token_endpoint_auth_method) ?? "none";
    if (tokenEndpointAuthMethod !== "none") {
      throw new McpOAuthError(
        "invalid_client_metadata",
        "Only public clients using token_endpoint_auth_method none are supported.",
      );
    }

    const grantTypes = optionalStringArray(body.grant_types) ?? ["authorization_code", "refresh_token"];
    if (
      !grantTypes.includes("authorization_code") ||
      grantTypes.some((grantType) => grantType !== "authorization_code" && grantType !== "refresh_token")
    ) {
      throw new McpOAuthError(
        "invalid_client_metadata",
        "grant_types must contain authorization_code and may also contain refresh_token.",
      );
    }

    const responseTypes = optionalStringArray(body.response_types) ?? ["code"];
    if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
      throw new McpOAuthError("invalid_client_metadata", "Only the code response type is supported.");
    }

    const now = this.now();
    const client: McpOAuthClientRegistration = {
      id: randomOpaqueValue(dcrClientIdPrefix),
      name: sanitizeClientName(optionalString(body.client_name) ?? "ChatGPT MCP client"),
      redirectUris: [...new Set(redirectUris)],
      grantTypes: [...new Set(grantTypes)],
      createdAt: now.toISOString(),
    };
    await this.store.addClient(client);

    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(now.getTime() / 1_000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async readAuthorizationRequest(url: URL): Promise<McpOAuthAuthorizationRequest> {
    const clientId = requiredAuthorizationParameter(url, "client_id");
    const client = await this.store.getClient(clientId);
    if (!client) {
      throw new McpOAuthError("invalid_client", "The OAuth client is not registered.", 401);
    }

    const redirectUri = requiredAuthorizationParameter(url, "redirect_uri");
    if (!client.redirectUris.includes(redirectUri)) {
      throw new McpOAuthError("invalid_redirect_uri", "redirect_uri is not registered for this client.");
    }

    if (requiredAuthorizationParameter(url, "response_type") !== "code") {
      throw new McpOAuthError("unsupported_response_type", "Only response_type=code is supported.");
    }
    if (requiredAuthorizationParameter(url, "code_challenge_method") !== "S256") {
      throw new McpOAuthError("invalid_request", "code_challenge_method must be S256.");
    }

    const codeChallenge = requiredAuthorizationParameter(url, "code_challenge");
    if (!pkceValuePattern.test(codeChallenge)) {
      throw new McpOAuthError("invalid_request", "code_challenge is not a valid PKCE value.");
    }

    const resource = requiredAuthorizationParameter(url, "resource");
    if (resource !== this.resource) {
      throw new McpOAuthError("invalid_request", `resource must be ${this.resource}.`);
    }

    const scopes = parseScopes(url.searchParams.get("scope"));
    assertSupportedScopes(scopes);
    const state = optionalString(url.searchParams.get("state"));
    if (state && state.length > 2_048) {
      throw new McpOAuthError("invalid_request", "state is too long.");
    }

    return { client, clientId, redirectUri, codeChallenge, resource, scopes, state };
  }

  async approveAuthorization(request: McpOAuthAuthorizationRequest): Promise<string> {
    const code = randomOpaqueValue(authorizationCodePrefix);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + mcpOAuthAuthorizationCodeLifetimeSeconds * 1_000);
    await this.store.addAuthorizationCode({
      codeHash: hashRuntimeToken(code),
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      scopes: request.scopes,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code);
    if (request.state) redirect.searchParams.set("state", request.state);
    redirect.searchParams.set("iss", this.issuer);
    return redirect.toString();
  }

  denyAuthorization(request: McpOAuthAuthorizationRequest): string {
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("error_description", "The resource owner denied the request.");
    if (request.state) redirect.searchParams.set("state", request.state);
    redirect.searchParams.set("iss", this.issuer);
    return redirect.toString();
  }

  async exchangeToken(input: URLSearchParams): Promise<McpOAuthTokenResponse> {
    const grantType = requiredFormParameter(input, "grant_type");
    if (grantType === "authorization_code") {
      return await this.exchangeAuthorizationCode(input);
    }
    if (grantType === "refresh_token") {
      return await this.exchangeRefreshToken(input);
    }
    throw new McpOAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  }

  challenge(
    error: "invalid_token" | "insufficient_scope" = "invalid_token",
    description = "OAuth access is required.",
  ): string {
    return `Bearer resource_metadata="${this.resourceMetadataUrl}", scope="${mcpOAuthScope}", error="${error}", error_description="${escapeChallengeValue(description)}"`;
  }

  private async exchangeAuthorizationCode(input: URLSearchParams): Promise<McpOAuthTokenResponse> {
    const clientId = requiredFormParameter(input, "client_id");
    await this.requireClient(clientId);
    const code = requiredFormParameter(input, "code");
    const record = await this.store.takeAuthorizationCode(hashRuntimeToken(code), this.now().toISOString());
    if (!record) {
      throw new McpOAuthError("invalid_grant", "The authorization code is invalid, expired, or already used.");
    }

    if (record.clientId !== clientId) {
      throw new McpOAuthError("invalid_grant", "The authorization code was not issued to this client.");
    }
    if (requiredFormParameter(input, "redirect_uri") !== record.redirectUri) {
      throw new McpOAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    assertResource(input, record.resource, this.resource);

    const verifier = requiredFormParameter(input, "code_verifier");
    if (!pkceValuePattern.test(verifier) || (await pkceChallenge(verifier)) !== record.codeChallenge) {
      throw new McpOAuthError("invalid_grant", "PKCE verification failed.");
    }

    return await this.issueToken(record.clientId, record.resource, record.scopes);
  }

  private async exchangeRefreshToken(input: URLSearchParams): Promise<McpOAuthTokenResponse> {
    const clientId = requiredFormParameter(input, "client_id");
    const client = await this.requireClient(clientId);
    if (!client.grantTypes.includes("refresh_token")) {
      throw new McpOAuthError("unauthorized_client", "This client cannot use refresh tokens.");
    }

    const refreshToken = requiredFormParameter(input, "refresh_token");
    const record = await this.store.takeRefreshToken(hashRuntimeToken(refreshToken), this.now().toISOString());
    if (!record || record.clientId !== clientId) {
      throw new McpOAuthError("invalid_grant", "The refresh token is invalid, expired, or already used.");
    }
    assertResource(input, record.resource, this.resource);

    const requestedScopes = input.has("scope") ? parseScopes(input.get("scope")) : record.scopes;
    assertSupportedScopes(requestedScopes);
    if (requestedScopes.some((scope) => !record.scopes.includes(scope))) {
      throw new McpOAuthError("invalid_scope", "A refresh request cannot expand its original scopes.");
    }

    await this.runtimeTokens.revokeToken(record.runtimeTokenId);
    return await this.issueToken(clientId, record.resource, requestedScopes);
  }

  private async issueToken(clientId: string, resource: string, scopes: string[]): Promise<McpOAuthTokenResponse> {
    const client = await this.requireClient(clientId);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + mcpOAuthAccessTokenLifetimeSeconds * 1_000);
    const access = await this.runtimeTokens.createToken(`OAuth · ${client.name}`, emptyTokenPolicy, {
      audience: resource,
      scopes,
      expiresAt: expiresAt.toISOString(),
    });
    const refreshToken = randomOpaqueValue(refreshTokenPrefix);
    const refreshExpiresAt = new Date(createdAt.getTime() + mcpOAuthRefreshTokenLifetimeSeconds * 1_000);

    try {
      await this.store.addRefreshToken({
        tokenHash: hashRuntimeToken(refreshToken),
        clientId,
        runtimeTokenId: access.record.id,
        resource,
        scopes,
        createdAt: createdAt.toISOString(),
        expiresAt: refreshExpiresAt.toISOString(),
      });
    } catch (error) {
      await this.runtimeTokens.revokeToken(access.record.id);
      throw error;
    }

    return {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: mcpOAuthAccessTokenLifetimeSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private async requireClient(clientId: string): Promise<McpOAuthClientRegistration> {
    const client = await this.store.getClient(clientId);
    if (!client) {
      throw new McpOAuthError("invalid_client", "The OAuth client is not registered.", 401);
    }
    return client;
  }

  private validateRedirectUri(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new McpOAuthError("invalid_redirect_uri", "Every redirect URI must be an absolute URL.");
    }
    if (url.username || url.password || url.hash) {
      throw new McpOAuthError("invalid_redirect_uri", "Redirect URIs cannot contain credentials or fragments.");
    }
    if (value === chatGptStableRedirectUri || chatGptCallbackRedirectPattern.test(value)) return;
    if (this.issuer.startsWith("http://localhost:") && url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
    throw new McpOAuthError("invalid_redirect_uri", "Only ChatGPT redirect URIs are accepted by this server.");
  }
}

function assertResource(input: URLSearchParams, issuedResource: string, expectedResource: string): void {
  const resource = requiredFormParameter(input, "resource");
  if (resource !== issuedResource || resource !== expectedResource) {
    throw new McpOAuthError("invalid_grant", "resource does not match the authorization grant.");
  }
}

function assertSupportedScopes(scopes: string[]): void {
  if (scopes.length !== 1 || scopes[0] !== mcpOAuthScope) {
    throw new McpOAuthError("invalid_scope", `The only supported scope is ${mcpOAuthScope}.`);
  }
}

function parseScopes(value: string | null): string[] {
  const scopes = [...new Set((value ?? mcpOAuthScope).split(/\s+/u).filter(Boolean))];
  return scopes.length > 0 ? scopes : [mcpOAuthScope];
}

function requiredAuthorizationParameter(url: URL, name: string): string {
  return requiredString(url.searchParams.get(name), name, (message) => new McpOAuthError("invalid_request", message));
}

function requiredFormParameter(input: URLSearchParams, name: string): string {
  return requiredString(input.get(name), name, (message) => new McpOAuthError("invalid_request", message));
}

function sanitizeClientName(value: string): string {
  const printable = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("");
  const name = printable.replace(/\s+/gu, " ").trim();
  return (name || "ChatGPT MCP client").slice(0, 120);
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("MCP OAuth requires an HTTPS public origin (HTTP is allowed only on loopback).");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("MCP OAuth origin must contain only the scheme and host.");
  }
  return url.origin;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function randomOpaqueValue(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

function escapeChallengeValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\r\n]/gu, " ");
}
