import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
  ProxyExecutionResult,
  TransitFileWriter,
} from "../../core/types.ts";

import { base64Bytes, compactObject, optionalRecord, optionalString } from "../../core/cast.ts";
import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed, readBoundedResponseBytes } from "../../core/request.ts";
import {
  createProviderFetch,
  createProviderProxyUrl,
  defineProviderExecutors,
  normalizeProviderProxyHeaders,
  ProviderRequestError,
  providerUserAgent,
  readProviderJsonBody,
  readProviderProxyErrorMessage,
  readProviderProxyResponse,
  requireApiKeyCredential,
  toProviderProxyError,
} from "../provider-runtime.ts";

const service = "erpnext";
const proxyFetch = createProviderFetch({ allowPrivateNetwork: isPrivateNetworkAccessAllowed });
const erpnextLoggedUserMethod = "frappe.auth.get_logged_user";
const erpnextGetCountMethod = "frappe.client.get_count";
const erpnextGetValueMethod = "frappe.client.get_value";
const erpnextSetValueMethod = "frappe.client.set_value";
const erpnextAssignAddMethod = "frappe.desk.form.assign_to.add";
const erpnextAssignRemoveMethod = "frappe.desk.form.assign_to.remove";
const erpnextDownloadMethod = "frappe.handler.download_file";
const erpnextLegacyDownloadMethod = "frappe.core.doctype.file.file.download_file";
const erpnextUploadMethod = "upload_file";
const erpnextUploadMaxBytes = 25 * 1024 * 1024;

type ErpnextRequestPhase = "validate" | "execute";

interface ErpnextActionContext {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  transitFiles?: TransitFileWriter;
}

interface ErpnextRequestOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  fetcher: typeof fetch;
  phase: ErpnextRequestPhase;
  signal?: AbortSignal;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

type ErpnextActionHandler = (input: Record<string, unknown>, context: ErpnextActionContext) => Promise<unknown>;

