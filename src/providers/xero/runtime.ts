import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderFetch, ProviderRuntimeHandler } from "../provider-runtime.ts";

import { Buffer } from "node:buffer";
import {
  compactObject,
  objectArray,
  optionalBoolean,
  optionalIntegerLike,
  optionalNumber,
  optionalRecord,
  optionalScalarString,
  optionalString,
  optionalStringArray,
  requiredNumber,
  requiredRecord,
  requiredString,
} from "../../core/cast.ts";
import { jsonObject } from "../../core/request.ts";
import {
  createProviderProxyUrl,
  createProviderTimeout,
  isAbortSignalError,
  ProviderRequestError,
  providerUserAgent,
  readProviderJsonBody,
  readProviderProxyResponse,
} from "../provider-runtime.ts";
import { xeroApiFamilies } from "./api-families.ts";
import { xeroDefaultCustomConnectionScopes } from "./scopes.ts";

export const xeroTokenUrl = "https://identity.xero.com/connect/token";

const requestTimeoutMs = 30_000;
const tokenExpiryLeewayMs = 60_000;
const allowedRetrievalAcceptHeaders = new Set([
  "application/json",
  "application/xml",
  "application/pdf",
  "application/octet-stream",
  "*/*",
]);

export interface XeroCustomConnectionCredential {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export interface XeroContext {
  credential: XeroCustomConnectionCredential;
  fetcher: ProviderFetch;
  signal?: AbortSignal;
}

interface XeroToken {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  expiresAt: number;
}

interface XeroRequestInput {
  path: string;
  context: XeroContext;
  baseUrl?: string;
  query?: Record<string, unknown>;
  method?: "GET" | "POST" | "PUT";
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  validation?: boolean;
}

const tokenCache = new Map<string, XeroToken>();
const pendingTokens = new Map<string, Promise<XeroToken>>();

export const xeroActionHandlers: Record<string, ProviderRuntimeHandler<XeroContext>> = {
  async get_organisation(_input, context) {
    return { organisation: await getOrganisation(context) };
  },
  async retrieve_endpoint(input, context) {
    const api = requiredString(input.api, "api", providerInputError);
    const family = xeroApiFamilies[api];
    if (!family) {
      throw providerInputError(`api must be one of ${Object.keys(xeroApiFamilies).join(", ")}`);
    }

    const accept = optionalString(input.accept) ?? "application/json";
    if (!allowedRetrievalAcceptHeaders.has(accept)) {
      throw providerInputError(
        "accept must be application/json, application/xml, application/pdf, application/octet-stream, or */*",
      );
    }

    const headers: Record<string, string> = { accept };
    const ifModifiedSince = optionalString(input.ifModifiedSince);
    if (ifModifiedSince) headers["if-modified-since"] = ifModifiedSince;
    const tenantId = optionalString(input.tenantId);
    if (tenantId) headers["xero-tenant-id"] = tenantId;

    const response = await requestXeroResponse({
      baseUrl: family.baseUrl,
      path: requiredString(input.endpoint, "endpoint", providerInputError),
      context,
      query: normalizeXeroRetrievalQuery(input.query),
      headers,
    });
    if (!response.ok) await throwXeroResponseError(response, false);
    return readProviderProxyResponse(response);
  },
  async list_contacts(input, context) {
    return listXeroCollection(context, "/Contacts", "Contacts", "contacts", {
      page: optionalPositiveInteger(input.page, "page"),
      pageSize: optionalPositiveInteger(input.pageSize, "pageSize"),
      order: optionalString(input.orderBy),
      searchTerm: optionalString(input.searchTerm),
      summaryOnly: optionalBoolean(input.summaryOnly),
      includeArchived: optionalBoolean(input.includeArchived),
    });
  },
  async get_contact(input, context) {
    const contactId = requiredString(input.contactId, "contactId", providerInputError);
    const payload = await requestXeroJson({ path: `/Contacts/${encodeURIComponent(contactId)}`, context });
    return { contact: firstCollectionItem(payload, "Contacts") };
  },
  async create_contact(input, context) {
    const contact = compactObject({
      Name: requiredString(input.name, "name", providerInputError),
      FirstName: optionalString(input.firstName),
      LastName: optionalString(input.lastName),
      EmailAddress: optionalString(input.emailAddress),
      ContactNumber: optionalString(input.contactNumber),
      AccountNumber: optionalString(input.accountNumber),
    });
    const payload = await requestXeroJson({
      path: "/Contacts",
      context,
      method: "PUT",
      body: { Contacts: [contact] },
      headers: idempotencyHeaders(input.idempotencyKey),
    });
    return { contact: firstCollectionItem(payload, "Contacts") };
  },
  async list_accounts(input, context) {
    return listXeroCollection(context, "/Accounts", "Accounts", "accounts", {
      where: optionalString(input.where),
      order: optionalString(input.orderBy),
    });
  },
  async list_bank_transactions(input, context) {
    return listXeroCollection(
      context,
      "/BankTransactions",
      "BankTransactions",
      "bankTransactions",
      {
        page: optionalPositiveInteger(input.page, "page"),
        where: combineXeroWhere(
          optionalString(input.where),
          booleanEqualityClause("IsReconciled", optionalBoolean(input.reconciled)),
        ),
        order: optionalString(input.orderBy),
        includeDeleted: optionalBoolean(input.includeDeleted),
        unitdp: optionalUnitDecimalPlaces(input.unitDecimalPlaces),
      },
      modifiedAfterHeaders(input.ifModifiedSince),
    );
  },
  async list_payments(input, context) {
    return listXeroCollection(
      context,
      "/Payments",
      "Payments",
      "payments",
      {
        page: optionalPositiveInteger(input.page, "page"),
        pageSize: optionalPositiveInteger(input.pageSize, "pageSize"),
        where: combineXeroWhere(
          optionalString(input.where),
          booleanEqualityClause("IsReconciled", optionalBoolean(input.reconciled)),
        ),
        order: optionalString(input.orderBy),
      },
      modifiedAfterHeaders(input.ifModifiedSince),
    );
  },
  async list_batch_payments(input, context) {
    return listXeroCollection(
      context,
      "/BatchPayments",
      "BatchPayments",
      "batchPayments",
      {
        where: combineXeroWhere(
          optionalString(input.where),
          booleanEqualityClause("IsReconciled", optionalBoolean(input.reconciled)),
        ),
        order: optionalString(input.orderBy),
      },
      modifiedAfterHeaders(input.ifModifiedSince),
    );
  },
  async list_bank_transfers(input, context) {
    return listXeroCollection(
      context,
      "/BankTransfers",
      "BankTransfers",
      "bankTransfers",
      {
        where: combineXeroWhere(
          optionalString(input.where),
          booleanEqualityClause("FromIsReconciled", optionalBoolean(input.sourceReconciled)),
          booleanEqualityClause("ToIsReconciled", optionalBoolean(input.destinationReconciled)),
        ),
        order: optionalString(input.orderBy),
        includeDeleted: optionalBoolean(input.includeDeleted),
      },
      modifiedAfterHeaders(input.ifModifiedSince),
    );
  },
  async get_bank_summary(input, context) {
    const payload = await requestXeroJson({
      path: "/Reports/BankSummary",
      context,
      query: {
        fromDate: optionalString(input.fromDate),
        toDate: optionalString(input.toDate),
      },
    });
    return { report: firstCollectionItem(payload, "Reports") };
  },
  async get_cash_validation(input, context) {
    const payload = await requestXeroJson({
      baseUrl: xeroApiFamilies.finance!.baseUrl,
      path: "/1.0/CashValidation",
      context,
      query: {
        balanceDate: optionalString(input.balanceDate),
        asAtSystemDate: optionalString(input.asAtSystemDate),
        beginDate: optionalString(input.beginDate),
      },
    });
    return { accounts: objectArray(payload, "Xero cash validation response", providerResponseError) };
  },
  async get_bank_statement_reconciliation(input, context) {
    const payload = await requestXeroJson({
      baseUrl: xeroApiFamilies.finance!.baseUrl,
      path: "/1.0/BankStatementsPlus/statements",
      context,
      query: {
        BankAccountID: requiredString(input.bankAccountId, "bankAccountId", providerInputError),
        FromDate: requiredString(input.fromDate, "fromDate", providerInputError),
        ToDate: requiredString(input.toDate, "toDate", providerInputError),
        SummaryOnly: optionalBoolean(input.summaryOnly),
      },
    });
    return { reconciliation: requiredRecord(payload, "Xero bank statement response", providerResponseError) };
  },
  async list_tax_rates(_input, context) {
    return listXeroCollection(context, "/TaxRates", "TaxRates", "taxRates");
  },
  async list_tracking_categories(_input, context) {
    return listXeroCollection(context, "/TrackingCategories", "TrackingCategories", "trackingCategories");
  },
  async list_items(input, context) {
    return listXeroCollection(context, "/Items", "Items", "items", {
      where: optionalString(input.where),
      order: optionalString(input.orderBy),
    });
  },
  async list_invoices(input, context) {
    return listXeroCollection(context, "/Invoices", "Invoices", "invoices", {
      page: optionalPositiveInteger(input.page, "page"),
      pageSize: optionalPositiveInteger(input.pageSize, "pageSize"),
      order: optionalString(input.orderBy),
      searchTerm: optionalString(input.searchTerm),
      summaryOnly: optionalBoolean(input.summaryOnly),
      Statuses: optionalStringArray(input.statuses)?.join(","),
      ContactIDs: optionalStringArray(input.contactIds)?.join(","),
      InvoiceNumbers: optionalStringArray(input.invoiceNumbers)?.join(","),
    });
  },
  async get_invoice(input, context) {
    const invoiceId = requiredString(input.invoiceId, "invoiceId", providerInputError);
    const payload = await requestXeroJson({ path: `/Invoices/${encodeURIComponent(invoiceId)}`, context });
    return { invoice: firstCollectionItem(payload, "Invoices") };
  },
  async create_draft_invoice(input, context) {
    const invoice = compactObject({
      Type: requiredString(input.type, "type", providerInputError),
      Contact: { ContactID: requiredString(input.contactId, "contactId", providerInputError) },
      Date: optionalString(input.date),
      DueDate: optionalString(input.dueDate),
      Reference: optionalString(input.reference),
      CurrencyCode: optionalString(input.currencyCode),
      LineAmountTypes: optionalString(input.lineAmountTypes),
      Status: "DRAFT",
      LineItems: objectArray(input.lineItems, "lineItems", providerInputError).map((line, index) =>
        compactObject({
          Description: requiredString(line.description, `lineItems[${index}].description`, providerInputError),
          Quantity: requiredNumber(line.quantity, `lineItems[${index}].quantity`),
          UnitAmount: requiredNumber(line.unitAmount, `lineItems[${index}].unitAmount`),
          AccountCode: requiredString(line.accountCode, `lineItems[${index}].accountCode`, providerInputError),
          TaxType: optionalString(line.taxType),
        }),
      ),
    });
    const payload = await requestXeroJson({
      path: "/Invoices",
      context,
      method: "PUT",
      body: { Invoices: [invoice] },
      headers: idempotencyHeaders(input.idempotencyKey),
    });
    return { invoice: firstCollectionItem(payload, "Invoices") };
  },
};

export function createXeroCredential(values: Record<string, unknown>): XeroCustomConnectionCredential {
  const scopes = (optionalString(values.scopes) ?? xeroDefaultCustomConnectionScopes.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  if (scopes.length === 0) throw providerInputError("scopes must contain at least one Xero scope");

  return {
    clientId: requiredString(values.clientId, "clientId", providerInputError),
    clientSecret: requiredString(values.clientSecret, "clientSecret", providerInputError),
    scopes: [...new Set(scopes)],
  };
}

export async function validateXeroCredential(
  values: Record<string, unknown>,
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const credential = createXeroCredential(values);
  const context = { credential, fetcher, signal };
  const token = await getXeroToken(context, true);
  const organisation = await getOrganisation(context, true);
  const organisationId = requiredString(organisation.OrganisationID, "OrganisationID", providerResponseError);
  const name = requiredString(organisation.Name, "Name", providerResponseError);

  return {
    profile: { accountId: organisationId, displayName: name },
    grantedScopes: token.scopes,
    metadata: jsonObject({
      organisationId,
      organisationName: name,
      baseCurrency: optionalString(organisation.BaseCurrency),
      countryCode: optionalString(organisation.CountryCode),
      customConnection: true,
    }),
  };
}

async function getOrganisation(context: XeroContext, validation = false): Promise<Record<string, unknown>> {
  const payload = await requestXeroJson({ path: "/Organisation", context, validation });
  return firstCollectionItem(payload, "Organisations");
}

async function listXeroCollection(
  context: XeroContext,
  path: string,
  providerField: string,
  outputField: string,
  query: Record<string, unknown> = {},
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const payload = await requestXeroJson({ path, context, query, headers });
  const record = requiredRecord(payload, "Xero response", providerResponseError);
  const values = record[providerField];
  if (!Array.isArray(values)) throw providerResponseError(`Xero response missing ${providerField}`);

  return {
    [outputField]: values.map((value) => requiredRecord(value, providerField, providerResponseError)),
    pagination: optionalRecord(record.pagination) ?? null,
  };
}

async function requestXeroJson(input: XeroRequestInput): Promise<unknown> {
  const response = await requestXeroResponse(input);
  const payload = await readProviderJsonBody(response, {
    emptyBody: null,
    invalidJsonMessage: "Xero returned invalid JSON",
  });
  if (!response.ok) throw createXeroApiError(response.status, payload, input.validation === true);
  return payload;
}

async function requestXeroResponse(input: XeroRequestInput): Promise<Response> {
  let response = await xeroApiFetch(input, false);
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    response = await xeroApiFetch(input, true);
  }
  return response;
}

async function xeroApiFetch(input: XeroRequestInput, forceTokenRefresh: boolean): Promise<Response> {
  const url = createProviderProxyUrl(input.baseUrl ?? xeroApiFamilies.accounting!.baseUrl, input.path, input.query);
  const token = await getXeroToken(input.context, forceTokenRefresh);

  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `${token.tokenType} ${token.accessToken}`,
    "user-agent": providerUserAgent,
    ...input.headers,
  };
  if (input.body !== undefined) headers["content-type"] = "application/json";

