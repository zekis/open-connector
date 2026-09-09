import type { CredentialValidationResult } from "../../core/types.ts";
import type { AssetGatewayMethod, AssetGatewayOperation, AssetGatewayResponseKind } from "./operations.ts";

import {
  integer,
  nullableInteger,
  objectArray,
  optionalRecord,
  optionalString,
  requiredRecord,
  requiredString,
  requiredStringArray,
} from "../../core/cast.ts";
import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed, readBoundedResponseBytes } from "../../core/request.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  providerUserAgent,
  ProviderRequestError,
} from "../provider-runtime.ts";
import { assetGatewayOperations } from "./operations.ts";

type AssetGatewayRequestPhase = "validate" | "execute";
type AssetGatewayActionHandler = (
  input: Record<string, unknown>,
  context: AssetGatewayActionContext,
) => Promise<unknown>;

interface AssetGatewayResponse {
  status: number;
  data: unknown;
  etag?: string;
  location?: string;
}

interface AssetGatewayRequestOptions {
  method: AssetGatewayMethod;
  path: string;
  context: AssetGatewayActionContext;
  phase: AssetGatewayRequestPhase;
  query?: Record<string, unknown>;
  body?: unknown;
  etag?: string;
}

export interface AssetGatewayActionContext {
  apiKey: string;
  apiBaseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

const requestTimeoutMs = 30_000;
const maxResponseBytes = 5 * 1024 * 1024;
const maxErrorMessageCharacters = 2_000;

export const assetGatewayActionHandlers: Record<string, AssetGatewayActionHandler> = {};
for (const operation of assetGatewayOperations) {
  assetGatewayActionHandlers[operation.name] = (input, context) =>
    executeAssetGatewayOperation(operation, input, context);
}

export function createAssetGatewayContext(
  values: Record<string, string>,
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): AssetGatewayActionContext {
  return {
    apiKey: requiredString(apiKey, "apiKey", credentialError),
    apiBaseUrl: normalizeAssetGatewayApiBaseUrl(values.baseUrl),
    fetcher,
    signal,
  };
}

export async function validateAssetGatewayCredential(
  values: Record<string, string>,
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createAssetGatewayContext(values, apiKey, fetcher, signal);
  const response = await requestAssetGateway({
    method: "GET",
    path: "/metadata",
    context,
    phase: "validate",
  });
  normalizeAssetGatewayResponse("metadata", undefined, response);
  const host = new URL(context.apiBaseUrl).host;
  return {
    profile: {
      accountId: `asset_gateway:${host}`,
      displayName: `Asset Gateway · ${host}`,
    },
    grantedScopes: [],
    metadata: { apiBaseUrl: context.apiBaseUrl },
  };
}

/**
 * Normalize a portal root or management API URL and enforce the shared SSRF policy.
 * Plain HTTP and private-network targets require the deployment-level private-network opt-in.
 */
export function normalizeAssetGatewayApiBaseUrl(
  value: unknown,
  allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed(),
): string {
  const raw = requiredString(value, "baseUrl", credentialError);
  const url = assertPublicHttpUrl(raw, {
    fieldName: "baseUrl",
    createError: credentialError,
    allowPrivateNetwork,
  });
  if (url.username || url.password) throw credentialError("baseUrl must not include credentials");
  if (url.protocol === "http:" && !allowPrivateNetwork) {
    throw credentialError("http baseUrl URLs require private-network access to be enabled");
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/u, "");
  if (path === "") {
    url.pathname = "/api/v1";
  } else if (!path.endsWith("/api/v1")) {
    throw credentialError("baseUrl must be the portal root or end with /api/v1");
  } else {
    url.pathname = path;
  }
  return url.toString().replace(/\/$/u, "");
}

async function executeAssetGatewayOperation(
  operation: AssetGatewayOperation,
  input: Record<string, unknown>,
  context: AssetGatewayActionContext,
): Promise<unknown> {
  const path = buildAssetGatewayPath(operation, input);
  const query: Record<string, unknown> = {};
  for (const field of operation.queryFields ?? []) {
    if (input[field.input] !== undefined) query[field.parameter] = input[field.input];
  }
  const body = operation.bodyField ? input[operation.bodyField] : undefined;
  const etag = operation.etagField
    ? requiredString(input[operation.etagField], operation.etagField, requestError)
    : undefined;
  const response = await requestAssetGateway({
    method: operation.method,
    path,
    context,
    phase: "execute",
    query,
    body,
    etag,
  });
  return normalizeAssetGatewayResponse(operation.responseKind, operation.outputField, response);
}

async function requestAssetGateway(options: AssetGatewayRequestOptions): Promise<AssetGatewayResponse> {
  const url = new URL(`${options.context.apiBaseUrl}${options.path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(name, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    }
  }
  const timeout = createProviderTimeout(options.context.signal, requestTimeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${options.context.apiKey}`,
      "user-agent": providerUserAgent,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.etag) headers["if-match"] = options.etag;
    const response = await options.context.fetcher(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: timeout.signal,
    });
    const responseBody = await readAssetGatewayResponseBody(response);
    if (!response.ok) {
      const error = optionalRecord(responseBody)?.error;
      const message =
        (typeof error === "string" ? boundedMessage(error) : undefined) ??
        (typeof responseBody === "string" ? boundedMessage(responseBody) : undefined) ??
        `Asset Gateway request failed with HTTP ${response.status}`;
      const status = options.phase === "validate" && [400, 401, 403].includes(response.status) ? 400 : response.status;
      throw new ProviderRequestError(status, message);
    }
    return {
      status: response.status,
      data: responseBody,
      etag: optionalString(response.headers.get("etag")),
      location: optionalString(response.headers.get("location")),
    };
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    const possiblyCommitted =
      options.method === "POST" ? " The request may have succeeded; reconcile before retrying." : "";
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(504, `Asset Gateway request timed out.${possiblyCommitted}`);
    }
    const detail = error instanceof Error ? `: ${boundedMessage(error.message)}` : "";
    throw new ProviderRequestError(502, `Asset Gateway request failed${detail}.${possiblyCommitted}`);
  } finally {
    timeout.cleanup();
  }
}