const erpnextActionHandlers: Record<string, ErpnextActionHandler> = {
  async list_document_attachments(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildResourcePath("File"),
      method: "GET",
      phase: "execute",
      query: {
        fields: JSON.stringify(["name", "file_name", "file_url", "is_private", "file_size"]),
        filters: JSON.stringify({
          attached_to_doctype: readRequiredString(input.doctype, "doctype"),
          attached_to_name: readRequiredString(input.name, "name"),
          is_folder: 0,
        }),
        order_by: "creation asc, name asc",
        limit_start: readOptionalIntegerString(input.start) ?? "0",
        limit_page_length: readOptionalIntegerString(input.page_length) ?? "20",
      },
    });
    return { attachments: readRequiredDataArray(payload, "ERPNext attachment list response") };
  },
  async download_file(input, context) {
    if (!context.transitFiles) {
      throw new ProviderRequestError(400, "Transit file storage is not enabled.");
    }
    const fileUrl = readRequiredString(input.file_url, "file_url");
    const name = fileUrl.slice(fileUrl.lastIndexOf("/") + 1);
    if (!/^\/(?:private\/)?files\/[^/\\\p{Cc}]+$/u.test(fileUrl) || name === "." || name === "..") {
      throw new ProviderRequestError(400, "file_url must be an attachment path under /files/ or /private/files/.");
    }
    const response = await requestErpnextDownload(fileUrl, context);
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: context.transitFiles.maxBytes,
      fieldName: "ERPNext attachment",
      createError: (message) => new ProviderRequestError(413, message),
    });
    return { file: await context.transitFiles.create(new File([Uint8Array.from(bytes)], name, { type: mimeType })) };
  },
  async upload_file(input, context) {
    const fileName = readRequiredString(input.fileName, "fileName");
    if (/[/\\\p{Cc}]/u.test(fileName) || fileName === "." || fileName === "..") {
      throw new ProviderRequestError(400, "fileName must be a plain filename without path separators.");
    }
    const doctype = optionalString(input.doctype);
    const docname = optionalString(input.name);
    if ((doctype === undefined) !== (docname === undefined)) {
      throw new ProviderRequestError(400, "Provide both doctype and name to attach the file, or neither.");
    }
    if (input.isPrivate !== undefined && typeof input.isPrivate !== "boolean") {
      throw new ProviderRequestError(400, "isPrivate must be a boolean.");
    }
    const isPrivate = input.isPrivate !== false;
    const bytes = readUploadBytes(input.contentBase64);

    const form = new FormData();
    form.set("file", new Blob([bytes]), fileName);
    form.set("is_private", isPrivate ? "1" : "0");
    if (doctype && docname) {
      form.set("doctype", doctype);
      form.set("docname", docname);
    }
    const folder = optionalString(input.folder);
    if (folder) {
      form.set("folder", folder);
    }

    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextUploadMethod),
      method: "POST",
      body: form,
      phase: "execute",
    });
    const file = optionalRecord(optionalRecord(payload)?.message);
    const name = optionalString(file?.name);
    const fileUrl = optionalString(file?.file_url);
    if (!file || !name || !fileUrl) {
      throw new ProviderRequestError(502, "ERPNext upload_file response did not include a File document");
    }
    return {
      file: {
        name,
        file_name: optionalString(file.file_name) ?? fileName,
        file_url: fileUrl,
        is_private: Number(file.is_private) === 1 ? 1 : 0,
        attached_to_doctype: optionalString(file.attached_to_doctype) ?? null,
        attached_to_name: optionalString(file.attached_to_name) ?? null,
      },
    };
  },
  async get_logged_user(_input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextLoggedUserMethod),
      method: "GET",
      phase: "execute",
    });

    return {
      user: readRequiredMessageString(payload, "ERPNext get_logged_user response"),
    };
  },
  async list_documents(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildResourcePath(readRequiredString(input.doctype, "doctype")),
      method: "GET",
      query: compactObject({
        fields: encodeOptionalJson(input.fields),
        filters: encodeOptionalJson(input.filters),
        order_by: optionalString(input.order_by),
        limit_start: readOptionalIntegerString(input.start),
        limit_page_length: readOptionalIntegerString(input.page_length),
      }),
      phase: "execute",
    });

    return {
      documents: readRequiredDataArray(payload, "ERPNext list_documents response"),
    };
  },
  async get_document(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildDocumentPath(readRequiredString(input.doctype, "doctype"), readRequiredString(input.name, "name")),
      method: "GET",
      phase: "execute",
    });

    return {
      document: readRequiredDataObject(payload, "ERPNext get_document response"),
    };
  },
  async create_document(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildResourcePath(readRequiredString(input.doctype, "doctype")),
      method: "POST",
      body: readRequiredInputObject(input.data, "data"),
      phase: "execute",
    });

    return {
      document: readRequiredDataObject(payload, "ERPNext create_document response"),
    };
  },
  async update_document(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildDocumentPath(readRequiredString(input.doctype, "doctype"), readRequiredString(input.name, "name")),
      method: "PUT",
      body: readRequiredInputObject(input.fields, "fields"),
      phase: "execute",
    });

    return {
      document: readRequiredDataObject(payload, "ERPNext update_document response"),
    };
  },
  async delete_document(input, context) {
    await requestErpnext({
      ...context,
      path: buildDocumentPath(readRequiredString(input.doctype, "doctype"), readRequiredString(input.name, "name")),
      method: "DELETE",
      phase: "execute",
    });

    return {
      ok: true,
    };
  },
  async get_document_count(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextGetCountMethod),
      method: "GET",
      query: compactObject({
        doctype: readRequiredString(input.doctype, "doctype"),
        filters: encodeOptionalJson(input.filters),
      }),
      phase: "execute",
    });

    return {
      count: readRequiredMessageInteger(payload, "ERPNext get_document_count response"),
    };
  },
  async get_document_value(input, context) {
    assertExactlyOneNameOrFilters(input);
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextGetValueMethod),
      method: "GET",
      query: compactObject({
        doctype: readRequiredString(input.doctype, "doctype"),
        name: optionalString(input.name),
        filters: encodeOptionalJson(input.filters),
        fieldname: encodeFieldNames(input.fieldname),
      }),
      phase: "execute",
    });

    return {
      value: readRequiredMessageValue(payload, "ERPNext get_document_value response"),
    };
  },
  async set_document_value(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextSetValueMethod),
      method: "POST",
      body: {
        doctype: readRequiredString(input.doctype, "doctype"),
        name: readRequiredString(input.name, "name"),
        fieldname: readRequiredString(input.fieldname, "fieldname"),
        value: input.value,
      },
      phase: "execute",
    });

    return {
      document: readRequiredDocumentFromMethodResult(payload, "ERPNext set_document_value response"),
    };
  },
  async assign_document(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextAssignAddMethod),
      method: "POST",
      body: compactObject({
        doctype: readRequiredString(input.doctype, "doctype"),
        name: readRequiredString(input.name, "name"),
        // Frappe reads these from form_dict and parses assign_to with frappe.parse_json,
        // so a JSON array is accepted here.
        assign_to: readRequiredUserList(input.assign_to, "assign_to"),
        description: optionalString(input.description),
        priority: optionalString(input.priority),
        date: optionalString(input.date),
      }),
      phase: "execute",
    });

    return {
      assignments: readRequiredAssignmentsFromMethodResult(payload, "ERPNext assign_document response"),
    };
  },
  async unassign_document(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextAssignRemoveMethod),
      method: "POST",
      body: {
        doctype: readRequiredString(input.doctype, "doctype"),
        name: readRequiredString(input.name, "name"),
        // remove() takes a single user, not a list, unlike add().
        assign_to: readRequiredString(input.assign_to, "assign_to"),
      },
      phase: "execute",
    });

    return {
      assignments: readRequiredAssignmentsFromMethodResult(payload, "ERPNext unassign_document response"),
    };
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<ErpnextActionContext>({
  service,
  handlers: erpnextActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<ErpnextActionContext> {
    const credential = await requireApiKeyCredential(context, service);
    return {
      apiKey: credential.apiKey,
      apiSecret: readRequiredString(credential.values.apiSecret, "apiSecret"),
      baseUrl: normalizeBaseUrl(
        optionalString(credential.values.baseUrl) ?? optionalString(credential.metadata.baseUrl),
      ),
      fetcher,
      signal: context.signal,
      transitFiles: context.transitFiles,
    };
  },
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
});

