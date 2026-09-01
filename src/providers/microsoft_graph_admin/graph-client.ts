import type { OAuthProviderContext } from "../provider-runtime.ts";

import { optionalString, requiredRecord } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";

const graphBaseUrl = "https://graph.microsoft.com/v1.0";
const graphOrigin = new URL(graphBaseUrl).origin;
const maxGraphJsonBytes = 8 * 1024 * 1024;

export type MicrosoftGraphAdminRuntimeDeps = OAuthProviderContext;
export type MicrosoftGraphAdminActionHandler = (
  input: Record<string, unknown>,
  deps: MicrosoftGraphAdminRuntimeDeps,
) => Promise<unknown>;
export type MicrosoftGraphAdminNextLinkKind = "users" | "subscribed_skus" | "user_licenses";

export interface MicrosoftGraphAdminRequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  nextLinkKind?: MicrosoftGraphAdminNextLinkKind;
}

export interface MicrosoftGraphAdminCollectionResult {
  items: Array<Record<string, unknown>>;
  nextLink: string | null;
}

interface GraphErrorPayload {
  error?: { message?: unknown };
  message?: unknown;
}

/** Request one JSON resource from the Microsoft Graph tenant administration APIs. */
export async function microsoftGraphAdminJsonRequest<T>(
  pathOrUrl: string,
  deps: MicrosoftGraphAdminRuntimeDeps,
  options: MicrosoftGraphAdminRequestOptions = {},
): Promise<T> {
  const response = await microsoftGraphAdminRequest(pathOrUrl, deps, options);
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxGraphJsonBytes,
    fieldName: "Microsoft Graph Admin JSON response",
    createError: (message) => new ProviderRequestError(502, message),
  });
  if (bytes.byteLength === 0) {
    throw new ProviderRequestError(502, "Microsoft Graph Admin returned an empty JSON response.");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new ProviderRequestError(502, "Microsoft Graph Admin returned invalid JSON.", error);
  }
}

/** Request one paginated collection and normalize its Microsoft Graph envelope. */
export async function microsoftGraphAdminCollectionRequest(
  pathOrUrl: string,
  deps: MicrosoftGraphAdminRuntimeDeps,
  options: MicrosoftGraphAdminRequestOptions = {},
): Promise<MicrosoftGraphAdminCollectionResult> {
  const payload = requiredRecord(
    await microsoftGraphAdminJsonRequest<unknown>(pathOrUrl, deps, options),
    "Microsoft Graph Admin collection response",
    (message) => new ProviderRequestError(502, message),
  );
  if (!Array.isArray(payload.value)) {
    throw new ProviderRequestError(502, 'Microsoft Graph Admin collection response is missing its "value" array.');
  }
  return {
    items: payload.value.map((item) =>
      requiredRecord(
        item,
        "Microsoft Graph Admin collection item",
        (message) => new ProviderRequestError(502, message),
      ),
    ),
    nextLink: optionalString(payload["@odata.nextLink"]) ?? null,
  };
}

/** Request a Microsoft Graph tenant administration response through the guarded provider fetcher. */
export async function microsoftGraphAdminRequest(
  pathOrUrl: string,
  deps: MicrosoftGraphAdminRuntimeDeps,
  options: MicrosoftGraphAdminRequestOptions = {},
): Promise<Response> {
  const url = buildMicrosoftGraphAdminUrl(pathOrUrl, options.query, options.nextLinkKind);
  const hasBody = options.body !== undefined;
  const method = (options.method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  if ((method === "GET" || method === "HEAD") && hasBody) {
    throw new ProviderRequestError(400, `Microsoft Graph Admin ${method} request must not include a body.`);
  }
  const headers = new Headers({
    accept: "application/json",
    authorization: `${deps.tokenType ?? "Bearer"} ${deps.accessToken}`,
  });
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (hasBody) headers.set("content-type", "application/json");
  const response = await deps.fetcher(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    signal: deps.signal,
  });
  if (!response.ok) await throwMicrosoftGraphAdminResponseError(response);
  return response;
}

function buildMicrosoftGraphAdminUrl(
  pathOrUrl: string,
  query: MicrosoftGraphAdminRequestOptions["query"],
  nextLinkKind: MicrosoftGraphAdminNextLinkKind | undefined,
): URL {
  const absolute = /^https?:\/\//iu.test(pathOrUrl);
  const url = absolute ? new URL(pathOrUrl) : new URL(pathOrUrl, `${graphBaseUrl}/`);
  if (url.origin !== graphOrigin || url.protocol !== "https:" || url.username || url.password) {
    throw new ProviderRequestError(400, `Microsoft Graph Admin requests must target ${graphOrigin}.`);
  }
  if (absolute) {
    if (!nextLinkKind) {
      throw new ProviderRequestError(400, "Absolute Microsoft Graph Admin URLs are accepted only as nextLink values.");
    }
    assertAllowedNextLink(url, nextLinkKind);
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function assertAllowedNextLink(url: URL, kind: MicrosoftGraphAdminNextLinkKind): void {
  const patterns: Record<MicrosoftGraphAdminNextLinkKind, RegExp> = {
    users: /^\/v1\.0\/users\/?$/u,
    subscribed_skus: /^\/v1\.0\/subscribedSkus\/?$/u,
    user_licenses: /^\/v1\.0\/users\/[^/]+\/licenseDetails\/?$/u,
  };
  if (!patterns[kind].test(url.pathname)) {
    throw new ProviderRequestError(400, `nextLink does not match the expected Microsoft Graph Admin ${kind} endpoint.`);
  }
}

async function throwMicrosoftGraphAdminResponseError(response: Response): Promise<never> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: 1024 * 1024,
    fieldName: "Microsoft Graph Admin error response",
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
    `Microsoft Graph Admin request failed with HTTP ${response.status}.`;
  throw new ProviderRequestError(response.status, message, payload);
}
