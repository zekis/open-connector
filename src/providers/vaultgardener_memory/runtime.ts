import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderRuntimeHandler } from "../provider-runtime.ts";

import {
  optionalBoolean,
  optionalInteger,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requiredString,
} from "../../core/cast.ts";
import { assertPublicHttpUrl, encodePathSegment, isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  providerUserAgent,
  ProviderRequestError,
  readProviderJsonBody,
  setSearchParams,
} from "../provider-runtime.ts";

type VaultGardenerMemoryRequestPhase = "validate" | "execute";

interface VaultGardenerMemoryRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
}

export interface VaultGardenerMemoryContext {
  apiKey: string;
  apiBaseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

const defaultRequestTimeoutMs = 60_000;
const maxResponseBytes = 16 * 1024 * 1024;
const maxErrorMessageCharacters = 8 * 1024;

export const vaultGardenerMemoryActionHandlers: Record<string, ProviderRuntimeHandler<VaultGardenerMemoryContext>> = {
  memory_map(input, context) {
    const limit = readOptionalRange(input.limit, "limit", 4, 50);
    return requestVaultGardenerMemoryJson(
      {
        method: "GET",
        path: "/v1/memory/map",
        query: {
          query: optionalString(input.query),
          limit: limit === undefined ? undefined : String(limit),
        },
      },
      context,
    );
  },
  memory_session_state(input, context) {
    const sessionId = requiredString(input.session_id, "session_id", inputError);
    const limit = readOptionalRange(input.limit, "limit", 1, 50);
    return requestVaultGardenerMemoryJson(
      {
        method: "GET",
        path: `/v1/sessions/${encodePathSegment(sessionId)}/state`,
        query: { limit: limit === undefined ? undefined : String(limit) },
      },
      context,
    );
  },
  memory_search(input, context) {
    return requestVaultGardenerMemoryJson(
      {
        method: "POST",
        path: "/v1/knowledge/search",
        body: compactBody({
          query: requiredString(input.query, "query", inputError),
          session_id: requiredString(input.session_id, "session_id", inputError),
          limit: readOptionalRange(input.limit, "limit", 1, 12),
        }),
      },
      context,
    );
  },
  memory_read(input, context) {
    return requestVaultGardenerMemoryJson(
      {
        method: "POST",
        path: "/v1/knowledge/read",
        body: compactBody({
          path: requiredString(input.path, "path", inputError),
          session_id: requiredString(input.session_id, "session_id", inputError),
          related_limit: readOptionalRange(input.related_limit, "related_limit", 0, 12),
        }),
      },
      context,
    );
  },
  memory_capture(input, context) {
    return requestVaultGardenerMemoryJson(
      {
        method: "POST",
        path: "/v1/knowledge/capture",
        body: compactBody({
          title: requiredString(input.title, "title", inputError),
          content: requiredString(input.content, "content", inputError),
          source_type: requiredString(input.source_type, "source_type", inputError),
          source_system: requiredString(input.source_system, "source_system", inputError),
          source_id: requiredString(input.source_id, "source_id", inputError),
          session_id: requiredString(input.session_id, "session_id", inputError),
          occurred_at: requiredString(input.occurred_at, "occurred_at", inputError),
          thread_id: optionalString(input.thread_id),
          participants: optionalStringArray(input.participants),
          project: optionalString(input.project),
          status: optionalString(input.status),
          metadata: optionalRecord(input.metadata),
        }),
      },
      context,
    );
  },
  memory_feedback(input, context) {
    const memoryId = readOptionalPositiveInteger(input.memory_id, "memory_id");
    const sourceFile = optionalString(input.source_file);
    if (!memoryId && !sourceFile) throw inputError("memory_feedback requires memory_id or source_file");
    return requestVaultGardenerMemoryJson(
      {
        method: "POST",
        path: "/v1/memory/feedback",
        body: compactBody({
          session_id: requiredString(input.session_id, "session_id", inputError),
          verdict: readVerdict(input.verdict),
          memory_id: memoryId,
          source_file: sourceFile,
          notes: optionalString(input.notes),
        }),
      },
      context,
    );
  },
  async memory_session_reset(input, context) {
    const sessionId = requiredString(input.session_id, "session_id", inputError);
    const response = await requestVaultGardenerMemoryJson(
      {
        method: "DELETE",
        path: `/v1/sessions/${encodePathSegment(sessionId)}`,
      },
      context,
    );
    return { session_id: sessionId, reset: true, response };
  },
  curation_status(_input, context) {
    return requestVaultGardenerMemoryJson({ method: "GET", path: "/v1/curation/status" }, context);
  },
  curation_scan(input, context) {
    return requestVaultGardenerMemoryJson(
      {
        method: "POST",
        path: "/v1/curation/scan",
        body: compactBody({
          paths: optionalStringArray(input.paths),
          force: optionalBoolean(input.force),
        }),
      },
      context,
    );
  },
  curation_review(input, context) {
    const enqueueIfMissing = optionalBoolean(input.enqueue_if_missing);
    return requestVaultGardenerMemoryJson(
      {
        method: "GET",
        path: "/v1/curation/review",
        query: {
          path: requiredString(input.path, "path", inputError),
          enqueue_if_missing: enqueueIfMissing === undefined ? undefined : String(enqueueIfMissing),
        },
      },
      context,
    );
  },
  curation_list(input, context) {
    const limit = readOptionalRange(input.limit, "limit", 1, 200);
    const offset = readOptionalNonNegativeInteger(input.offset, "offset");
    return requestVaultGardenerMemoryJson(
      {
        method: "GET",
        path: "/v1/curation/proposals",
        query: {
          status: optionalString(input.status),
          action: optionalString(input.action),
          limit: limit === undefined ? undefined : String(limit),
          offset: offset === undefined ? undefined : String(offset),
        },
      },
      context,
    );
  },
  curation_approve(input, context) {
    return requestVaultGardenerCurationDecision("approve", input, context, {
      reviewed_by: requiredString(input.reviewed_by, "reviewed_by", inputError),
      notes: optionalString(input.notes),
      apply: optionalBoolean(input.apply),
    });
  },
  curation_reject(input, context) {
    return requestVaultGardenerCurationDecision("reject", input, context, {
      reviewed_by: requiredString(input.reviewed_by, "reviewed_by", inputError),
      notes: optionalString(input.notes),
    });
  },
  curation_undo(input, context) {
    return requestVaultGardenerCurationDecision("undo", input, context, {
      requested_by: requiredString(input.requested_by, "requested_by", inputError),
      notes: optionalString(input.notes),
    });
  },
};

export function createVaultGardenerMemoryContext(
  values: Record<string, string>,
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): VaultGardenerMemoryContext {
  return {
    apiKey,
    apiBaseUrl: normalizeVaultGardenerMemoryBaseUrl(values.baseUrl),
    fetcher,
    signal,
  };
}

export async function validateVaultGardenerMemoryCredential(
  values: Record<string, string>,
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createVaultGardenerMemoryContext(values, apiKey, fetcher, signal);
  const health = await requestVaultGardenerMemoryJson({ method: "GET", path: "/health" }, context, "validate");
  const healthRecord = optionalRecord(health);
  return {
    profile: {
      accountId: context.apiBaseUrl,
      displayName: `VaultGardener Memory · ${new URL(context.apiBaseUrl).host}`,
    },
    grantedScopes: [],
    metadata: compactBody({
      apiBaseUrl: context.apiBaseUrl,
      status: optionalString(healthRecord?.status),
      indexStatus: healthRecord?.index,
    }),
  };
}

/** Validates and normalizes the editable VaultGardener REST base URL. */
export function normalizeVaultGardenerMemoryBaseUrl(
  value: unknown,
  allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed(),
): string {
  const baseUrl = requiredString(value, "baseUrl", credentialError);
  const url = assertPublicHttpUrl(baseUrl, {
    fieldName: "baseUrl",
    createError: credentialError,
    allowPrivateNetwork,
  });
  if (url.username || url.password) throw credentialError("baseUrl must not include credentials");
  if (url.hash || url.search) throw credentialError("baseUrl must not include a query string or fragment");
  const path = url.pathname.replace(/\/+$/u, "");
  if (path.endsWith("/mcp") || /\/v1(?:\/|$)/u.test(path)) {
    throw credentialError("baseUrl must be the REST service root, not /mcp or a /v1 operation path");
  }
  url.pathname = path || "/";
  return url.toString().replace(/\/$/u, "");
}

async function requestVaultGardenerMemoryJson(
  request: VaultGardenerMemoryRequest,
  context: VaultGardenerMemoryContext,
  phase: VaultGardenerMemoryRequestPhase = "execute",
): Promise<unknown> {
  const timeout = createProviderTimeout(context.signal, defaultRequestTimeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${context.apiKey}`,
      "user-agent": providerUserAgent,
    };
    if (request.body) headers["content-type"] = "application/json";
    const url = new URL(`${context.apiBaseUrl}${request.path}`);
    setSearchParams(url, request.query ?? {});
    const response = await context.fetcher(url.toString(), {
      method: request.method,
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: timeout.signal,
    });
    const payload = await readProviderJsonBody(response, {
      emptyBody: null,
      invalidJsonMessage: "VaultGardener Memory returned invalid JSON",
      maxBytes: maxResponseBytes,
    });
    if (!response.ok) throw createVaultGardenerMemoryError(response.status, payload, phase);
    return payload;
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(504, "VaultGardener Memory request timed out");
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error
        ? `VaultGardener Memory request failed: ${boundedMessage(error.message)}`
        : "VaultGardener Memory request failed",
    );
  } finally {
    timeout.cleanup();
  }
}

function createVaultGardenerMemoryError(
  status: number,
  payload: unknown,
  phase: VaultGardenerMemoryRequestPhase,
): ProviderRequestError {
  const message = extractErrorMessage(payload) ?? `VaultGardener Memory returned HTTP ${status}`;
  const mappedStatus = phase === "validate" && [400, 401, 403, 404, 422].includes(status) ? 400 : status;
  return new ProviderRequestError(mappedStatus || 502, boundedMessage(message));
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") return optionalString(payload);
  const record = optionalRecord(payload);
  if (!record) return undefined;
  return optionalString(record.detail) ?? optionalString(record.message) ?? optionalString(record.error);
}

function compactBody(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function readOptionalRange(value: unknown, fieldName: string, minimum: number, maximum: number): number | undefined {
  const number = optionalInteger(value);
  if (number === undefined) return undefined;
  if (number < minimum || number > maximum) {
    throw inputError(`${fieldName} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function readOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  const number = optionalInteger(value);
  if (number === undefined) return undefined;
  if (number < 1) throw inputError(`${fieldName} must be a positive integer`);
  return number;
}

function readRequiredPositiveInteger(value: unknown, fieldName: string): number {
  const number = readOptionalPositiveInteger(value, fieldName);
  if (number === undefined) throw inputError(`${fieldName} must be a positive integer`);
  return number;
}

function readOptionalNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  const number = optionalInteger(value);
  if (number === undefined) return undefined;
  if (number < 0) throw inputError(`${fieldName} must be a non-negative integer`);
  return number;
}

function requestVaultGardenerCurationDecision(
  decision: "approve" | "reject" | "undo",
  input: Record<string, unknown>,
  context: VaultGardenerMemoryContext,
  body: Record<string, unknown>,
): Promise<unknown> {
  const proposalId = readRequiredPositiveInteger(input.proposal_id, "proposal_id");
  return requestVaultGardenerMemoryJson(
    {
      method: "POST",
      path: `/v1/curation/proposals/${proposalId}/${decision}`,
      body: compactBody(body),
    },
    context,
  );
}

function readVerdict(value: unknown): string {
  const verdict = requiredString(value, "verdict", inputError);
  if (["useful", "irrelevant", "contradicted", "resolved"].includes(verdict)) return verdict;
  throw inputError("verdict must be useful, irrelevant, contradicted, or resolved");
}

function boundedMessage(value: string): string {
  const message = value.trim();
  return message.length <= maxErrorMessageCharacters ? message : `${message.slice(0, maxErrorMessageCharacters - 1)}…`;
}

function credentialError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function inputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}