export const proxy: ProviderProxyExecutor = async (input, context): Promise<ProxyExecutionResult> => {
  try {
    const credential = await requireApiKeyCredential(context, service);
    const baseUrl = normalizeBaseUrl(
      optionalString(credential.values.baseUrl) ?? optionalString(credential.metadata.baseUrl),
    );
    const apiSecret = readRequiredString(credential.values.apiSecret, "apiSecret");
    const url = createProviderProxyUrl(baseUrl, input.endpoint, input.query);
    const headers = normalizeProviderProxyHeaders(input.headers);
    headers.set("authorization", `token ${credential.apiKey}:${apiSecret}`);
    headers.set("user-agent", providerUserAgent);
    if (input.body !== undefined && !headers.has("content-type") && typeof input.body !== "string") {
      headers.set("content-type", "application/json");
    }

    const response = await proxyFetch(url, {
      method: input.method,
      headers,
      body:
        input.body === undefined ? undefined : typeof input.body === "string" ? input.body : JSON.stringify(input.body),
      signal: context.signal,
    });
    if (!response.ok) {
      const text = await readProviderProxyErrorMessage(response, "");
      throw new ProviderRequestError(response.status, text || `provider request failed with HTTP ${response.status}`);
    }
    return { ok: true, response: await readProviderProxyResponse(response) };
  } catch (error) {
    return toProviderProxyError(error, "provider request failed");
  }
};

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const guardedFetcher = createProviderFetch({ fetch: fetcher, allowPrivateNetwork: isPrivateNetworkAccessAllowed });
    const baseUrl = normalizeBaseUrl(input.values.baseUrl);
    const apiSecret = readRequiredString(input.values.apiSecret, "apiSecret");
    const payload = await requestErpnext({
      baseUrl,
      apiKey: input.apiKey,
      apiSecret,
      path: buildMethodPath(erpnextLoggedUserMethod),
      method: "GET",
      fetcher: guardedFetcher,
      signal,
      phase: "validate",
    });
    const user = readRequiredMessageString(payload, "ERPNext validation response");

    return {
      profile: {
        accountId: user,
        displayName: user,
      },
      grantedScopes: [],
      metadata: {
        baseUrl,
        validationEndpoint: buildMethodPath(erpnextLoggedUserMethod),
        user,
      },
    };
  },
};