async function readAssetGatewayResponseBody(response: Response): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxResponseBytes,
    fieldName: "Asset Gateway response",
    createError: (message) => new ProviderRequestError(413, message),
  });
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return text;
    throw new ProviderRequestError(502, "Asset Gateway returned invalid JSON");
  }
}

function normalizeAssetGatewayResponse(
  kind: AssetGatewayResponseKind,
  outputField: string | undefined,
  response: AssetGatewayResponse,
): unknown {
  const payload = requiredRecord(response.data, "Asset Gateway response", responseError);
  if (kind === "metadata") {
    return {
      companies: objectArray(payload.companies, "companies", responseError),
      assetTypes: objectArray(payload.asset_types, "asset_types", responseError),
      assetTemplates: objectArray(payload.asset_templates, "asset_templates", responseError),
      statuses: requiredRecord(payload.statuses, "statuses", responseError),
      priorities: requiredStringArray(payload.priorities, "priorities", responseError),
    };
  }
  if (kind === "list") {
    return {
      [requiredOutputField(outputField)]: objectArray(payload.data, "data", responseError),
      total: integer(payload.total, "total", responseError),
      limit: integer(payload.limit, "limit", responseError),
      offset: integer(payload.offset, "offset", responseError),
    };
  }
  if (kind === "history") {
    const nextBeforeId = nullableInteger(payload.next_before_id);
    if (nextBeforeId === undefined) throw responseError("next_before_id must be an integer or null");
    return {
      events: objectArray(payload.data, "data", responseError),
      nextBeforeId,
    };
  }
  if (kind === "comment") {
    if (payload.ok !== true) throw responseError("comment response did not confirm success");
    return { ok: true };
  }
  const etag = requiredString(response.etag, "ETag response header", responseError);
  const normalized: Record<string, unknown> = {
    [requiredOutputField(outputField)]: requiredRecord(payload.data, "data", responseError),
    revision: requiredString(payload.revision, "revision", responseError),
    etag,
  };
  if (kind === "created_record") {
    normalized.location = requiredString(response.location, "Location response header", responseError);
  }
  return normalized;
}

function buildAssetGatewayPath(operation: AssetGatewayOperation, input: Record<string, unknown>): string {
  if (!operation.pathField) return operation.path;
  const id = integer(input[operation.pathField], operation.pathField, requestError);
  if (id < 1) throw requestError(`${operation.pathField} must be a positive integer`);
  return operation.path.replace("{id}", String(id));
}

function requiredOutputField(value: string | undefined): string {
  if (!value) throw new ProviderRequestError(500, "Asset Gateway operation is missing its output field");
  return value;
}

function boundedMessage(value: string): string {
  const message = value.trim();
  return message.length <= maxErrorMessageCharacters ? message : `${message.slice(0, maxErrorMessageCharacters - 1)}…`;
}

function credentialError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function requestError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function responseError(message: string): ProviderRequestError {
  return new ProviderRequestError(502, `Asset Gateway returned an invalid response: ${message}`);
}