  return fetchWithTimeout(
    input.context.fetcher,
    url,
    {
      method: input.method ?? "GET",
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    },
    input.context.signal,
    "Xero API",
  );
}

async function throwXeroResponseError(response: Response, validation: boolean): Promise<never> {
  const payload = await readProviderJsonBody(response, {
    emptyBody: null,
    invalidJsonMessage: "Xero returned an unreadable error response",
    invalidJsonFallback: (text) => text,
  });
  throw createXeroApiError(response.status, payload, validation);
}

async function getXeroToken(context: XeroContext, forceRefresh = false): Promise<XeroToken> {
  const cacheKey = `${context.credential.clientId}\u0000${context.credential.scopes.join(" ")}`;
  if (!forceRefresh) {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - tokenExpiryLeewayMs > Date.now()) return cached;
  } else {
    tokenCache.delete(cacheKey);
  }

  const pending = pendingTokens.get(cacheKey);
  if (pending) return pending;

  const request = requestXeroToken(context).finally(() => pendingTokens.delete(cacheKey));
  pendingTokens.set(cacheKey, request);
  return request;
}

async function requestXeroToken(context: XeroContext): Promise<XeroToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: context.credential.scopes.join(" "),
  });
  const response = await fetchWithTimeout(
    context.fetcher,
    new URL(xeroTokenUrl),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${context.credential.clientId}:${context.credential.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": providerUserAgent,
      },
      body: body.toString(),
    },
    context.signal,
    "Xero token",
  );
  const payload = await readProviderJsonBody(response, {
    emptyBody: null,
    invalidJsonMessage: "Xero token endpoint returned invalid JSON",
  });
  if (!response.ok) throw createXeroApiError(response.status, payload, true);

  const record = requiredRecord(payload, "Xero token response", providerResponseError);
  const expiresIn = optionalNumber(record.expires_in);
  if (expiresIn === undefined || expiresIn <= 0) throw providerResponseError("Xero token response missing expires_in");
  const token: XeroToken = {
    accessToken: requiredString(record.access_token, "access_token", providerResponseError),
    tokenType: optionalString(record.token_type) ?? "Bearer",
    scopes: (optionalString(record.scope) ?? context.credential.scopes.join(" ")).split(/\s+/).filter(Boolean),
    expiresAt: Date.now() + expiresIn * 1000,
  };
  const cacheKey = `${context.credential.clientId}\u0000${context.credential.scopes.join(" ")}`;
  tokenCache.set(cacheKey, token);
  return token;
}

