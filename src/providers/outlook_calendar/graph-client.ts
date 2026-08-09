import type { OAuthProviderContext } from "../provider-runtime.ts";

import { optionalString, requiredRecord } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";

const graphBaseUrl = "https://graph.microsoft.com/v1.0";
const graphOrigin = new URL(graphBaseUrl).origin;
const maxGraphJsonBytes = 4 * 1024 * 1024;

export type OutlookCalendarRuntimeDeps = OAuthProviderContext;
export type OutlookCalendarActionHandler = (
  input: Record<string, unknown>,
  deps: OutlookCalendarRuntimeDeps,
) => Promise<unknown>;

export type OutlookCalendarNextLinkKind = "calendars" | "calendar_view";

export interface OutlookCalendarRequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  nextLinkKind?: OutlookCalendarNextLinkKind;
}

export interface OutlookCalendarCollectionResult {
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

/** Request one JSON resource from the Microsoft Graph calendar APIs. */
export async function outlookCalendarJsonRequest<T>(
  pathOrUrl: string,
  deps: OutlookCalendarRuntimeDeps,
  options: OutlookCalendarRequestOptions = {},
): Promise<T> {
  const response = await outlookCalendarRequest(pathOrUrl, deps, options);
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxGraphJsonBytes,
    fieldName: "Outlook Calendar JSON response",
    createError: (message) => new ProviderRequestError(502, message),
  });
  if (bytes.byteLength === 0) {
    throw new ProviderRequestError(502, "Outlook Calendar returned an empty JSON response.");
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new ProviderRequestError(502, "Outlook Calendar returned invalid JSON.", error);
  }
}

/** Request one paginated Microsoft Graph calendar collection and normalize its envelope. */
export async function outlookCalendarCollectionRequest(
  pathOrUrl: string,
  deps: OutlookCalendarRuntimeDeps,
  options: OutlookCalendarRequestOptions = {},
): Promise<OutlookCalendarCollectionResult> {
  const payload = requiredRecord(
    await outlookCalendarJsonRequest<unknown>(pathOrUrl, deps, options),
    "Outlook Calendar collection response",
    (message) => new ProviderRequestError(502, message),
  );
  if (!Array.isArray(payload.value)) {
    throw new ProviderRequestError(502, 'Outlook Calendar collection response is missing its "value" array.');
  }

  return {
    items: payload.value.map((item) =>
      requiredRecord(item, "Outlook Calendar collection item", (message) => new ProviderRequestError(502, message)),
    ),
    nextLink: optionalString(payload["@odata.nextLink"]) ?? null,
  };
}

/** Request a Microsoft Graph calendar response, including successful empty responses. */
export async function outlookCalendarRequest(
  pathOrUrl: string,
  deps: OutlookCalendarRuntimeDeps,
  options: OutlookCalendarRequestOptions = {},
): Promise<Response> {
  const url = buildOutlookCalendarUrl(pathOrUrl, options.query, options.nextLinkKind);
  const hasBody = options.body !== undefined;
  const method = (options.method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  if ((method === "GET" || method === "HEAD") && hasBody) {
    throw new ProviderRequestError(400, `Outlook Calendar ${method} request must not include a body.`);
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
    await throwOutlookCalendarResponseError(response);
  }
  return response;
}

function buildOutlookCalendarUrl(
  pathOrUrl: string,
  query: Record<string, string | number | undefined> | undefined,
  nextLinkKind: OutlookCalendarNextLinkKind | undefined,
): URL {
  const absolute = /^https?:\/\//iu.test(pathOrUrl);
  const url = absolute ? new URL(pathOrUrl) : new URL(pathOrUrl, `${graphBaseUrl}/`);
  if (url.origin !== graphOrigin || url.protocol !== "https:" || url.username || url.password) {
    throw new ProviderRequestError(400, `Outlook Calendar requests must target ${graphOrigin}.`);
  }
  if (absolute) {
    if (!nextLinkKind) {
      throw new ProviderRequestError(
        400,
        "Absolute Outlook Calendar URLs are accepted only as action nextLink values.",
      );
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

function assertAllowedNextLink(url: URL, kind: OutlookCalendarNextLinkKind): void {
  const patterns: Record<OutlookCalendarNextLinkKind, RegExp> = {
    calendars: /^\/v1\.0\/me\/calendars\/?$/u,
    calendar_view: /^\/v1\.0\/me\/(?:calendarView|calendars\/[^/]+\/calendarView)\/?$/u,
  };
  if (!patterns[kind].test(url.pathname)) {
    throw new ProviderRequestError(400, `nextLink does not match the expected Outlook Calendar ${kind} endpoint.`);
  }
}

async function throwOutlookCalendarResponseError(response: Response): Promise<never> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: 1024 * 1024,
    fieldName: "Outlook Calendar error response",
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
    `Outlook Calendar request failed with HTTP ${response.status}.`;
  throw new ProviderRequestError(response.status, message, payload);
}
