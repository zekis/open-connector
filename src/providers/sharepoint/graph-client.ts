import type { OAuthProviderContext } from "../provider-runtime.ts";

import { optionalString, requiredRecord } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";

const graphBaseUrl = "https://graph.microsoft.com/v1.0";
const graphOrigin = new URL(graphBaseUrl).origin;
const maxGraphJsonBytes = 4 * 1024 * 1024;

export type SharePointRuntimeDeps = OAuthProviderContext;
export type SharePointActionHandler = (input: Record<string, unknown>, deps: SharePointRuntimeDeps) => Promise<unknown>;

export type SharePointNextLinkKind =
  | "sites"
  | "site_drives"
  | "drive_children"
  | "drive_search"
  | "lists"
  | "list_items";

export interface SharePointRequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  rawBody?: BodyInit;
  nextLinkKind?: SharePointNextLinkKind;
}

export interface SharePointCollectionResult {
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

/** Request one JSON resource from Microsoft Graph. */
export async function sharePointJsonRequest<T>(
  pathOrUrl: string,
  deps: SharePointRuntimeDeps,
  options: SharePointRequestOptions = {},
): Promise<T> {
  const response = await sharePointRequest(pathOrUrl, deps, options);
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxGraphJsonBytes,
    fieldName: "SharePoint JSON response",
    createError: (message) => new ProviderRequestError(502, message),
  });
  if (bytes.byteLength === 0) {
    throw new ProviderRequestError(502, "SharePoint returned an empty JSON response.");
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new ProviderRequestError(502, "SharePoint returned invalid JSON.", error);
  }
}

/** Request one paginated Microsoft Graph collection and normalize its envelope. */
export async function sharePointCollectionRequest(
  pathOrUrl: string,
  deps: SharePointRuntimeDeps,
  options: SharePointRequestOptions = {},
): Promise<SharePointCollectionResult> {
  const payload = requiredRecord(
    await sharePointJsonRequest<unknown>(pathOrUrl, deps, options),
    "SharePoint collection response",
    (message) => new ProviderRequestError(502, message),
  );
  if (!Array.isArray(payload.value)) {
    throw new ProviderRequestError(502, 'SharePoint collection response is missing its "value" array.');
  }

  return {
    items: payload.value.map((item) =>
      requiredRecord(item, "SharePoint collection item", (message) => new ProviderRequestError(502, message)),
    ),
    nextLink: optionalString(payload["@odata.nextLink"]) ?? null,
  };
}

/** Request a Microsoft Graph response while preserving raw file bodies when needed. */
export async function sharePointRequest(
  pathOrUrl: string,
  deps: SharePointRuntimeDeps,
  options: SharePointRequestOptions = {},
): Promise<Response> {
  const url = buildSharePointUrl(pathOrUrl, options.query, options.nextLinkKind);
  const hasJsonBody = options.body !== undefined;
  const hasRawBody = options.rawBody !== undefined;
  if (hasJsonBody && hasRawBody) {
    throw new ProviderRequestError(400, "SharePoint request must not include both JSON and raw bodies.");
  }

  const method = (options.method ?? (hasJsonBody || hasRawBody ? "POST" : "GET")).toUpperCase();
  if ((method === "GET" || method === "HEAD") && (hasJsonBody || hasRawBody)) {
    throw new ProviderRequestError(400, `SharePoint ${method} request must not include a body.`);
  }

  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${deps.accessToken}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  if (hasJsonBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await deps.fetcher(url, {
    method,
    headers,
    body: hasJsonBody ? JSON.stringify(options.body) : options.rawBody,
    signal: deps.signal,
  });
  if (!response.ok) {
    await throwSharePointResponseError(response);
  }
  return response;
}

function buildSharePointUrl(
  pathOrUrl: string,
  query: Record<string, string | number | undefined> | undefined,
  nextLinkKind: SharePointNextLinkKind | undefined,
): URL {
  const absolute = /^https?:\/\//iu.test(pathOrUrl);
  const url = absolute ? new URL(pathOrUrl) : new URL(pathOrUrl, `${graphBaseUrl}/`);
  if (url.origin !== graphOrigin || url.protocol !== "https:") {
    throw new ProviderRequestError(400, `SharePoint requests must target ${graphOrigin}.`);
  }
  if (absolute) {
    if (!nextLinkKind) {
      throw new ProviderRequestError(400, "Absolute SharePoint URLs are accepted only as action nextLink values.");
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

function assertAllowedNextLink(url: URL, kind: SharePointNextLinkKind): void {
  const patterns: Record<SharePointNextLinkKind, RegExp> = {
    sites: /^\/v1\.0\/sites\/?$/u,
    site_drives: /^\/v1\.0\/sites\/[^/]+\/drives\/?$/u,
    drive_children: /^\/v1\.0\/drives\/[^/]+\/(?:root|items\/[^/]+|root:\/.*:)\/children\/?$/u,
    drive_search: /^\/v1\.0\/drives\/[^/]+\/root\/search\(.+\)\/?$/u,
    lists: /^\/v1\.0\/sites\/[^/]+\/lists\/?$/u,
    list_items: /^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items\/?$/u,
  };
  if (!patterns[kind].test(url.pathname)) {
    throw new ProviderRequestError(400, `nextLink does not match the expected SharePoint ${kind} endpoint.`);
  }
}

async function throwSharePointResponseError(response: Response): Promise<never> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: 1024 * 1024,
    fieldName: "SharePoint error response",
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
    `SharePoint request failed with HTTP ${response.status}.`;
  throw new ProviderRequestError(response.status === 404 ? 400 : response.status, message, payload);
}
