import type { CredentialValidationResult } from "../../core/types.ts";
import type { PaperclipMethod, PaperclipOperation } from "./operations.ts";

import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed, readBoundedResponseBytes } from "../../core/request.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  normalizeProviderProxyEndpoint,
  providerUserAgent,
  ProviderRequestError,
} from "../provider-runtime.ts";
import { paperclipOperations } from "./operations.ts";

type PaperclipRequestPhase = "validate" | "execute";
type PaperclipActionHandler = (input: Record<string, unknown>, context: PaperclipActionContext) => Promise<unknown>;

interface PaperclipResponse {
  status: number;
  data: unknown;
}

interface PaperclipRequestOptions {
  method: PaperclipMethod;
  path: string;
  context: PaperclipActionContext;
  phase: PaperclipRequestPhase;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface PaperclipActionContext {
  baseUrl: string;
  origin: string;
  sessionCookie: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

const requestTimeoutMs = 60_000;
const maxResponseBytes = 10 * 1024 * 1024;
const sessionCookiePattern = /(?:^|,\s*)((?:__Secure-)?paperclip-default\.session_token)=([^;,]+)/iu;

export const paperclipActionHandlers: Record<string, PaperclipActionHandler> = {};
for (const operation of paperclipOperations) {
  paperclipActionHandlers[operation.name] = (input, context) => executePaperclipOperation(operation, input, context);
}
paperclipActionHandlers.api_request = executePaperclipApiRequest;

export async function createPaperclipContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<PaperclipActionContext> {
  const baseUrl = normalizePaperclipBaseUrl(values.baseUrl);
  const email = requiredString(values.email, "email", credentialError);
  const password = requiredString(values.password, "password", credentialError);
  const origin = new URL(baseUrl).origin;
  const sessionCookie = await signInPaperclip(baseUrl, origin, email, password, fetcher, signal);
  return { baseUrl, origin, sessionCookie, fetcher, signal };
}

export async function validatePaperclipCredential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = await createPaperclipContext(values, fetcher, signal);
  const response = await requestPaperclip({
    method: "GET",
    path: "/api/auth/get-session",
    context,
    phase: "validate",
  });
  const session = optionalRecord(response.data);
  const user = optionalRecord(session?.user);
  const accountId = optionalString(user?.id);
  const email = optionalString(user?.email) ?? optionalString(values.email);
  const displayName = optionalString(user?.name) ?? email;
  if (!accountId && !email) {
    throw credentialError("Paperclip returned a session without a board-user identity");
  }

  return {
    profile: {
      accountId: accountId ?? `paperclip:${email}`,
      displayName: displayName ? `${displayName} · ${new URL(context.baseUrl).host}` : new URL(context.baseUrl).host,
    },
    grantedScopes: [],
    metadata: { baseUrl: context.baseUrl },
  };
}

/**
 * Normalize a self-hosted Paperclip instance URL without retaining credentials,
 * a query string, or a fragment. Plain HTTP requires the deployment-level
 * private-network opt-in because the connector sends a board-user password.
 */
export function normalizePaperclipBaseUrl(
  value: unknown,
  allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed(),
): string {
  const raw = requiredString(value, "baseUrl", credentialError);
  const url = assertPublicHttpUrl(raw, {
    fieldName: "baseUrl",
    createError: credentialError,
    allowPrivateNetwork,
  });
  if (url.username || url.password) {
    throw credentialError("baseUrl must not include credentials");
  }
  if (url.protocol === "http:" && !allowPrivateNetwork) {
    throw credentialError("http baseUrl URLs require private-network access to be enabled");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function normalizePaperclipApiPath(value: unknown): string {
  const path = normalizeProviderProxyEndpoint(value);
  if (path.includes("?") || path.includes("#")) {
    throw new ProviderRequestError(400, "path must not contain a query string or fragment; use query instead");
  }
  if (path !== "/api" && !path.startsWith("/api/")) {
    throw new ProviderRequestError(400, "path must begin with /api/");
  }
  return path;
}

async function signInPaperclip(
  baseUrl: string,
  origin: string,
  email: string,
  password: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = createProviderTimeout(signal, requestTimeoutMs);
  try {
    const response = await fetcher(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin,
        "user-agent": providerUserAgent,
      },
      body: JSON.stringify({ email, password }),
      signal: timeout.signal,
    });
    const responseBody = await readPaperclipResponseBody(response);
    if (!response.ok) {
      throw new ProviderRequestError(
        [400, 401, 403].includes(response.status) ? 400 : response.status,
        readPaperclipErrorMessage(responseBody.data) ?? `Paperclip sign-in failed with HTTP ${response.status}`,
      );
    }
    const setCookie = response.headers.get("set-cookie") ?? "";
    const match = sessionCookiePattern.exec(setCookie);
    if (!match?.[1] || !match[2]) {
      throw credentialError("Paperclip signed in but did not return a board-user session cookie");
    }
    return `${match[1]}=${match[2]}`;
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(504, "Paperclip sign-in timed out");
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error
        ? `Paperclip sign-in failed: ${boundedMessage(error.message)}`
        : "Paperclip sign-in failed",
    );
  } finally {
    timeout.cleanup();
  }
}