async function fetchWithTimeout(
  fetcher: ProviderFetch,
  url: URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
  source: string,
): Promise<Response> {
  const timeout = createProviderTimeout(signal, requestTimeoutMs);
  try {
    return await fetcher(url, { ...init, signal: timeout.signal });
  } catch (error) {
    if (timeout.didTimeout()) throw new ProviderRequestError(504, `${source} request timed out`, error);
    if (isAbortSignalError(signal, error))
      throw new ProviderRequestError(499, `${source} request was cancelled`, error);
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `${source} request failed: ${error.message}` : `${source} request failed`,
      error,
    );
  } finally {
    timeout.cleanup();
  }
}

function firstCollectionItem(payload: unknown, fieldName: string): Record<string, unknown> {
  const record = requiredRecord(payload, "Xero response", providerResponseError);
  const values = record[fieldName];
  if (!Array.isArray(values) || values.length === 0) {
    throw providerResponseError(`Xero response missing ${fieldName}`);
  }
  return requiredRecord(values[0], fieldName, providerResponseError);
}

function createXeroApiError(status: number, payload: unknown, validation: boolean): ProviderRequestError {
  const message = extractXeroError(payload) ?? `Xero request failed with status ${status}`;
  if (validation && (status === 401 || status === 403)) return new ProviderRequestError(400, message, payload);
  return new ProviderRequestError(status || 502, message, payload);
}

