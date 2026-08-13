import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderFetch, ProviderRuntimeHandler } from "../provider-runtime.ts";

import {
  optionalBoolean,
  optionalIntegerLike,
  optionalRecord,
  optionalScalarString,
  optionalString,
  positiveInteger,
  requiredRecord,
  requiredString,
} from "../../core/cast.ts";
import { jsonObject } from "../../core/request.ts";
import {
  createProviderTimeout,
  isAbortSignalError,
  providerUserAgent,
  ProviderRequestError,
  readProviderJsonBody,
} from "../provider-runtime.ts";

export const binaryLaneApiBaseUrl = "https://api.binarylane.com.au/v2";

const requestTimeoutMs = 30_000;

type BinaryLaneRequestPhase = "validate" | "execute";

interface BinaryLaneRequestInput {
  apiKey: string;
  path: string;
  fetcher: ProviderFetch;
  phase: BinaryLaneRequestPhase;
  signal?: AbortSignal;
  query?: Record<string, unknown>;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}

export const binaryLaneActionHandlers: Record<string, ProviderRuntimeHandler<ApiKeyProviderContext>> = {
  async get_account(_input, context) {
    return { account: await getAccount(context, "execute") };
  },
  list_servers(input, context) {
    return listCollection(input, context, "/servers", "servers", {
      hostname: optionalString(input.hostname),
    });
  },
  async get_server(input, context) {
    const serverId = positiveInteger(input.serverId, "serverId", providerInputError);
    const payload = await requestBinaryLaneJson({
      ...context,
      path: `/servers/${serverId}`,
      phase: "execute",
    });
    return { server: requireWrappedObject(payload, "server") };
  },
  list_server_actions(input, context) {
    const serverId = positiveInteger(input.serverId, "serverId", providerInputError);
    return listCollection(input, context, `/servers/${serverId}/actions`, "actions");
  },
  async get_action(input, context) {
    const actionId = positiveInteger(input.actionId, "actionId", providerInputError);
    const payload = await requestBinaryLaneJson({
      ...context,
      path: `/actions/${actionId}`,
      phase: "execute",
    });
    return { action: requireWrappedObject(payload, "action") };
  },
  ping_server(input, context) {
    return performServerCommand(input, context, "ping");
  },
  get_server_uptime(input, context) {
    return performServerCommand(input, context, "uptime");
  },
  power_on_server(input, context) {
    return performServerCommand(input, context, "power_on");
  },
  power_off_server(input, context) {
    return performServerCommand(input, context, "power_off");
  },
  reboot_server(input, context) {
    return performServerCommand(input, context, "reboot");
  },
  shutdown_server(input, context) {
    return performServerCommand(input, context, "shutdown");
  },
  power_cycle_server(input, context) {
    return performServerCommand(input, context, "power_cycle");
  },
  list_regions(input, context) {
    return listCollection(input, context, "/regions", "regions");
  },
  list_sizes(input, context) {
    return listCollection(input, context, "/sizes", "sizes", {
      server_id: readOptionalPositiveInteger(input.serverId, "serverId"),
      image: optionalScalarString(input.image),
    });
  },
};

export async function validateBinaryLaneCredential(
  apiKey: string,
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const account = await getAccount({ apiKey, fetcher, signal }, "validate");
  const email = requiredString(account.email, "account.email", providerResponseError);

  return {
    profile: {
      accountId: email,
      displayName: email,
    },
    grantedScopes: [],
    metadata: jsonObject({
      validationEndpoint: "/account",
      accountStatus: optionalString(account.status),
      emailVerified: optionalBoolean(account.email_verified),
      twoFactorAuthenticationEnabled: optionalBoolean(account.two_factor_authentication_enabled),
    }),
  };
}

async function getAccount(
  context: Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">,
  phase: BinaryLaneRequestPhase,
): Promise<Record<string, unknown>> {
  const payload = await requestBinaryLaneJson({
    ...context,
    path: "/account",
    phase,
  });
  return requireWrappedObject(payload, "account");
}