async function requestErpnextDownload(
  fileUrl: string,
  context: ErpnextActionContext,
  method: string = erpnextDownloadMethod,
): Promise<Response> {
  // Keep file_url as data; Frappe resolves the File record and checks its read permission.
  const url = buildUrl(context.baseUrl, buildMethodPath(method), { file_url: fileUrl });
  const headers = buildHeaders(context.apiKey, context.apiSecret, false);
  headers.set("accept", "*/*");
  const response = await context.fetcher(url, { method: "GET", headers, signal: context.signal, redirect: "error" });
  if (response.ok) return response;

  const payload = await readProviderJsonBody(response, {
    emptyBody: {},
    invalidJsonMessage: "Invalid ERPNext download error response",
    invalidJsonFallback: (text) => ({ message: text }),
  });
  const message = extractErpnextErrorMessage(payload) ?? "";
  // Frappe v13 exposes the method on the File module. Retry only method lookup
  // failures, never permission errors, missing files, or other validation errors.
  if (
    method === erpnextDownloadMethod &&
    (response.status === 404 || response.status === 417) &&
    (message === "Invalid Method" ||
      (message.includes("frappe.handler") &&
        (message.includes("Failed to get method for command") ||
          /has no attribute ['"]download_file['"]/.test(message))))
  ) {
    return requestErpnextDownload(fileUrl, context, erpnextLegacyDownloadMethod);
  }
  throw createErpnextError(response.status, payload, "execute");
}

async function requestErpnext(input: ErpnextRequestOptions): Promise<unknown> {
  const url = buildUrl(input.baseUrl, input.path, input.query);
  const isFormBody = input.body instanceof FormData;
  let response: Response;
  try {
    response = await input.fetcher(url, {
      method: input.method,
      // FormData sets its own multipart content type and boundary.
      headers: buildHeaders(input.apiKey, input.apiSecret, input.body !== undefined && !isFormBody),
      body: input.body === undefined ? undefined : isFormBody ? (input.body as FormData) : JSON.stringify(input.body),
      signal: input.signal,
    });
  } catch (error) {
    throw new ProviderRequestError(
      502,
      error instanceof Error
        ? `ERPNext request failed for ${url}: ${error.message}`
        : `ERPNext request failed for ${url}`,
    );
  }

  const payload = await readErpnextPayload(response);
  if (!response.ok) {
    throw createErpnextError(response.status, payload, input.phase);
  }
  return payload;
}

function normalizeBaseUrl(value: unknown, allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed()): string {
  const raw = optionalString(value);
  if (!raw) {
    throw new ProviderRequestError(400, "baseUrl is required");
  }

  const url = assertPublicHttpUrl(raw, {
    fieldName: "baseUrl",
    allowPrivateNetwork,
    createError: (message) => new ProviderRequestError(400, message),
  });

  if (url.protocol !== "https:") {
    throw new ProviderRequestError(400, "baseUrl must use HTTPS");
  }
  if (url.username || url.password) {
    throw new ProviderRequestError(400, "baseUrl must not include username or password");
  }

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function buildHeaders(apiKey: string, apiSecret: string, hasBody: boolean): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `token ${apiKey}:${apiSecret}`,
    "User-Agent": providerUserAgent,
  });
  if (hasBody) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function buildResourcePath(doctype: string): string {
  return `/api/resource/${encodeURIComponent(doctype)}`;
}

function buildDocumentPath(doctype: string, name: string): string {
  return `${buildResourcePath(doctype)}/${encodeURIComponent(name)}`;
}

function buildMethodPath(methodName: string): string {
  return `/api/method/${methodName}`;
}

async function readErpnextPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      message: text,
    };
  }
}

function createErpnextError(status: number, payload: unknown, phase: ErpnextRequestPhase): ProviderRequestError {
  const message = extractErpnextErrorMessage(payload) ?? `ERPNext request failed with status ${status}`;

  if (status === 429) {
    return new ProviderRequestError(429, message);
  }
  if (status === 401 || status === 403) {
    return new ProviderRequestError(phase === "validate" ? 400 : status, message);
  }
  if (status === 400 || status === 404 || status === 409 || status === 417 || status === 422) {
    return new ProviderRequestError(status, message);
  }

  return new ProviderRequestError(status >= 500 ? 502 : status, message);
}

function extractErpnextErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  const record = optionalRecord(payload);
  if (!record) {
    return undefined;
  }

  return (
    parseServerMessages(optionalString(record._server_messages)) ??
    optionalString(record._error_message) ??
    optionalString(record.message) ??
    optionalString(record.exception) ??
    optionalString(record.exc_type)
  );
}

function parseServerMessages(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return undefined;
    }
    const firstMessage = parsed[0];
    if (typeof firstMessage === "string") {
      try {
        const nested = JSON.parse(firstMessage) as unknown;
        return optionalString(optionalRecord(nested)?.message);
      } catch {
        return optionalString(firstMessage);
      }
    }
  } catch {
    return value;
  }

  return undefined;
}

