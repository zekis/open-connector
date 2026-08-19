import type { OAuthProviderContext } from "../provider-runtime.ts";

import { optionalString, requiredRecord } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";

const graphBaseUrl = "https://graph.microsoft.com/v1.0";
const graphOrigin = new URL(graphBaseUrl).origin;
const maxGraphJsonBytes = 8 * 1024 * 1024;

export type MicrosoftTeamsRuntimeDeps = OAuthProviderContext;
export type MicrosoftTeamsActionHandler = (
  input: Record<string, unknown>,
  deps: MicrosoftTeamsRuntimeDeps,
) => Promise<unknown>;

export type MicrosoftTeamsNextLinkKind =
  | "joined_teams"
  | "channels"
  | "channel_messages"
  | "channel_replies"
  | "chats"
  | "chat_messages";

export interface MicrosoftTeamsRequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  nextLinkKind?: MicrosoftTeamsNextLinkKind;
}

export interface MicrosoftTeamsCollectionResult {
  items: Array<Record<string, unknown>>;
  nextLink: string | null;
}

interface GraphErrorPayload {
  error?: {
    code?: unknown;
    message?: unknown;
    innerError?: unknown;
  };
  message?: unknown;
}

/** Request one JSON resource from the Microsoft Graph Teams APIs. */
export async function microsoftTeamsJsonRequest<T>(
  pathOrUrl: string,
  deps: MicrosoftTeamsRuntimeDeps,
  options: MicrosoftTeamsRequestOptions = {},
): Promise<T> {
  const response = await microsoftTeamsRequest(pathOrUrl, deps, options);
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxGraphJsonBytes,
    fieldName: "Microsoft Teams JSON response",
    createError: (message) => new ProviderRequestError(502, message),
  });
  if (bytes.byteLength === 0) {
    throw new ProviderRequestError(502, "Microsoft Teams returned an empty JSON response.");
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new ProviderRequestError(502, "Microsoft Teams returned invalid JSON.", error);
  }
}

/** Request one paginated Microsoft Graph Teams collection and normalize its envelope. */
export async function microsoftTeamsCollectionRequest(
  pathOrUrl: string,
  deps: MicrosoftTeamsRuntimeDeps,
  options: MicrosoftTeamsRequestOptions = {},
): Promise<MicrosoftTeamsCollectionResult> {
  const payload = requiredRecord(
    await microsoftTeamsJsonRequest<unknown>(pathOrUrl, deps, options),
    "Microsoft Teams collection response",
    (message) => new ProviderRequestError(502, message),
  );
  if (!Array.isArray(payload.value)) {
    throw new ProviderRequestError(502, 'Microsoft Teams collection response is missing its "value" array.');
  }

  return {
    items: payload.value.map((item) =>
      requiredRecord(item, "Microsoft Teams collection item", (message) => new ProviderRequestError(502, message)),
    ),
    nextLink: optionalString(payload["@odata.nextLink"]) ?? null,
  };
}

/** Request a Microsoft Graph Teams response. */
export async function microsoftTeamsRequest(
  pathOrUrl: string,
  deps: MicrosoftTeamsRuntimeDeps,
  options: MicrosoftTeamsRequestOptions = {},
): Promise<Response> {
  const url = buildMicrosoftTeamsUrl(pathOrUrl, options.query, options.nextLinkKind);
  const hasBody = options.body !== undefined;
  const method = (options.method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  if ((method === "GET" || method === "HEAD") && hasBody) {
    throw new ProviderRequestError(400, `Microsoft Teams ${method} request must not include a body.`);
  }

  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("authorization", `${deps.tokenType ?? "Bearer"} ${deps.accessToken}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await deps.fetcher(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    signal: deps.signal,
  });
  if (!response.ok) {
    await throwMicrosoftTeamsResponseError(response);
  }
  return response;
}

function buildMicrosoftTeamsUrl(
  pathOrUrl: string,
  query: Record<string, string | number | undefined> | undefined,
  nextLinkKind: MicrosoftTeamsNextLinkKind | undefined,
): URL {
  const absolute = /^https?:\/\//iu.test(pathOrUrl);
  const url = absolute ? new URL(pathOrUrl) : new URL(pathOrUrl, `${graphBaseUrl}/`);
  if (url.origin !== graphOrigin || url.protocol !== "https:" || url.username || url.password) {
    throw new ProviderRequestError(400, `Microsoft Teams requests must target ${graphOrigin}.`);
  }
  if (absolute) {
    if (!nextLinkKind) {
      throw new ProviderRequestError(400, "Absolute Microsoft Teams URLs are accepted only as action nextLink values.");
    }
    assertAllowedNextLink(url, nextLinkKind);
  }

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function assertAllowedNextLink(url: URL, kind: MicrosoftTeamsNextLinkKind): void {
  const patterns: Record<MicrosoftTeamsNextLinkKind, RegExp> = {
    joined_teams: /^\/v1\.0\/me\/joinedTeams\/?$/u,
    channels: /^\/v1\.0\/teams\/[^/]+\/channels\/?$/u,
    channel_messages: /^\/v1\.0\/teams\/[^/]+\/channels\/[^/]+\/messages\/?$/u,
    channel_replies: /^\/v1\.0\/teams\/[^/]+\/channels\/[^/]+\/messages\/[^/]+\/replies\/?$/u,
    chats: /^\/v1\.0\/(?:me\/)?chats\/?$/u,
    chat_messages: /^\/v1\.0\/(?:me\/)?chats\/[^/]+\/messages\/?$/u,
  };
  if (!patterns[kind].test(url.pathname)) {
    throw new ProviderRequestError(400, `nextLink does not match the expected Microsoft Teams ${kind} endpoint.`);
  }
}

async function throwMicrosoftTeamsResponseError(response: Response): Promise<never> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: 1024 * 1024,
    fieldName: "Microsoft Teams error response",
    createError: (message) => new ProviderRequestError(502, message),
  });
  const text = new TextDecoder().decode(bytes);
  let payload: GraphErrorPayload | undefined;
  try {
    payload = text ? (JSON.parse(text) as GraphErrorPayload) : undefined;
  } catch {
    payload = undefined;
  }
  const message =
    optionalString(payload?.error?.message) ??
    optionalString(payload?.message) ??
    optionalString(text) ??
    `Microsoft Teams request failed with HTTP ${response.status}.`;
  throw new ProviderRequestError(response.status, message, payload);
}
