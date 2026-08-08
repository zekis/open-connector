import type { ApiKeyProviderContext } from "../provider-runtime.ts";

import { optionalString, requiredRecord } from "../../core/cast.ts";
import { encodePathSegment, readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";

const azureDevOpsOrigin = "https://dev.azure.com";
const maxAzureDevOpsJsonBytes = 4 * 1024 * 1024;
const maxAzureDevOpsErrorBytes = 1024 * 1024;

export interface AzureDevOpsRuntimeDeps extends Pick<ApiKeyProviderContext, "fetcher" | "signal"> {
  authorization: string;
  organization: string;
}

export type AzureDevOpsActionHandler = (
  input: Record<string, unknown>,
  deps: AzureDevOpsRuntimeDeps,
) => Promise<unknown>;

export interface AzureDevOpsRequestOptions {
  method?: "GET" | "POST" | "PATCH";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
}

export interface AzureDevOpsJsonResponse<T> {
  body: T;
  continuationToken: string | null;
}

interface AzureDevOpsErrorPayload {
  message?: unknown;
  typeName?: unknown;
  typeKey?: unknown;
  errorCode?: unknown;
  eventId?: unknown;
}

/** Resolve an action organization override or the organization stored with a PAT connection. */
export function resolveAzureDevOpsOrganization(input: Record<string, unknown>, deps: AzureDevOpsRuntimeDeps): string {
  return optionalString(input.organization) ?? deps.organization;
}

/** Build a project-scoped REST path without allowing input to control the request host. */
export function azureDevOpsProjectPath(project: string | undefined, path: string): string {
  const normalizedPath = path.replace(/^\/+|\/+$/gu, "");
  return project ? `${encodePathSegment(project)}/${normalizedPath}` : normalizedPath;
}

/** Request one JSON resource from the Azure DevOps Services organization API. */
export async function azureDevOpsJsonRequest<T>(
  organization: string,
  path: string,
  deps: AzureDevOpsRuntimeDeps,
  options: AzureDevOpsRequestOptions = {},
): Promise<AzureDevOpsJsonResponse<T>> {
  const baseUrl = `${azureDevOpsOrigin}/${encodePathSegment(organization)}/`;
  const url = new URL(path.replace(/^\/+/u, ""), baseUrl);
  if (url.origin !== azureDevOpsOrigin || !url.pathname.startsWith(`/${encodePathSegment(organization)}/`)) {
    throw new ProviderRequestError(400, "Azure DevOps request path is invalid.");
  }
  return azureDevOpsJsonUrlRequest<T>(url, deps, options);
}

/** Read and validate Azure DevOps' standard collection envelope. */
export function readAzureDevOpsCollection(value: unknown, fieldName: string): Array<Record<string, unknown>> {
  const payload = requiredRecord(value, `${fieldName} response`, (message) => new ProviderRequestError(502, message));
  if (!Array.isArray(payload.value)) {
    throw new ProviderRequestError(502, `${fieldName} response is missing its value array.`);
  }
  return payload.value.map((item) =>
    requiredRecord(item, `${fieldName} item`, (message) => new ProviderRequestError(502, message)),
  );
}

async function azureDevOpsJsonUrlRequest<T>(
  url: URL,
  deps: AzureDevOpsRuntimeDeps,
  options: AzureDevOpsRequestOptions,
): Promise<AzureDevOpsJsonResponse<T>> {
  if (url.origin !== azureDevOpsOrigin) {
    throw new ProviderRequestError(400, "Azure DevOps requests must target an official Azure DevOps Services host.");
  }
  if (!url.searchParams.has("api-version")) {
    url.searchParams.set("api-version", "7.1");
  }
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers({
    accept: "application/json",
    authorization: deps.authorization,
  });
  if (options.body !== undefined) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  const response = await deps.fetcher(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: deps.signal,
  });
  if (!response.ok) {
    await throwAzureDevOpsResponseError(response);
  }

  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxAzureDevOpsJsonBytes,
    fieldName: "Azure DevOps JSON response",
    createError: (message) => new ProviderRequestError(502, message),
  });
  if (bytes.byteLength === 0) {
    throw new ProviderRequestError(502, "Azure DevOps returned an empty JSON response.");
  }

  try {
    return {
      body: JSON.parse(new TextDecoder().decode(bytes)) as T,
      continuationToken: optionalString(response.headers.get("x-ms-continuationtoken")) ?? null,
    };
  } catch (error) {
    throw new ProviderRequestError(502, "Azure DevOps returned invalid JSON.", error);
  }
}

async function throwAzureDevOpsResponseError(response: Response): Promise<never> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxAzureDevOpsErrorBytes,
    fieldName: "Azure DevOps error response",
    createError: (message) => new ProviderRequestError(502, message),
  });
  const text = new TextDecoder().decode(bytes);
  let payload: AzureDevOpsErrorPayload | undefined;
  try {
    payload = text ? (JSON.parse(text) as AzureDevOpsErrorPayload) : undefined;
  } catch {
    payload = undefined;
  }
  const message =
    optionalString(payload?.message) ??
    optionalString(text) ??
    `Azure DevOps request failed with HTTP ${response.status}.`;
  throw new ProviderRequestError(response.status === 404 ? 400 : response.status, message, payload);
}
