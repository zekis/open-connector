import type { CredentialValidationResult } from "../../core/types.ts";

import {
  optionalBoolean,
  optionalInteger,
  optionalRawString,
  optionalRecord,
  optionalString,
  requiredRawString,
  requiredString,
} from "../../core/cast.ts";
import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed, readBoundedResponseBytes } from "../../core/request.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  providerUserAgent,
  ProviderRequestError,
} from "../provider-runtime.ts";

type ObsidianRequestPhase = "validate" | "execute";
type ObsidianHttpMethod = "GET" | "POST";
type ObsidianActionHandler = (input: Record<string, unknown>, context: ObsidianActionContext) => Promise<unknown>;

interface ObsidianCliRequest {
  params?: Record<string, string>;
  flags?: string[];
}

interface ObsidianCliRequestBody extends ObsidianCliRequest {
  vault?: string;
}

interface ObsidianCliResult {
  stdout: string;
  duration: number;
}

export interface ObsidianActionContext {
  apiKey: string;
  apiBaseUrl: string;
  vault?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export interface ObsidianFileList {
  files: string[];
  total: number;
  durationMs: number;
}

export interface ObsidianSearchResult {
  matches: string[];
  total: number;
  durationMs: number;
}

export interface ObsidianNote {
  path: string;
  content: string;
  durationMs: number;
}

export interface ObsidianMutationResult {
  path: string;
  message: string;
  durationMs: number;
}

const defaultRequestTimeoutMs = 60_000;
const maxCliContentArgumentLength = 1_500;
const maxResponseBytes = 16 * 1024 * 1024;
const maxErrorMessageCharacters = 8 * 1024;

export const obsidianActionHandlers: Record<string, ObsidianActionHandler> = {
  list_files: listObsidianFiles,
  search_notes: searchObsidianNotes,
  read_note: readObsidianNote,
  write_note: writeObsidianNote,
  append_note: appendObsidianNote,
  prepend_note: prependObsidianNote,
};

export function createObsidianContext(
  values: Record<string, string>,
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): ObsidianActionContext {
  return {
    apiKey,
    apiBaseUrl: normalizeObsidianApiBaseUrl(values.baseUrl),
    vault: optionalString(values.vault),
    fetcher,
    signal,
  };
}

export async function validateObsidianCredential(
  values: Record<string, string>,
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createObsidianContext(values, apiKey, fetcher, signal);
  const result = await requestObsidianCli("vault", "GET", { params: { info: "name" } }, context, "validate");
  const vaultName = result.stdout.trim() || context.vault || "Default vault";
  return {
    profile: {
      accountId: `${context.apiBaseUrl}#${vaultName}`,
      displayName: `Obsidian · ${vaultName}`,
    },
    grantedScopes: [],
    metadata: {
      apiBaseUrl: context.apiBaseUrl,
      vaultName,
    },
  };
}

/**
 * Validates an Obsidian plugin URL and converts an instance root into its REST
 * API base. Private and overlay-network targets require the deployment opt-in.
 */
export function normalizeObsidianApiBaseUrl(
  value: unknown,
  allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed(),
): string {
  const serverUrl = requiredString(value, "baseUrl", credentialError);
  const url = assertPublicHttpUrl(serverUrl, {
    fieldName: "baseUrl",
    createError: credentialError,
    allowPrivateNetwork,
  });
  if (url.username || url.password) throw credentialError("baseUrl must not include credentials");
  if (url.hash || url.search) throw credentialError("baseUrl must not include a query string or fragment");
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/api/v1") ? path : `${path}/api/v1`;
  return url.toString().replace(/\/$/u, "");
}

export async function listObsidianFiles(
  input: Record<string, unknown>,
  context: ObsidianActionContext,
): Promise<ObsidianFileList> {
  const params: Record<string, string> = {};
  const folder = optionalString(input.folder);
  const extension = optionalString(input.extension)?.replace(/^\./u, "");
  if (folder) params.folder = folder;
  if (extension) params.ext = extension;
  const result = await requestObsidianCli("files", "GET", { params }, context);
  const files = splitNonEmptyLines(result.stdout);
  return { files, total: files.length, durationMs: result.duration };
}

export async function searchObsidianNotes(
  input: Record<string, unknown>,
  context: ObsidianActionContext,
): Promise<ObsidianSearchResult> {
  const params: Record<string, string> = {
    query: requiredString(input.query, "query", inputError),
    format: "json",
  };
  const folder = optionalString(input.folder);
  const limit = optionalInteger(input.limit);
  if (folder) params.path = folder;
  if (limit !== undefined) params.limit = String(limit);
  const flags = optionalBoolean(input.caseSensitive) ? ["case"] : undefined;
  const result = await requestObsidianCli("search", "GET", { params, flags }, context);
  const matches = parseSearchMatches(result.stdout);
  return { matches, total: matches.length, durationMs: result.duration };
}

export async function readObsidianNote(
  input: Record<string, unknown>,
  context: ObsidianActionContext,
): Promise<ObsidianNote> {
  const path = requiredString(input.path, "path", inputError);
  const result = await requestObsidianCli("read", "GET", { params: { path } }, context);
  return { path, content: result.stdout, durationMs: result.duration };
}

export async function writeObsidianNote(
  input: Record<string, unknown>,
  context: ObsidianActionContext,
): Promise<ObsidianMutationResult> {
  const path = requiredString(input.path, "path", inputError);
  const content = requiredRawString(input.content, "content", inputError);
  return mutateObsidianNote("create", path, content, ["overwrite"], context);
}

export async function appendObsidianNote(
  input: Record<string, unknown>,
  context: ObsidianActionContext,
): Promise<ObsidianMutationResult> {
  const path = requiredString(input.path, "path", inputError);
  const content = requiredRawString(input.content, "content", inputError);
  const flags = optionalBoolean(input.inline) ? ["inline"] : undefined;
  return mutateObsidianNote("append", path, content, flags, context);
}

export async function prependObsidianNote(
  input: Record<string, unknown>,
  context: ObsidianActionContext,
): Promise<ObsidianMutationResult> {
  const path = requiredString(input.path, "path", inputError);
  const content = requiredRawString(input.content, "content", inputError);
  const flags = optionalBoolean(input.inline) ? ["inline"] : undefined;
  return mutateObsidianNote("prepend", path, content, flags, context);
}

async function mutateObsidianNote(
  command: string,
  path: string,
  content: string,
  flags: string[] | undefined,
  context: ObsidianActionContext,
): Promise<ObsidianMutationResult> {
  const chunks = splitObsidianCliContent(content);
  if (command === "prepend") chunks.reverse();

  let message = "";
  let durationMs = 0;
  for (const [index, chunk] of chunks.entries()) {
    const stepCommand = index > 0 && command === "create" ? "append" : command;
    const stepFlags = index === 0 ? flags : ["inline"];
    const result = await requestObsidianCli(
      stepCommand,
      "POST",
      { params: { path, content: chunk }, flags: stepFlags },
      context,
    );
    if (index === 0) message = result.stdout.trimEnd();
    durationMs += result.duration;
  }
  return { path, message, durationMs };
}

/**
 * Encode content using Obsidian CLI's documented newline/tab escapes and keep
 * each Windows command argument comfortably below the platform limit.
 */
function splitObsidianCliContent(content: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of content.replace(/\r\n?/gu, "\n")) {
    const encoded = character === "\n" ? "\\n" : character === "\t" ? "\\t" : character;
    if (chunk && chunk.length + encoded.length > maxCliContentArgumentLength) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += encoded;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

async function requestObsidianCli(
  command: string,
  method: ObsidianHttpMethod,
  request: ObsidianCliRequest,
  context: ObsidianActionContext,
  phase: ObsidianRequestPhase = "execute",
): Promise<ObsidianCliResult> {
  const commandPath = command.split(":").map(encodeURIComponent).join("/");
  const url = new URL(`${context.apiBaseUrl}/cli/${commandPath}`);
  let body: string | undefined;
  if (method === "GET") {
    if (context.vault) url.searchParams.set("vault", context.vault);
    for (const [key, value] of Object.entries(request.params ?? {})) url.searchParams.set(key, value);
    if (request.flags?.length) url.searchParams.set("flags", request.flags.join(","));
  } else {
    const payload: ObsidianCliRequestBody = {};
    if (context.vault) payload.vault = context.vault;
    if (request.params && Object.keys(request.params).length > 0) payload.params = request.params;
    if (request.flags?.length) payload.flags = request.flags;
    body = JSON.stringify(payload);
  }

  const timeout = createProviderTimeout(context.signal, defaultRequestTimeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${context.apiKey}`,
      "user-agent": providerUserAgent,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await context.fetcher(url, { method, headers, body, signal: timeout.signal });
    return await readObsidianCliResponse(response, phase);
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(504, "Obsidian request timed out");
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `Obsidian request failed: ${boundedMessage(error.message)}` : "Obsidian request failed",
    );
  } finally {
    timeout.cleanup();
  }
}

async function readObsidianCliResponse(response: Response, phase: ObsidianRequestPhase): Promise<ObsidianCliResult> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxResponseBytes,
    fieldName: "Obsidian response",
    createError: (message) => new ProviderRequestError(413, message),
  });
  const text = new TextDecoder().decode(bytes);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    if (!response.ok) {
      throw new ProviderRequestError(
        response.status,
        boundedMessage(text) || `Obsidian returned HTTP ${response.status}`,
      );
    }
    throw new ProviderRequestError(502, "Obsidian returned invalid JSON");
  }

  const record = optionalRecord(payload);
  if (!response.ok || record?.ok !== true) {
    const message =
      optionalString(record?.error) ??
      optionalString(record?.stderr) ??
      optionalString(record?.stdout) ??
      `Obsidian request failed with HTTP ${response.status}`;
    const status = phase === "validate" && [400, 401, 403, 422].includes(response.status) ? 400 : response.status;
    throw new ProviderRequestError(status, boundedMessage(message));
  }

  const stdout = optionalRawString(record.stdout);
  const duration = optionalInteger(record.duration);
  if (stdout === undefined || duration === undefined) {
    throw new ProviderRequestError(502, "Obsidian returned an incomplete response");
  }
  return { stdout, duration };
}

function parseSearchMatches(stdout: string): string[] {
  const text = stdout.trim();
  if (text === "" || /^No matches found\.?$/iu.test(text)) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProviderRequestError(502, "Obsidian returned invalid JSON search results");
  }
  if (!Array.isArray(payload) || payload.some((item) => typeof item !== "string")) {
    throw new ProviderRequestError(502, "Obsidian returned an unexpected search result format");
  }
  return payload;
}

function splitNonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/u).filter((line) => line.length > 0);
}

function boundedMessage(value: string): string {
  const message = value.trim();
  if (message.length <= maxErrorMessageCharacters) return message;
  return `${message.slice(0, maxErrorMessageCharacters - 1)}…`;
}

function credentialError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function inputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}
