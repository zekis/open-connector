import type { CredentialValidationResult, TransitFileWriter } from "../../core/types.ts";
import type { ProviderRuntimeHandler } from "../provider-runtime.ts";

import { Buffer } from "node:buffer";
import {
  optionalBoolean,
  optionalInteger,
  optionalRawString,
  optionalRecord,
  optionalString,
  requiredString,
} from "../../core/cast.ts";
import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed, readBoundedResponseBytes } from "../../core/request.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  ProviderRequestError,
  providerUserAgent,
  readProviderJsonBody,
  readProviderTextBody,
} from "../provider-runtime.ts";

const defaultRequestTimeoutMs = 20_000;
const maximumSearchResponseBytes = 4 * 1024 * 1024;
const maximumErrorResponseBytes = 64 * 1024;
const windowsFileTimeUnixEpoch = 116_444_736_000_000_000n;
const windowsFileTimeTicksPerMillisecond = 10_000n;

type EverythingActionHandler = ProviderRuntimeHandler<EverythingActionContext>;
type EverythingRequestPhase = "validate" | "execute";

export interface EverythingActionContext {
  baseUrl: string;
  username?: string;
  password?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  transitFiles?: TransitFileWriter;
}

interface EverythingSearchRequest {
  query: string;
  offset: number;
  count: number;
  sort: "name" | "path" | "date_modified" | "size";
  direction: "ascending" | "descending";
  matchCase: boolean;
  wholeWord: boolean;
  matchPath: boolean;
  regex: boolean;
  matchDiacritics: boolean;
}

interface EverythingSearchResult {
  type: "file" | "folder";
  name: string;
  path: string;
  fullPath: string;
  sizeBytes: number | null;
  dateModified: string | null;
}

export const everythingActionHandlers: Record<string, EverythingActionHandler> = {
  async search_files(input, context) {
    return await searchEverything(readSearchRequest(input), context, "execute");
  },
  async download_file(input, context) {
    return await downloadEverythingFile(requiredString(input.path, "path", inputError), context);
  },
};

export function createEverythingContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  transitFiles?: TransitFileWriter,
): EverythingActionContext {
  const username = optionalString(values.username);
  const password = optionalRawString(values.password);
  if (Boolean(username) !== Boolean(password)) {
    throw inputError("username and password must either both be set or both be blank");
  }
  return {
    baseUrl: normalizeEverythingBaseUrl(values.baseUrl),
    username,
    password: password || undefined,
    fetcher,
    signal,
    transitFiles,
  };
}

export async function validateEverythingCredential(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createEverythingContext(values, fetcher, signal);
  await searchEverything(
    {
      query: "*",
      offset: 0,
      count: 1,
      sort: "name",
      direction: "ascending",
      matchCase: false,
      wholeWord: false,
      matchPath: false,
      regex: false,
      matchDiacritics: false,
    },
    context,
    "validate",
  );
  const host = new URL(context.baseUrl).host;
  return {
    profile: {
      accountId: `everything:${host}`,
      displayName: context.username ? `${context.username} on ${host}` : `Everything on ${host}`,
    },
    grantedScopes: [],
    metadata: { baseUrl: context.baseUrl },
  };
}

/** Normalize and guard the configured Everything HTTP Server origin. */
export function normalizeEverythingBaseUrl(
  value: unknown,
  allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed(),
): string {
  const url = assertPublicHttpUrl(requiredString(value, "baseUrl", inputError), {
    fieldName: "baseUrl",
    createError: inputError,
    allowPrivateNetwork,
  });
  if (url.username || url.password) throw inputError("baseUrl must not include credentials");
  if (url.pathname !== "/") throw inputError("baseUrl must be an origin without a path");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

async function searchEverything(
  request: EverythingSearchRequest,
  context: EverythingActionContext,
  phase: EverythingRequestPhase,
): Promise<{ totalResults: number; offset: number; returnedResults: number; results: EverythingSearchResult[] }> {
  const url = new URL(context.baseUrl);
  url.searchParams.set("search", request.query);
  url.searchParams.set("offset", String(request.offset));
  url.searchParams.set("count", String(request.count));
  url.searchParams.set("json", "1");
  url.searchParams.set("case", flag(request.matchCase));
  url.searchParams.set("wholeword", flag(request.wholeWord));
  url.searchParams.set("path", flag(request.matchPath));
  url.searchParams.set("regex", flag(request.regex));
  url.searchParams.set("diacritics", flag(request.matchDiacritics));
  url.searchParams.set("path_column", "1");
  url.searchParams.set("size_column", "1");
  url.searchParams.set("date_modified_column", "1");
  url.searchParams.set("sort", request.sort);
  url.searchParams.set("ascending", flag(request.direction === "ascending"));

  const response = await requestEverything(url, context, phase, "application/json");
  const payload = await readProviderJsonBody(response, {
    emptyBody: null,
    invalidJsonMessage: "Everything HTTP Server returned HTML or invalid JSON. Ensure JSON search is supported.",
    maxBytes: maximumSearchResponseBytes,
  });
  const record = optionalRecord(payload);
  if (!record || !Array.isArray(record.results)) {
    throw new ProviderRequestError(502, "Everything HTTP Server returned an invalid search response");
  }
  const totalResults = readNonNegativeInteger(record.totalResults, "totalResults");
  const results = record.results.map((item, index) => normalizeSearchResult(item, index));
  return { totalResults, offset: request.offset, returnedResults: results.length, results };
}

async function downloadEverythingFile(
  path: string,
  context: EverythingActionContext,
): Promise<{
  sourcePath: string;
  file: { fileId: string; downloadUrl: string; sizeBytes: number; name: string; mimeType: string };
}> {
  if (!context.transitFiles) throw new ProviderRequestError(400, "Transit file storage is not enabled.");
  const name = windowsFileName(path);
  if (!name) throw inputError("path must identify a file");
  const response = await requestEverything(everythingFileUrl(context.baseUrl, path), context, "execute", "*/*");
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: context.transitFiles.maxBytes,
    fieldName: name,
    createError: (message) => new ProviderRequestError(413, message),
  });
  const file = await context.transitFiles.create(new File([Uint8Array.from(bytes)], name, { type: mimeType }));
  return { sourcePath: path, file };
}

