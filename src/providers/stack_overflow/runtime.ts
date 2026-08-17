import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderFetch, ProviderRuntimeHandler } from "../provider-runtime.ts";

import {
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
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

export const stackOverflowApiBaseUrl = "https://api.stackoverflowteams.com/2.3";

const requestTimeoutMs = 30_000;
const defaultFilter = "withbody";

type StackOverflowRequestPhase = "validate" | "execute";

export interface StackOverflowRuntimeContext {
  personalAccessToken: string;
  team: string;
  fetcher: ProviderFetch;
  signal?: AbortSignal;
}

interface StackOverflowRequestInput extends StackOverflowRuntimeContext {
  path: string;
  phase: StackOverflowRequestPhase;
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
  form?: Record<string, string | number | boolean | undefined>;
}

export const stackOverflowActionHandlers: Record<string, ProviderRuntimeHandler<StackOverflowRuntimeContext>> = {
  async get_current_user(_input, context) {
    return { user: await getCurrentUser(context, "execute") };
  },

  async search_questions(input, context) {
    const payload = await stackOverflowRequestJson({
      ...context,
      path: "/search/advanced",
      phase: "execute",
      query: {
        q: requiredInputString(input.q, "q"),
        title: optionalString(input.title),
        body: optionalString(input.body),
        tagged: joinTags(input.tagged),
        nottagged: joinTags(input.notTagged),
        accepted: optionalBoolean(input.accepted),
        answers: optionalInteger(input.answers),
        closed: optionalBoolean(input.closed),
        views: optionalInteger(input.views),
        user: optionalInteger(input.userId),
        sort: optionalString(input.sort) ?? "relevance",
        ...commonCollectionQuery(input),
      },
    });
    return collectionResult(payload, "questions", optionalInteger(input.page) ?? 1);
  },

  async list_questions(input, context) {
    const payload = await stackOverflowRequestJson({
      ...context,
      path: "/questions",
      phase: "execute",
      query: {
        tagged: joinTags(input.tagged),
        sort: optionalString(input.sort) ?? "activity",
        ...commonCollectionQuery(input),
      },
    });
    return collectionResult(payload, "questions", optionalInteger(input.page) ?? 1);
  },

  async get_questions(input, context) {
    const ids = requiredPositiveIntegerArray(input.questionIds, "questionIds");
    const payload = await stackOverflowRequestJson({
      ...context,
      path: `/questions/${ids.join(";")}`,
      phase: "execute",
      query: { filter: optionalString(input.filter) ?? defaultFilter },
    });
    return collectionResult(payload, "questions", 1);
  },

  async list_question_answers(input, context) {
    const ids = requiredPositiveIntegerArray(input.questionIds, "questionIds");
    const payload = await stackOverflowRequestJson({
      ...context,
      path: `/questions/${ids.join(";")}/answers`,
      phase: "execute",
      query: {
        sort: optionalString(input.sort) ?? "votes",
        ...commonCollectionQuery(input),
      },
    });
    return collectionResult(payload, "answers", optionalInteger(input.page) ?? 1);
  },

  async list_tags(input, context) {
    const payload = await stackOverflowRequestJson({
      ...context,
      path: "/tags",
      phase: "execute",
      query: {
        inname: optionalString(input.inName),
        sort: optionalString(input.sort) ?? "popular",
        order: optionalString(input.order) ?? "desc",
        page: optionalInteger(input.page),
        pagesize: optionalInteger(input.pageSize),
      },
    });
    return collectionResult(payload, "tags", optionalInteger(input.page) ?? 1);
  },

  async create_question(input, context) {
    const payload = await stackOverflowRequestJson({
      ...context,
      path: "/questions/add",
      method: "POST",
      phase: "execute",
      query: { filter: defaultFilter },
      form: {
        title: requiredInputString(input.title, "title"),
        body: requiredInputString(input.body, "body"),
        tags: requiredTags(input.tags).join(";"),
      },
    });
    return { question: singleResult(payload, "question") };
  },

  async create_answer(input, context) {
    const questionId = positiveInteger(input.questionId, "questionId", providerInputError);
    const payload = await stackOverflowRequestJson({
      ...context,
      path: `/questions/${questionId}/answers/add`,
      method: "POST",
      phase: "execute",
      query: { filter: defaultFilter },
      form: { body: requiredInputString(input.body, "body") },
    });
    return { answer: singleResult(payload, "answer") };
  },

  async add_comment(input, context) {
    const postId = positiveInteger(input.postId, "postId", providerInputError);
    const payload = await stackOverflowRequestJson({
      ...context,
      path: `/posts/${postId}/comments/add`,
      method: "POST",
      phase: "execute",
      query: { filter: defaultFilter },
      form: { body: requiredInputString(input.body, "body") },
    });
    return { comment: singleResult(payload, "comment") };
  },
};

export async function validateStackOverflowCredential(
  personalAccessToken: string,
  team: string,
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const user = await getCurrentUser({ personalAccessToken, team, fetcher, signal }, "validate");
  const userId = positiveInteger(user.user_id, "user.user_id", providerResponseError);
  const displayName = requiredString(user.display_name, "user.display_name", providerResponseError);
  return {
    profile: {
      accountId: `stack-overflow:${team.toLowerCase()}:${userId}`,
      displayName: `${displayName} · ${team}`,
    },
    grantedScopes: [],
    metadata: { team, userId },
  };
}

async function getCurrentUser(
  context: StackOverflowRuntimeContext,
  phase: StackOverflowRequestPhase,
): Promise<Record<string, unknown>> {
  const payload = await stackOverflowRequestJson({ ...context, path: "/me", phase });
  return singleResult(payload, "user");
}

async function stackOverflowRequestJson(input: StackOverflowRequestInput): Promise<Record<string, unknown>> {
  const url = stackOverflowUrl(input.path, input.team, input.query);
  const timeout = createProviderTimeout(input.signal, requestTimeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": providerUserAgent,
      "x-api-access-token": input.personalAccessToken,
    };
    let body: string | undefined;
    if (input.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = formBody(input.form).toString();
    }
    const response = await input.fetcher(url, {
      method: input.method ?? "GET",
      headers,
      body,
      signal: timeout.signal,
    });
    const payload = await readProviderJsonBody(response, {
      emptyBody: {},
      invalidJsonMessage: "Stack Overflow Internal returned invalid JSON",
    });
    const record = requiredRecord(payload, "Stack Overflow Internal response", providerResponseError);
    if (!response.ok || optionalInteger(record.error_id) !== undefined) {
      throw stackOverflowResponseError(response.status, record, input.phase);
    }
    return record;
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (timeout.didTimeout()) {
      throw new ProviderRequestError(504, "Stack Overflow Internal request timed out", error);
    }
    if (isAbortSignalError(input.signal, error)) {
      throw new ProviderRequestError(499, "Stack Overflow Internal request was cancelled", error);
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error
        ? `Stack Overflow Internal request failed: ${error.message}`
        : "Stack Overflow Internal request failed",
      error,
    );
  } finally {
    timeout.cleanup();
  }
}