async function executePaperclipOperation(
  operation: PaperclipOperation,
  input: Record<string, unknown>,
  context: PaperclipActionContext,
): Promise<unknown> {
  const path = buildPaperclipPath(operation.path, operation.pathFields, input);
  const query = pickFields(input, operation.queryFields);
  const body = operation.bodyObjectField
    ? (input[operation.bodyObjectField] ?? operation.defaultBody)
    : operation.bodyFields.length > 0
      ? pickFields(input, operation.bodyFields)
      : undefined;
  const response = await requestPaperclip({
    method: operation.method,
    path,
    context,
    phase: "execute",
    query,
    body,
  });
  return { [operation.outputField]: response.data };
}

async function executePaperclipApiRequest(
  input: Record<string, unknown>,
  context: PaperclipActionContext,
): Promise<PaperclipResponse> {
  const method = readPaperclipMethod(input.method);
  const path = normalizePaperclipApiPath(input.path);
  const response = await requestPaperclip({
    method,
    path,
    context,
    phase: "execute",
    query: optionalRecord(input.query),
    body: input.body,
  });
  return response;
}

async function requestPaperclip(options: PaperclipRequestOptions): Promise<PaperclipResponse> {
  const url = new URL(`${options.context.baseUrl}${options.path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) appendQueryValue(url, key, value);
  const timeout = createProviderTimeout(options.context.signal, requestTimeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      cookie: options.context.sessionCookie,
      origin: options.context.origin,
      "user-agent": providerUserAgent,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await options.context.fetcher(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: timeout.signal,
    });
    const responseBody = await readPaperclipResponseBody(response);
    if (!response.ok) {
      const message =
        readPaperclipErrorMessage(responseBody.data) ??
        (typeof responseBody.data === "string" ? boundedMessage(responseBody.data) : undefined) ??
        `Paperclip request failed with HTTP ${response.status}`;
      const status = options.phase === "validate" && [400, 401, 403].includes(response.status) ? 400 : response.status;
      throw new ProviderRequestError(status, message);
    }
    return { status: response.status, data: responseBody.data };
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(504, "Paperclip request timed out");
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error
        ? `Paperclip request failed: ${boundedMessage(error.message)}`
        : "Paperclip request failed",
    );
  } finally {
    timeout.cleanup();
  }
}

async function readPaperclipResponseBody(response: Response): Promise<{ data: unknown }> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxResponseBytes,
    fieldName: "Paperclip response",
    createError: (message) => new ProviderRequestError(413, message),
  });
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return { data: null };
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    try {
      const data: unknown = JSON.parse(text);
      return { data };
    } catch {
      throw new ProviderRequestError(502, "Paperclip returned invalid JSON");
    }
  }
  return { data: text };
}

function buildPaperclipPath(template: string, fields: readonly string[], input: Record<string, unknown>): string {
  let path = template;
  for (const field of fields) {
    const value = input[field];
    if (value == null) throw new ProviderRequestError(400, `${field} is required`);
    path = path.replaceAll(`{${field}}`, encodeURIComponent(String(value)));
  }
  return path;
}

function pickFields(input: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    if (input[field] !== undefined) output[field] = input[field];
  }
  return output;
}

function appendQueryValue(url: URL, key: string, value: unknown): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(url, key, item);
    return;
  }
  url.searchParams.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
}

function readPaperclipMethod(value: unknown): PaperclipMethod {
  const method = requiredString(value, "method", credentialError).toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return method as PaperclipMethod;
  throw new ProviderRequestError(400, "method must be GET, POST, PUT, PATCH, or DELETE");
}

function readPaperclipErrorMessage(payload: unknown): string | undefined {
  const record = optionalRecord(payload);
  const error = record?.error;
  const nestedError = optionalRecord(error);
  const message = optionalString(record?.message) ?? optionalString(nestedError?.message) ?? optionalString(error);
  return message ? boundedMessage(message) : undefined;
}

function boundedMessage(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 1_999)}…`;
}

function credentialError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}