function readRequiredDataArray(payload: unknown, context: string): Array<Record<string, unknown>> {
  const data = optionalRecord(payload)?.data;
  if (!Array.isArray(data)) {
    throw new ProviderRequestError(502, `${context} did not include a data array`);
  }
  return data.map((item) => {
    const record = optionalRecord(item);
    if (!record) {
      throw new ProviderRequestError(502, `${context} contained a non-object document`);
    }
    return record;
  });
}

function readRequiredDataObject(payload: unknown, context: string): Record<string, unknown> {
  const record = optionalRecord(optionalRecord(payload)?.data);
  if (!record) {
    throw new ProviderRequestError(502, `${context} did not include a data object`);
  }
  return record;
}

function readRequiredMessageString(payload: unknown, context: string): string {
  const message = optionalRecord(payload)?.message;
  if (typeof message !== "string" || !message.trim()) {
    throw new ProviderRequestError(502, `${context} did not include a message string`);
  }
  return message;
}

function readRequiredMessageInteger(payload: unknown, context: string): number {
  const message = optionalRecord(payload)?.message;
  if (!Number.isInteger(message)) {
    throw new ProviderRequestError(502, `${context} did not include an integer message`);
  }
  return message as number;
}

function readRequiredMessageValue(payload: unknown, context: string): unknown {
  const record = optionalRecord(payload);
  if (!record || !Object.hasOwn(record, "message")) {
    throw new ProviderRequestError(502, `${context} did not include a message value`);
  }
  return record.message;
}

function readRequiredUserList(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new ProviderRequestError(400, `${fieldName} must be an array of user ids`);
  }
  const users = value.map((entry, index) => {
    const user = optionalString(entry);
    if (!user) {
      throw new ProviderRequestError(400, `${fieldName}[${index}] must be a non-empty user id`);
    }
    return user;
  });
  if (users.length === 0) {
    throw new ProviderRequestError(400, `${fieldName} must include at least one user id`);
  }
  return users;
}

function readRequiredAssignmentsFromMethodResult(
  payload: unknown,
  context: string,
): Array<{ owner: string; name: string }> {
  const message = optionalRecord(payload)?.message;
  if (!Array.isArray(message)) {
    throw new ProviderRequestError(502, `${context} did not include an assignment list`);
  }
  return message.map((entry) => {
    const record = optionalRecord(entry);
    const owner = optionalString(record?.owner);
    const name = optionalString(record?.name);
    if (!owner || !name) {
      throw new ProviderRequestError(502, `${context} included an assignment without owner and name`);
    }
    return { owner, name };
  });
}

function readRequiredDocumentFromMethodResult(payload: unknown, context: string): Record<string, unknown> {
  const record = optionalRecord(payload);
  if (!record) {
    throw new ProviderRequestError(502, `${context} did not include an object payload`);
  }

  const docs = record.docs;
  if (Array.isArray(docs) && docs.length > 0) {
    const firstDocument = optionalRecord(docs[0]);
    if (firstDocument) {
      return firstDocument;
    }
  }

  const messageDocument = optionalRecord(record.message);
  if (messageDocument) {
    return messageDocument;
  }

  throw new ProviderRequestError(502, `${context} did not include a document`);
}

function encodeOptionalJson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.stringify(value);
}

function encodeFieldNames(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  throw new ProviderRequestError(400, "fieldname must be a string or string array");
}

function assertExactlyOneNameOrFilters(input: Record<string, unknown>): void {
  const hasName = optionalString(input.name) !== undefined;
  const hasFilters = input.filters !== undefined;
  if (hasName === hasFilters) {
    throw new ProviderRequestError(400, "Provide exactly one of name or filters");
  }
}

function readRequiredString(value: unknown, fieldName: string): string {
  const stringValue = optionalString(value);
  if (!stringValue) {
    throw new ProviderRequestError(400, `${fieldName} is required`);
  }
  return stringValue;
}

function readRequiredInputObject(value: unknown, fieldName: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) {
    throw new ProviderRequestError(400, `${fieldName} must be an object`);
  }
  return record;
}

function readUploadBytes(value: unknown): Uint8Array<ArrayBuffer> {
  const encoded = typeof value === "string" ? value.replace(/\s+/g, "") : value;
  // Check the decoded size from the encoded length first so an oversized payload is never decoded.
  if (typeof encoded === "string") {
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    if (Math.floor((encoded.length * 3) / 4) - padding > erpnextUploadMaxBytes) {
      throw new ProviderRequestError(413, "contentBase64 must decode to 25 MB or less.");
    }
  }
  return base64Bytes(encoded, "contentBase64", (message) => new ProviderRequestError(400, message));
}

function readOptionalIntegerString(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  return String(value);
}
