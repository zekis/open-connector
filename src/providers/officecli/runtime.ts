import type { CredentialValidationResult, TransitFileWriter } from "../../core/types.ts";

import { optionalBoolean, optionalInteger, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed, readBoundedResponseBytes } from "../../core/request.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  providerUserAgent,
  ProviderRequestError,
  readTransitFileInput,
} from "../provider-runtime.ts";

type OfficeCliActionHandler = (input: Record<string, unknown>, context: OfficeCliActionContext) => Promise<unknown>;
type OfficeCliRequestPhase = "validate" | "execute";

interface OfficeCliJsonRequestOptions {
  context: OfficeCliActionContext;
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  phase?: OfficeCliRequestPhase;
}

interface OfficeCliDownloadResponse {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}

export interface OfficeCliActionContext {
  apiKey: string;
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  transitFiles?: TransitFileWriter;
}

const requestTimeoutMs = 180_000;
const maxJsonResponseBytes = 20 * 1024 * 1024;

export const officeCliActionHandlers: Record<string, OfficeCliActionHandler> = {
  async list_documents(input, context) {
    const prefix = optionalString(input.prefix);
    const endpoint = prefix ? `/v1/documents?prefix=${encodeURIComponent(prefix)}` : "/v1/documents";
    return requestOfficeCliJson(endpoint, { context });
  },
  async upload_document(input, context) {
    const document = readDocumentPath(input.document);
    const file = await readTransitFileInput(input.file, context);
    return uploadOfficeCliDocument(document, file.file, context);
  },
  async download_document(input, context) {
    const document = readDocumentPath(input.document);
    const transitFiles = requireTransitFiles(context, "download_document");
    const response = await downloadOfficeCliDocument(document, context, transitFiles.maxBytes);
    const upload = await transitFiles.create(
      new File([Uint8Array.from(response.bytes)], response.name, { type: response.mimeType }),
    );
    return {
      file: {
        fileId: upload.fileId,
        downloadUrl: upload.downloadUrl,
        sizeBytes: upload.sizeBytes,
        name: upload.name,
        mimeType: upload.mimeType,
      },
    };
  },
  async delete_document(input, context) {
    const document = readDocumentPath(input.document);
    return requestOfficeCliJson(documentEndpoint(document), { context, method: "DELETE" });
  },
  create_document(input, context) {
    return runOfficeCliCommand(
      {
        command: "create",
        document: readDocumentPath(input.document),
        force: optionalBoolean(input.force),
      },
      context,
    );
  },
  get_document_element(input, context) {
    return runOfficeCliCommand(
      {
        command: "get",
        document: readDocumentPath(input.document),
        path: optionalString(input.path),
        depth: optionalInteger(input.depth),
      },
      context,
    );
  },
  query_document(input, context) {
    return runOfficeCliCommand(
      {
        command: "query",
        document: readDocumentPath(input.document),
        selector: requiredInputString(input.selector, "selector"),
        find: optionalString(input.find),
      },
      context,
    );
  },
  view_document(input, context) {
    return runOfficeCliCommand(
      {
        command: "view",
        document: readDocumentPath(input.document),
        mode: requiredInputString(input.mode, "mode"),
      },
      context,
    );
  },
  edit_document(input, context) {
    if (!Array.isArray(input.commands) || input.commands.length === 0) {
      throw new ProviderRequestError(400, "commands must be a non-empty array");
    }
    return runOfficeCliCommand(
      {
        command: "batch",
        document: readDocumentPath(input.document),
        commands: input.commands,
        stopOnError: optionalBoolean(input.stopOnError),
        bestEffort: optionalBoolean(input.bestEffort),
      },
      context,
    );
  },
  validate_document(input, context) {
    return runOfficeCliCommand({ command: "validate", document: readDocumentPath(input.document) }, context);
  },
  dump_document(input, context) {
    return runOfficeCliCommand(
      {
        command: "dump",
        document: readDocumentPath(input.document),
        path: optionalString(input.path),
      },
      context,
    );
  },
  merge_template(input, context) {
    if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
      throw new ProviderRequestError(400, "data must be an object");
    }
    return runOfficeCliCommand(
      {
        command: "merge",
        template: readDocumentPath(input.template),
        outputDocument: readDocumentPath(input.outputDocument),
        data: input.data,
        force: optionalBoolean(input.force),
      },
      context,
    );
  },
  get_schema_help(input, context) {
    return runOfficeCliCommand(
      {
        command: "help",
        format: requiredInputString(input.format, "format"),
        element: optionalString(input.element),
      },
      context,
    );
  },
};

export function createOfficeCliContext(
  values: Record<string, string>,
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  transitFiles?: TransitFileWriter,
): OfficeCliActionContext {
  const normalizedApiKey = requiredString(apiKey, "apiKey", credentialError);
  return {
    apiKey: normalizedApiKey,
    baseUrl: normalizeOfficeCliBaseUrl(values.baseUrl),
    fetcher,
    signal,
    transitFiles,
  };
}

export async function validateOfficeCliCredential(
  values: Record<string, string>,
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const context = createOfficeCliContext(values, apiKey, fetcher, signal);
  const response = await requestOfficeCliJson("/v1/info", { context, phase: "validate" });
  const host = new URL(context.baseUrl).host;
  const version = readNestedString(response, "officecliVersion");
  return {
    profile: {
      accountId: `officecli:${host}`,
      displayName: version ? `OfficeCLI ${version} · ${host}` : `OfficeCLI · ${host}`,
    },
    grantedScopes: [],
    metadata: { baseUrl: context.baseUrl, officecliVersion: version },
  };
}