function extractXeroError(payload: unknown): string | undefined {
  const record = optionalRecord(payload);
  if (!record) return typeof payload === "string" ? optionalString(payload) : undefined;

  const message =
    optionalString(record.Message) ?? optionalString(record.error_description) ?? optionalString(record.error);
  if (message) return message;
  if (!Array.isArray(record.Elements)) return undefined;
  for (const element of record.Elements) {
    const validations = optionalRecord(element)?.ValidationErrors;
    if (!Array.isArray(validations)) continue;
    for (const validation of validations) {
      const detail = optionalString(optionalRecord(validation)?.Message);
      if (detail) return detail;
    }
  }
  return undefined;
}

function optionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  const result = optionalIntegerLike(value, fieldName, providerInputError);
  if (result !== undefined && result < 1) throw providerInputError(`${fieldName} must be a positive integer`);
  return result;
}

function optionalUnitDecimalPlaces(value: unknown): number | undefined {
  const result = optionalIntegerLike(value, "unitDecimalPlaces", providerInputError);
  if (result !== undefined && result !== 2 && result !== 4) {
    throw providerInputError("unitDecimalPlaces must be 2 or 4");
  }
  return result;
}

function booleanEqualityClause(field: string, value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : `${field}==${value}`;
}

function combineXeroWhere(...clauses: Array<string | undefined>): string | undefined {
  const defined = clauses.filter((clause): clause is string => clause !== undefined);
  if (defined.length === 0) return undefined;
  return defined.map((clause) => `(${clause})`).join(" AND ");
}

function modifiedAfterHeaders(value: unknown): Record<string, string> | undefined {
  const modifiedAfter = optionalString(value);
  return modifiedAfter ? { "if-modified-since": modifiedAfter } : undefined;
}

function idempotencyHeaders(value: unknown): Record<string, string> | undefined {
  const key = optionalString(value);
  if (!key) return undefined;
  if (key.length > 128) throw providerInputError("idempotencyKey must be at most 128 characters");
  return { "idempotency-key": key };
}

function normalizeXeroRetrievalQuery(value: unknown): Record<string, string> | undefined {
  const input = optionalRecord(value);
  if (!input) return undefined;

  const query: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (!key || key.length > 128) throw providerInputError("query parameter names must be 1 to 128 characters");
    const scalar = optionalScalarString(rawValue);
    if (scalar === undefined) {
      throw providerInputError(`query.${key} must be a string, number, or boolean`);
    }
    query[key] = scalar;
  }
  return query;
}

function providerInputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function providerResponseError(message: string): ProviderRequestError {
  return new ProviderRequestError(502, message);
}