async function listCollection(
  input: Record<string, unknown>,
  context: ApiKeyProviderContext,
  path: string,
  fieldName: string,
  filters: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const payload = await requestBinaryLaneJson({
    ...context,
    path,
    query: {
      page: readOptionalPositiveInteger(input.page, "page"),
      per_page: readOptionalPerPage(input.perPage),
      ...filters,
    },
    phase: "execute",
  });
  const record = requiredRecord(payload, "BinaryLane response", providerResponseError);
  const items = record[fieldName];
  if (!Array.isArray(items)) {
    throw providerResponseError(`BinaryLane response missing ${fieldName}`);
  }
  return jsonObject({
    [fieldName]: items.map((item) => requiredRecord(item, fieldName, providerResponseError)),
    meta: requiredRecord(record.meta, "meta", providerResponseError),
    links: record.links === null ? null : optionalRecord(record.links),
  });
}

async function performServerCommand(
  input: Record<string, unknown>,
  context: ApiKeyProviderContext,
  type: string,
): Promise<Record<string, unknown>> {
  const serverId = positiveInteger(input.serverId, "serverId", providerInputError);
  const payload = await requestBinaryLaneJson({
    ...context,
    path: `/servers/${serverId}/actions`,
    method: "POST",
    body: { type },
    phase: "execute",
  });
  return {
    accepted: true,
    action: payload === null ? null : requireWrappedObject(payload, "action"),
  };
}

async function requestBinaryLaneJson(input: BinaryLaneRequestInput): Promise<unknown> {
  const response = await binaryLaneFetch(input);
  const payload = await readProviderJsonBody(response, {
    emptyBody: null,
    invalidJsonMessage: "BinaryLane returned invalid JSON",
  });
  if (!response.ok) {
    throw createBinaryLaneError(response.status, payload, input.phase);
  }
  return payload;
}

async function binaryLaneFetch(input: BinaryLaneRequestInput): Promise<Response> {
  const url = new URL(`${binaryLaneApiBaseUrl}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const timeout = createProviderTimeout(input.signal, requestTimeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${input.apiKey}`,
      "user-agent": providerUserAgent,
    };
    if (input.body !== undefined) headers["content-type"] = "application/json";
    return await input.fetcher(url, {
      method: input.method ?? "GET",
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: timeout.signal,
    });
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new ProviderRequestError(504, "BinaryLane request timed out", error);
    }
    if (isAbortSignalError(input.signal, error)) {
      throw new ProviderRequestError(499, "BinaryLane request was cancelled", error);
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `BinaryLane request failed: ${error.message}` : "BinaryLane request failed",
      error,
    );
  } finally {
    timeout.cleanup();
  }
}

function createBinaryLaneError(status: number, payload: unknown, phase: BinaryLaneRequestPhase): ProviderRequestError {
  const message = extractBinaryLaneErrorMessage(payload) ?? `BinaryLane request failed with status ${status}`;
  if ((status === 401 || status === 403) && phase === "validate") {
    return new ProviderRequestError(400, message, payload);
  }
  return new ProviderRequestError(status || 502, message, payload);
}

function extractBinaryLaneErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") return optionalString(payload);
  const record = optionalRecord(payload);
  if (!record) return undefined;

  const detail = optionalString(record.detail);
  if (detail) return detail;
  const title = optionalString(record.title);
  if (title) return title;

  const errors = optionalRecord(record.errors);
  if (!errors) return undefined;
  for (const [field, value] of Object.entries(errors)) {
    const message = Array.isArray(value)
      ? value.map((item) => optionalString(item)).find(Boolean)
      : optionalString(value);
    if (message) return `${field}: ${message}`;
  }
  return undefined;
}

function requireWrappedObject(value: unknown, fieldName: string): Record<string, unknown> {
  const record = requiredRecord(value, "BinaryLane response", providerResponseError);
  return requiredRecord(record[fieldName], fieldName, providerResponseError);
}

function readOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return positiveInteger(value, fieldName, providerInputError);
}

function readOptionalPerPage(value: unknown): number | undefined {
  const perPage = optionalIntegerLike(value, "perPage", providerInputError);
  if (perPage === undefined) return undefined;
  if (perPage < 1 || perPage > 200) throw providerInputError("perPage must be between 1 and 200");
  return perPage;
}

function providerInputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function providerResponseError(message: string): ProviderRequestError {
  return new ProviderRequestError(502, message);
}