/** Normalize and validate the URL of a self-hosted OfficeCLI API. */
export function normalizeOfficeCliBaseUrl(
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
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

async function runOfficeCliCommand(
  command: Record<string, unknown>,
  context: OfficeCliActionContext,
): Promise<unknown> {
  return requestOfficeCliJson("/v1/commands", { context, method: "POST", body: command });
}

async function uploadOfficeCliDocument(
  document: string,
  file: File,
  context: OfficeCliActionContext,
): Promise<unknown> {
  const timeout = createProviderTimeout(context.signal, requestTimeoutMs);
  try {
    const response = await context.fetcher(`${context.baseUrl}${documentEndpoint(document)}`, {
      method: "PUT",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${context.apiKey}`,
        "content-type": file.type || "application/octet-stream",
        "user-agent": providerUserAgent,
      },
      body: file,
      signal: timeout.signal,
    });
    return await readOfficeCliJsonResponse(response, "execute");
  } catch (error) {
    throw mapOfficeCliError(error, timeout, "OfficeCLI document upload");
  } finally {
    timeout.cleanup();
  }
}

async function downloadOfficeCliDocument(
  document: string,
  context: OfficeCliActionContext,
  maxBytes: number,
): Promise<OfficeCliDownloadResponse> {
  const timeout = createProviderTimeout(context.signal, requestTimeoutMs);
  try {
    const response = await context.fetcher(`${context.baseUrl}${documentEndpoint(document)}`, {
      headers: {
        accept: "application/octet-stream",
        authorization: `Bearer ${context.apiKey}`,
        "user-agent": providerUserAgent,
      },
      signal: timeout.signal,
    });
    if (!response.ok) {
      await throwOfficeCliResponseError(response, "execute");
    }
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes,
      fieldName: document,
      createError: (message) => new ProviderRequestError(413, message),
    });
    return {
      bytes,
      mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || documentMimeType(document),
      name: document.split("/").at(-1) ?? "document",
    };
  } catch (error) {
    throw mapOfficeCliError(error, timeout, "OfficeCLI document download");
  } finally {
    timeout.cleanup();
  }
}

async function requestOfficeCliJson(endpoint: string, options: OfficeCliJsonRequestOptions): Promise<unknown> {
  const timeout = createProviderTimeout(options.context.signal, requestTimeoutMs);
  const phase = options.phase ?? "execute";
  try {
    const response = await options.context.fetcher(`${options.context.baseUrl}${endpoint}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.context.apiKey}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        "user-agent": providerUserAgent,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: timeout.signal,
    });
    return await readOfficeCliJsonResponse(response, phase);
  } catch (error) {
    throw mapOfficeCliError(error, timeout, "OfficeCLI API request");
  } finally {
    timeout.cleanup();
  }
}

async function readOfficeCliJsonResponse(response: Response, phase: OfficeCliRequestPhase): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxJsonResponseBytes,
    fieldName: "OfficeCLI API response",
    createError: (message) => new ProviderRequestError(413, message),
  });
  const text = new TextDecoder().decode(bytes);
  let payload: unknown = null;
  if (text.trim() !== "") {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderRequestError(502, "OfficeCLI API returned invalid JSON");
    }
  }
  if (!response.ok) {
    const status = phase === "validate" && [401, 403].includes(response.status) ? 400 : response.status;
    throw new ProviderRequestError(
      status,
      readOfficeCliErrorMessage(payload) ?? `OfficeCLI API returned HTTP ${response.status}`,
    );
  }
  return payload;
}

async function throwOfficeCliResponseError(response: Response, phase: OfficeCliRequestPhase): Promise<never> {
  const payload = await readOfficeCliJsonResponse(response, phase);
  throw new ProviderRequestError(response.status, readOfficeCliErrorMessage(payload) ?? "OfficeCLI API request failed");
}

function mapOfficeCliError(
  error: unknown,
  timeout: ReturnType<typeof createProviderTimeout>,
  label: string,
): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  if (timeout.didTimeout() || isAbortLikeError(error)) return new ProviderRequestError(504, `${label} timed out`);
  return new ProviderRequestError(
    502,
    error instanceof Error ? `${label} failed: ${boundedMessage(error.message)}` : `${label} failed`,
  );
}

function readDocumentPath(value: unknown): string {
  return requiredInputString(value, "document");
}

function requiredInputString(value: unknown, fieldName: string): string {
  return requiredString(value, fieldName, (message) => new ProviderRequestError(400, message));
}

function documentEndpoint(document: string): string {
  return `/v1/documents/${document
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function requireTransitFiles(context: OfficeCliActionContext, actionName: string): TransitFileWriter {
  if (!context.transitFiles) {
    throw new ProviderRequestError(500, `${actionName} requires transit file storage`);
  }
  return context.transitFiles;
}

function documentMimeType(document: string): string {
  if (document.toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (document.toLowerCase().endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (document.toLowerCase().endsWith(".pptx")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return "application/octet-stream";
}

function readOfficeCliErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string") return boundedMessage(error);
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return boundedMessage(message);
  }
  return typeof record.message === "string" ? boundedMessage(record.message) : undefined;
}

function readNestedString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function boundedMessage(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 1_999)}…`;
}

function credentialError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}