async function requestEverything(
  url: URL,
  context: EverythingActionContext,
  phase: EverythingRequestPhase,
  accept: string,
): Promise<Response> {
  const timeout = createProviderTimeout(context.signal, defaultRequestTimeoutMs);
  try {
    const headers: Record<string, string> = { accept, "user-agent": providerUserAgent };
    if (context.username && context.password) {
      headers.authorization = `Basic ${Buffer.from(`${context.username}:${context.password}`).toString("base64")}`;
    }
    const response = await context.fetcher(url, { method: "GET", headers, signal: timeout.signal });
    if (!response.ok) {
      const message = await readProviderTextBody(
        response,
        "Everything error response",
        maximumErrorResponseBytes,
      ).catch(() => "");
      const status =
        phase === "validate" && (response.status === 401 || response.status === 403) ? 400 : response.status;
      throw new ProviderRequestError(
        status,
        response.status === 401
          ? "Everything HTTP Server rejected the username or password"
          : message.trim() || `Everything HTTP Server request failed with HTTP ${response.status}`,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(504, "Everything HTTP Server request timed out");
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error
        ? `Everything HTTP Server request failed: ${error.message}`
        : "Everything HTTP Server request failed",
    );
  } finally {
    timeout.cleanup();
  }
}

function readSearchRequest(input: Record<string, unknown>): EverythingSearchRequest {
  const count = optionalInteger(input.count) ?? 50;
  const offset = optionalInteger(input.offset) ?? 0;
  if (count < 1 || count > 200) throw inputError("count must be between 1 and 200");
  if (offset < 0) throw inputError("offset must be a non-negative integer");
  const sort = optionalString(input.sort) ?? "name";
  if (sort !== "name" && sort !== "path" && sort !== "date_modified" && sort !== "size") {
    throw inputError("sort must be name, path, date_modified, or size");
  }
  const direction = optionalString(input.direction) ?? "ascending";
  if (direction !== "ascending" && direction !== "descending") {
    throw inputError("direction must be ascending or descending");
  }
  return {
    query: requiredString(input.query, "query", inputError),
    offset,
    count,
    sort,
    direction,
    matchCase: optionalBoolean(input.matchCase) ?? false,
    wholeWord: optionalBoolean(input.wholeWord) ?? false,
    matchPath: optionalBoolean(input.matchPath) ?? false,
    regex: optionalBoolean(input.regex) ?? false,
    matchDiacritics: optionalBoolean(input.matchDiacritics) ?? false,
  };
}

function normalizeSearchResult(value: unknown, index: number): EverythingSearchResult {
  const item = optionalRecord(value);
  if (!item) throw new ProviderRequestError(502, `Everything search result ${index + 1} is invalid`);
  const type = optionalString(item.type);
  if (type !== "file" && type !== "folder") {
    throw new ProviderRequestError(502, `Everything search result ${index + 1} has an invalid type`);
  }
  const name = requiredString(item.name, `results[${index}].name`, upstreamError);
  const path = optionalRawString(item.path);
  if (path === undefined) throw new ProviderRequestError(502, `Everything search result ${index + 1} has no path`);
  return {
    type,
    name,
    path,
    fullPath: joinWindowsPath(path, name),
    sizeBytes: readNullableSafeInteger(item.size),
    dateModified: windowsFileTimeToIso(item.date_modified),
  };
}

/** Build the official Everything file URL from a complete Windows path. */
export function everythingFileUrl(baseUrl: string, path: string): URL {
  const normalizedPath = path.startsWith("\\\\")
    ? `${path.slice(0, 2)}${path.slice(2).replaceAll("\\", "/")}`
    : path.replaceAll("\\", "/");
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  return new URL(`/${encodedPath}`, `${baseUrl}/`);
}

function windowsFileTimeToIso(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  try {
    const milliseconds = (BigInt(value) - windowsFileTimeUnixEpoch) / windowsFileTimeTicksPerMillisecond;
    const number = Number(milliseconds);
    if (!Number.isSafeInteger(number)) return null;
    return new Date(number).toISOString();
  } catch {
    return null;
  }
}

function readNullableSafeInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProviderRequestError(502, `Everything response field ${fieldName} is invalid`);
  }
  return parsed;
}

function joinWindowsPath(path: string, name: string): string {
  return !path || /[\\/]$/u.test(path) ? `${path}${name}` : `${path}\\${name}`;
}

function windowsFileName(path: string): string | undefined {
  return path.split(/[\\/]/u).filter(Boolean).at(-1);
}

function flag(value: boolean): string {
  return value ? "1" : "0";
}

function inputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function upstreamError(message: string): ProviderRequestError {
  return new ProviderRequestError(502, message);
}
