import type { OAuthProviderContext } from "../provider-runtime.ts";

import { optionalString, requiredRecord } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";

const graphBaseUrl = "https://graph.microsoft.com/v1.0";
const graphOrigin = new URL(graphBaseUrl).origin;
const maxGraphJsonBytes = 4 * 1024 * 1024;

export type MicrosoftTodoRuntimeDeps = OAuthProviderContext;
export type MicrosoftTodoActionHandler = (
  input: Record<string, unknown>,
  deps: MicrosoftTodoRuntimeDeps,
) => Promise<unknown>;

export type MicrosoftTodoNextLinkKind = "task_lists" | "tasks";

export interface MicrosoftTodoRequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  nextLinkKind?: MicrosoftTodoNextLinkKind;
}

export interface MicrosoftTodoCollectionResult {
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

/** Request one JSON resource from the Microsoft Graph To Do APIs. */
export async function microsoftTodoJsonRequest<T>(
  pathOrUrl: string,
  deps: MicrosoftTodoRuntimeDeps,
  options: MicrosoftTodoRequestOptions = {},
): Promise<T> {
  const response = await microsoftTodoRequest(pathOrUrl, deps, options);
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxGraphJsonBytes,
    fieldName: "Microsoft To Do JSON response",
    createError: (message) => new ProviderRequestError(502, message),
  });
  if (bytes.byteLength === 0) {
    throw new ProviderRequestError(502, "Microsoft To Do returned an empty JSON response.");
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new ProviderRequestError(502, "Microsoft To Do returned invalid JSON.", error);
  }
}

/** Request one paginated Microsoft Graph To Do collection and normalize its envelope. */
export async function microsoftTodoCollectionRequest(
  pathOrUrl: string,
  deps: MicrosoftTodoRuntimeDeps,
  options: MicrosoftTodoRequestOptions = {},
): Promise<MicrosoftTodoCollectionResult> {
  const payload = requiredRecord(
    await microsoftTodoJsonRequest<unknown>(pathOrUrl, deps, options),
    "Microsoft To Do collection response",
    (message) => new ProviderRequestError(502, message),
  );
  if (!Array.isArray(payload.value)) {
    throw new ProviderRequestError(502, 'Microsoft To Do collection response is missing its "value" array.');
  }

  return {
    items: payload.value.map((item) =>
      requiredRecord(item, "Microsoft To Do collection item", (message) => new ProviderRequestError(502, message)),
    ),
    nextLink: optionalString(payload["@odata.nextLink"]) ?? null,
  };
}

/** Request a Microsoft Graph To Do response, including successful empty responses. */
export async function microsoftTodoRequest(
  pathOrUrl: string,
  deps: MicrosoftTodoRuntimeDeps,
  options: MicrosoftTodoRequestOptions = {},
): Promise<Response> {
  const url = buildMicrosoftTodoUrl(pathOrUrl, options.query, options.nextLinkKind);
  const hasBody = options.body !== undefined;
  const method = (options.method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  if ((method === "GET" || method === "HEAD") && hasBody) {
    throw new ProviderRequestError(400, `Microsoft To Do ${method} request must not include a body.`);
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
    await throwMicrosoftTodoResponseError(response);
  }
  return response;
}

function buildMicrosoftTodoUrl(
  pathOrUrl: string,
  query: Record<string, string | number | undefined> | undefined,
  nextLinkKind: MicrosoftTodoNextLinkKind | undefined,
): URL {
  const absolute = /^https?:\/\//iu.test(pathOrUrl);
  const url = absolute ? new URL(pathOrUrl) : new URL(pathOrUrl, `${graphBaseUrl}/`);
  if (url.origin !== graphOrigin || url.protocol !== "https:" || url.username || url.password) {
    throw new ProviderRequestError(400, `Microsoft To Do requests must target ${graphOrigin}.`);
  }
  if (absolute) {
    if (!nextLinkKind) {
      throw new ProviderRequestError(400, "Absolute Microsoft To Do URLs are accepted only as action nextLink values.");
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

function assertAllowedNextLink(url: URL, kind: MicrosoftTodoNextLinkKind): void {
  const patterns: Record<MicrosoftTodoNextLinkKind, RegExp> = {
    task_lists: /^\/v1\.0\/me\/todo\/lists\/?$/u,
    tasks: /^\/v1\.0\/me\/todo\/lists\/[^/]+\/tasks\/?$/u,
  };
  if (!patterns[kind].test(url.pathname)) {
    throw new ProviderRequestError(400, `nextLink does not match the expected Microsoft To Do ${kind} endpoint.`);
  }
}

async function throwMicrosoftTodoResponseError(response: Response): Promise<never> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: 1024 * 1024,
    fieldName: "Microsoft To Do error response",
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
    `Microsoft To Do request failed with HTTP ${response.status}.`;
  throw new ProviderRequestError(response.status, message, payload);
}
