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
const allowedReportTimeframes = new Set(["MONTH", "QUARTER", "YEAR"]);
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

interface XeroApiErrorDetails {
  xeroResponse: unknown;
  requestedScopes: string[];
  tokenScopes: string[];
  accessTokenRefreshAttempted: boolean;
  correlationId?: string;
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
    if (ifModifiedSince) headers["if-modified-since"] = xeroModifiedSinceValue(ifModifiedSince);
    const tenantId = optionalString(input.tenantId);
    if (tenantId) headers["xero-tenant-id"] = tenantId;

    const response = await requestXeroResponse({
      baseUrl: family.baseUrl,
      path: requiredString(input.endpoint, "endpoint", providerInputError),
      context,
      query: normalizeXeroRetrievalQuery(input.query),
      headers,
    });
    if (!response.ok) await throwXeroResponseError(response, false, context);
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
  async get_profit_and_loss(input, context) {
    const payload = await requestXeroJson({
      path: "/Reports/ProfitAndLoss",
      context,
      query: {
        fromDate: optionalString(input.fromDate),
        toDate: optionalString(input.toDate),
        periods: optionalReportPeriods(input.periods),
        timeframe: optionalReportTimeframe(input.timeframe),
      },
    });
    return { report: firstCollectionItem(payload, "Reports") };
  },
  async get_balance_sheet(input, context) {
    const payload = await requestXeroJson({
      path: "/Reports/BalanceSheet",
      context,
      query: {
        date: optionalString(input.date),
        periods: optionalReportPeriods(input.periods),
        timeframe: optionalReportTimeframe(input.timeframe),
      },
    });
    return { report: firstCollectionItem(payload, "Reports") };
  },
  async get_trial_balance(input, context) {
    const payload = await requestXeroJson({
      path: "/Reports/TrialBalance",
      context,
      query: {
        date: optionalString(input.date),
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
  async list_quotes(input, context) {
    return listXeroCollection(context, "/Quotes", "Quotes", "quotes", {
      page: optionalPositiveInteger(input.page, "page"),
      order: optionalString(input.orderBy),
      Status: optionalString(input.status),
      ContactID: optionalString(input.contactId),
      DateFrom: optionalString(input.dateFrom),
      DateTo: optionalString(input.dateTo),
    });
  },
  async get_quote(input, context) {
    const quoteId = requiredString(input.quoteId, "quoteId", providerInputError);
    const payload = await requestXeroJson({ path: `/Quotes/${encodeURIComponent(quoteId)}`, context });
    return { quote: firstCollectionItem(payload, "Quotes") };
  },
  async create_quote(input, context) {
    const quote = compactObject({
      Contact: { ContactID: requiredString(input.contactId, "contactId", providerInputError) },
      Date: optionalString(input.date),
      ExpiryDate: optionalString(input.expiryDate),
      Title: optionalString(input.title),
      Summary: optionalString(input.summary),
      Terms: optionalString(input.terms),
      Reference: optionalString(input.reference),
      QuoteNumber: optionalString(input.quoteNumber),
      CurrencyCode: optionalString(input.currencyCode),
      LineAmountTypes: optionalString(input.lineAmountTypes),
      Status: optionalString(input.status) ?? "DRAFT",
      LineItems: objectArray(input.lineItems, "lineItems", providerInputError).map((line, index) =>
        compactObject({
          Description: requiredString(line.description, `lineItems[${index}].description`, providerInputError),
          Quantity: requiredNumber(line.quantity, `lineItems[${index}].quantity`),
          UnitAmount: requiredNumber(line.unitAmount, `lineItems[${index}].unitAmount`),
          AccountCode: optionalString(line.accountCode),
          TaxType: optionalString(line.taxType),
        }),
      ),
    });
    const payload = await requestXeroJson({
      path: "/Quotes",
      context,
      method: "PUT",
      body: { Quotes: [quote] },
      headers: idempotencyHeaders(input.idempotencyKey),
    });
    return { quote: firstCollectionItem(payload, "Quotes") };
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
  if (!response.ok) await throwXeroResponseError(response, input.validation === true, input.context);
  const payload = await readProviderJsonBody(response, {
    emptyBody: null,
    invalidJsonMessage: "Xero returned invalid JSON",
  });
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

async function throwXeroResponseError(response: Response, validation: boolean, context: XeroContext): Promise<never> {
  const payload = await readProviderJsonBody(response, {
    emptyBody: null,
    invalidJsonMessage: "Xero returned an unreadable error response",
    invalidJsonFallback: (text) => text,
  });
  const cachedToken = tokenCache.get(xeroTokenCacheKey(context.credential));
  const correlationId =
    response.headers.get("xero-correlation-id") ?? response.headers.get("x-correlation-id") ?? undefined;
  const details: XeroApiErrorDetails = {
    xeroResponse: payload,
    requestedScopes: [...context.credential.scopes],
    tokenScopes: cachedToken ? [...cachedToken.scopes] : [],
    accessTokenRefreshAttempted: response.status === 401,
  };
  if (correlationId) details.correlationId = correlationId;
  throw createXeroApiError(response.status, payload, validation, details);
}

async function getXeroToken(context: XeroContext, forceRefresh = false): Promise<XeroToken> {
  const cacheKey = xeroTokenCacheKey(context.credential);
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
  const cacheKey = xeroTokenCacheKey(context.credential);
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

function createXeroApiError(
  status: number,
  payload: unknown,
  validation: boolean,
  details: unknown = payload,
): ProviderRequestError {
  const providerMessage = extractXeroError(payload) ?? `Xero request failed with status ${status}`;
  const detailRecord = optionalRecord(details);
  const message =
    status === 401 && detailRecord?.accessTokenRefreshAttempted === true
      ? refreshedTokenRejectedMessage(providerMessage, detailRecord)
      : providerMessage;
  if (validation && (status === 401 || status === 403)) return new ProviderRequestError(400, message, details);
  return new ProviderRequestError(status || 502, message, details);
}

// A 401 here has already survived a token refresh, so the client credentials are good and the
// old wording ("Xero rejected the access token") sent people off checking a credential that was
// never the problem. The scopes the token actually carries are already collected in the error
// details, so name them: a missing scope is the usual cause and is then obvious at a glance.
function refreshedTokenRejectedMessage(providerMessage: string, details: Record<string, unknown>): string {
  const tokenScopes = Array.isArray(details.tokenScopes)
    ? details.tokenScopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const scopeNote = tokenScopes.length > 0 ? ` The connection is authorised for: ${tokenScopes.join(", ")}.` : "";
  return (
    `Xero refused this request as unauthorised: ${providerMessage}. A fresh access token was obtained first, ` +
    `so the client credentials are valid: this is usually an endpoint the connection has not been granted a ` +
    `scope for, or a disconnected Xero organisation, rather than an expired token.${scopeNote}`
  );
}

function extractXeroError(payload: unknown): string | undefined {
  const record = optionalRecord(payload);
  if (!record) return typeof payload === "string" ? optionalString(payload) : undefined;

  const message =
    optionalString(record.Message) ??
    optionalString(record.Detail) ??
    optionalString(record.error_description) ??
    optionalString(record.error);
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

function optionalReportPeriods(value: unknown): number | undefined {
  const result = optionalIntegerLike(value, "periods", providerInputError);
  if (result !== undefined && (result < 1 || result > 11)) {
    throw providerInputError("periods must be between 1 and 11");
  }
  return result;
}

function optionalReportTimeframe(value: unknown): string | undefined {
  const result = optionalString(value);
  if (result !== undefined && !allowedReportTimeframes.has(result)) {
    throw providerInputError("timeframe must be MONTH, QUARTER, or YEAR");
  }
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

const modifiedSincePattern =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?)?$/u;

/**
 * Normalise a modified-since input to the spelling Xero's If-Modified-Since
 * header documents: a plain UTC timestamp with no offset, 2026-08-01T00:00:00.
 *
 * Accepts that form, one carrying an offset, and a bare date. A form with no
 * offset is read as UTC, because `new Date("2026-08-01T00:00:00")` would read
 * it in the gateway's local zone and shift the window.
 */
export function xeroModifiedSinceValue(raw: string, field = "ifModifiedSince"): string {
  const match = modifiedSincePattern.exec(raw.trim());
  if (!match) {
    throw providerInputError(
      `${field} must be a UTC timestamp such as 2026-08-01T00:00:00, optionally with an offset such as ` +
        `2026-08-01T00:00:00Z or 2026-08-01T08:00:00+08:00, or a bare date such as 2026-08-01; received ${raw}`,
    );
  }
  const [, year, month, day, hour = "00", minute = "00", second = "00", offset] = match;
  if (Number(month) < 1 || Number(month) > 12) {
    throw providerInputError(`${field} has no month ${month}: ${raw}`);
  }
  // Date rolls an impossible day forward (30 February becomes 2 March) rather
  // than failing, which would silently move the window, so check it here.
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(day) < 1 || Number(day) > lastDay) {
    throw providerInputError(`${field} has no day ${day} in ${year}-${month} (that month ends on ${lastDay}): ${raw}`);
  }
  const suffix = offset === undefined || offset === "Z" ? "Z" : withOffsetColon(offset);
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${suffix}`);
  if (Number.isNaN(parsed.getTime())) {
    throw providerInputError(`${field} is not a real time of day: ${raw}`);
  }
  return parsed.toISOString().slice(0, 19);
}

function withOffsetColon(offset: string): string {
  return offset.includes(":") ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
}

function modifiedAfterHeaders(value: unknown): Record<string, string> | undefined {
  const modifiedAfter = optionalString(value);
  return modifiedAfter ? { "if-modified-since": xeroModifiedSinceValue(modifiedAfter) } : undefined;
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

function xeroTokenCacheKey(credential: XeroCustomConnectionCredential): string {
  return `${credential.clientId}\u0000${credential.scopes.join(" ")}`;
}
