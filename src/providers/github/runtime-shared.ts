import { compactObject, optionalInteger, optionalString, optionalRawString } from "../../core/cast.ts";
import { ProviderRequestError } from "../provider-runtime.ts";

export { compactObject };

export const githubApiBaseUrl = "https://api.github.com";
export const githubApiVersion = "2022-11-28";
export const githubDefaultAcceptHeader = "application/vnd.github+json";
export const githubUserAgent = "oomol-connect";

export type GitHubActionContext = {
  accessToken: string;
  fetcher: typeof fetch;
};

export type GitHubActionHandler = (input: Record<string, unknown>, context: GitHubActionContext) => Promise<unknown>;

interface GitHubJsonRequest {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  accessToken: string;
  fetcher: typeof fetch;
}

interface GitHubNoContentRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  accessToken: string;
  fetcher: typeof fetch;
}

export async function githubRequestJson<T>(input: GitHubJsonRequest): Promise<T> {
  const url = buildGitHubUrl(input.path, input.query);
  const response = await input.fetcher(url, {
    method: input.method ?? "GET",
    headers: githubHeaders(input.accessToken, input.body !== undefined),
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const payload = (await readJsonResponse(response)) as T;

  if (!response.ok) {
    throw normalizeGitHubError(response, payload, "github api request failed");
  }

  return payload;
}

export async function githubRequestNoContent(input: GitHubNoContentRequest): Promise<void> {
  const url = buildGitHubUrl(input.path);
  const response = await input.fetcher(url, {
    method: input.method,
    headers: githubHeaders(input.accessToken, input.body !== undefined),
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

  if (!response.ok) {
    const payload = await readJsonResponse(response);
    throw normalizeGitHubError(response, payload, "github api request failed");
  }
}

export function buildGitHubUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(`${githubApiBaseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function buildRepoContentsPath(owner: string, repo: string, path?: string): string {
  const normalizedPath = path?.replace(/^\/+/u, "").replace(/\/+$/u, "") ?? "";
  const encodedPath = normalizedPath
    ? normalizedPath
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/")
    : "";

  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${encodedPath ? `/${encodedPath}` : ""}`;
}

export function githubHeaders(accessToken: string, hasJsonBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: githubDefaultAcceptHeader,
    authorization: `Bearer ${accessToken}`,
    "x-github-api-version": githubApiVersion,
    "user-agent": githubUserAgent,
  };
  if (hasJsonBody) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

/**
 * Turn a GitHub error response into a ProviderRequestError that says what GitHub said.
 *
 * The message names GitHub's own status, its message and any field-level
 * validation errors (a 422 carries the useful part in `errors`), so a caller can
 * tell a rejected input from a GitHub outage. When GitHub sends no message at
 * all, `fallbackMessage` says what was being attempted and the request id is
 * included so the failure can be traced with GitHub.
 *
 * GitHub server errors map to 502: the gateway worked, GitHub did not.
 */
export function normalizeGitHubError(
  response: Response,
  payload: unknown,
  fallbackMessage: string,
): ProviderRequestError {
  const status = response.status;
  const requestId = response.headers.get("x-github-request-id") ?? undefined;
  const githubMessage = readGitHubErrorMessage(payload);
  const fieldErrors = readGitHubFieldErrors(payload);
  const reason = [githubMessage, fieldErrors.join("; ")].filter(Boolean).join(": ");
  const traced = status >= 500 && requestId ? ` (request id ${requestId})` : "";
  const message = reason
    ? `GitHub returned ${status}: ${reason}${traced}`
    : `${fallbackMessage}: GitHub returned ${status} with no error message${traced}`;
  const details = compactObject({
    githubStatus: status,
    githubRequestId: requestId,
    documentationUrl: readGitHubDocumentationUrl(payload),
    errors: fieldErrors.length > 0 ? fieldErrors : undefined,
  });

  if (status === 401) {
    return new ProviderRequestError(401, message, details);
  }
  if ((status === 403 && isRateLimited(response, payload)) || status === 429) {
    return new ProviderRequestError(429, message, details);
  }
  if (status === 403 || status === 404) {
    return new ProviderRequestError(status, message, details);
  }
  if (status === 400 || status === 422) {
    return new ProviderRequestError(400, message, details);
  }

  return new ProviderRequestError(502, message, details);
}

function readGitHubErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const message = (payload as Record<string, unknown>).message;
  if (typeof message !== "string" || !message.trim()) {
    return null;
  }
  // A non-JSON error page arrives here as its raw text; keep the message readable.
  const trimmed = message.trim();
  return trimmed.length > maxGitHubErrorMessageLength ? `${trimmed.slice(0, maxGitHubErrorMessageLength)}...` : trimmed;
}

const maxGitHubErrorMessageLength = 500;

/** GitHub's validation errors: `{ resource, field, code, message? }` entries, or plain strings. */
function readGitHubFieldErrors(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const errors = (payload as Record<string, unknown>).errors;
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors
    .map((entry): string => {
      if (typeof entry === "string") {
        return entry;
      }
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const record = entry as Record<string, unknown>;
      const message = optionalString(record.message);
      if (message) {
        return message;
      }
      const target = [optionalString(record.resource), optionalString(record.field)].filter(Boolean).join(".");
      return [target, optionalString(record.code)].filter(Boolean).join(" ");
    })
    .filter(Boolean);
}

function readGitHubDocumentationUrl(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  return optionalString((payload as Record<string, unknown>).documentation_url);
}

function isRateLimited(response: Response, payload: unknown): boolean {
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    return true;
  }

  const message = readGitHubErrorMessage(payload)?.toLowerCase() ?? "";
  return message.includes("rate limit");
}

export function decodeGitHubContent(contentBase64: string, encoding?: string): string | null {
  if (!contentBase64) {
    return "";
  }
  if (encoding && encoding !== "base64") {
    return null;
  }

  try {
    const bytes = Buffer.from(contentBase64, "base64");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function resolveGitHubWriteContent(input: Record<string, unknown>): string {
  const contentBase64 = optionalRawString(input.contentBase64);
  if (contentBase64) {
    return contentBase64.replace(/[\r\n]/g, "");
  }

  return Buffer.from(String(input.content ?? ""), "utf8").toString("base64");
}

export function mapReviewComment(comment: unknown): Record<string, unknown> {
  if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
    return {};
  }

  const value = comment as Record<string, unknown>;
  return compactObject({
    path: String(value.path ?? ""),
    body: String(value.body ?? ""),
    line: optionalInteger(value.line),
    side: optionalString(value.side),
    start_line: optionalInteger(value.startLine),
    start_side: optionalString(value.startSide),
  });
}

export function normalizeRequestedReviewersResponse(payload: Record<string, unknown>): {
  pull_request: Record<string, unknown>;
  requested_reviewers: Record<string, unknown>[];
  requested_teams: Record<string, unknown>[];
} {
  return {
    pull_request: payload,
    requested_reviewers: Array.isArray(payload.requested_reviewers)
      ? (payload.requested_reviewers as Record<string, unknown>[])
      : [],
    requested_teams: Array.isArray(payload.requested_teams)
      ? (payload.requested_teams as Record<string, unknown>[])
      : [],
  };
}

export function buildIssueAndPullRequestSearchQuery(input: Record<string, unknown>): string {
  const explicitQuery = optionalString(input.query) || optionalString(input.q);
  const qualifiers: string[] = [];

  const owner = optionalString(input.owner);
  const repo = optionalString(input.repo);
  if (owner && repo) {
    qualifiers.push(`repo:${owner}/${repo}`);
  } else if (repo?.includes("/")) {
    qualifiers.push(`repo:${repo}`);
  } else if (owner) {
    qualifiers.push(`user:${owner}`);
  }

  const state = optionalString(input.state);
  if (state && state !== "all") {
    qualifiers.push(`state:${state}`);
  }
  if (input.type === "issue") {
    qualifiers.push("is:issue");
  } else if (input.type === "pr") {
    qualifiers.push("is:pr");
  }

  const label = optionalString(input.label);
  if (label) {
    qualifiers.push(`label:${quoteSearchValue(label)}`);
  }

  for (const [key, qualifier] of [
    ["author", "author"],
    ["assignee", "assignee"],
    ["mentions", "mentions"],
    ["language", "language"],
    ["baseBranch", "base"],
    ["headBranch", "head"],
  ] as const) {
    const value = optionalString(input[key]);
    if (value) {
      qualifiers.push(`${qualifier}:${quoteSearchValue(value)}`);
    }
  }

  if (typeof input.isMerged === "boolean") {
    qualifiers.push(input.isMerged ? "is:merged" : "is:unmerged");
  }

  return [...(explicitQuery ? [explicitQuery] : []), ...qualifiers].join(" ").trim();
}

function quoteSearchValue(value: string): string {
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}