function stackOverflowUrl(
  path: string,
  team: string,
  query: Record<string, string | number | boolean | undefined> = {},
): URL {
  const url = new URL(`${stackOverflowApiBaseUrl}/${path.replace(/^\/+/, "")}`);
  url.searchParams.set("team", team);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

function commonCollectionQuery(input: Record<string, unknown>): Record<string, string | number | boolean | undefined> {
  return {
    fromdate: optionalInteger(input.fromDate),
    todate: optionalInteger(input.toDate),
    order: optionalString(input.order) ?? "desc",
    page: optionalInteger(input.page),
    pagesize: optionalInteger(input.pageSize),
    filter: optionalString(input.filter) ?? defaultFilter,
  };
}

function formBody(values: Record<string, string | number | boolean | undefined>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) form.set(key, String(value));
  }
  return form;
}

function collectionResult(
  payload: Record<string, unknown>,
  fieldName: string,
  requestedPage: number,
): Record<string, unknown> {
  if (!Array.isArray(payload.items)) {
    throw providerResponseError("Stack Overflow Internal response is missing its items array.");
  }
  const items = payload.items.map((item) => requiredRecord(item, `${fieldName} item`, providerResponseError));
  const hasMore = optionalBoolean(payload.has_more) ?? false;
  return {
    [fieldName]: items,
    hasMore,
    nextPage: hasMore ? requestedPage + 1 : null,
    quotaRemaining: optionalInteger(payload.quota_remaining) ?? null,
    quotaMax: optionalInteger(payload.quota_max) ?? null,
    backoffSeconds: optionalInteger(payload.backoff) ?? null,
  };
}

function singleResult(payload: Record<string, unknown>, fieldName: string): Record<string, unknown> {
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw providerResponseError(`Stack Overflow Internal response is missing its ${fieldName}.`);
  }
  return requiredRecord(payload.items[0], fieldName, providerResponseError);
}

function requiredPositiveIntegerArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw providerInputError(`${fieldName} must contain between 1 and 100 IDs.`);
  }
  return value.map((item, index) => positiveInteger(item, `${fieldName}[${index}]`, providerInputError));
}

function requiredTags(value: unknown): string[] {
  const values = optionalStringArray(value)
    ?.map((item) => item.trim())
    .filter(Boolean);
  if (!values || values.length === 0 || values.length > 5) {
    throw providerInputError("tags must contain between 1 and 5 tag names.");
  }
  return values;
}

function joinTags(value: unknown): string | undefined {
  const values = optionalStringArray(value)
    ?.map((item) => item.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values.join(";") : undefined;
}

function requiredInputString(value: unknown, fieldName: string): string {
  return requiredString(value, fieldName, providerInputError);
}

function stackOverflowResponseError(
  status: number,
  payload: Record<string, unknown>,
  phase: StackOverflowRequestPhase,
): ProviderRequestError {
  const errorName = optionalString(payload.error_name);
  const errorMessage = optionalString(payload.error_message);
  const message = errorMessage ?? errorName ?? `Stack Overflow Internal request failed with status ${status}`;
  const responseStatus = phase === "validate" ? 400 : normalizeErrorStatus(status, errorName);
  return new ProviderRequestError(responseStatus, message, jsonObject(payload));
}

function normalizeErrorStatus(status: number, errorName: string | undefined): number {
  if (errorName === "access_token_required" || errorName === "invalid_access_token") return 401;
  if (errorName === "access_denied") return 403;
  if (errorName === "throttle_violation") return 429;
  return status || 502;
}

function providerInputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function providerResponseError(message: string): ProviderRequestError {
  return new ProviderRequestError(502, message);
}
