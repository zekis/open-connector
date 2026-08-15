import type { ProviderFetch } from "../provider-runtime.ts";
import type { XeroContext } from "./runtime.ts";

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { validateXeroCredential, xeroActionHandlers } from "./runtime.ts";

describe("Xero Custom Connection runtime", () => {
  it("exchanges app credentials once and identifies the connected organisation", async () => {
    const fetcher = createXeroFetch();
    const values = {
      clientId: "validation-client",
      clientSecret: "validation-secret",
      scopes: "accounting.settings.read accounting.contacts.read",
    };

    const result = await validateXeroCredential(values, fetcher);
    await xeroActionHandlers.get_organisation!({}, createContext(values, fetcher));

    expect(result).toEqual({
      profile: { accountId: "95b6ff88-508e-407f-b76a-f7d4db9345bb", displayName: "Example Pty Ltd" },
      grantedScopes: ["accounting.settings.read", "accounting.contacts.read"],
      metadata: {
        organisationId: "95b6ff88-508e-407f-b76a-f7d4db9345bb",
        organisationName: "Example Pty Ltd",
        baseCurrency: "AUD",
        countryCode: "AU",
        customConnection: true,
      },
    });
    const tokenCalls = vi
      .mocked(fetcher)
      .mock.calls.filter(([input]) => requestUrl(input).hostname === "identity.xero.com");
    expect(tokenCalls).toHaveLength(1);
    expect(new Headers(tokenCalls[0]![1]?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("validation-client:validation-secret").toString("base64")}`,
    );
    expect(String(tokenCalls[0]![1]?.body)).toBe(
      "grant_type=client_credentials&scope=accounting.settings.read+accounting.contacts.read",
    );
    const apiCall = vi.mocked(fetcher).mock.calls.find(([input]) => requestUrl(input).hostname === "api.xero.com")!;
    expect(new Headers(apiCall[1]?.headers).has("xero-tenant-id")).toBe(false);
  });

  it("maps invoice filters to Xero's documented query parameters", async () => {
    const fetcher = createXeroFetch();
    const context = createContext(
      {
        clientId: "list-client",
        clientSecret: "secret",
        scopes: "accounting.invoices.read",
      },
      fetcher,
    );

    const result = await xeroActionHandlers.list_invoices!(
      {
        page: 2,
        pageSize: 25,
        orderBy: "UpdatedDateUTC DESC",
        statuses: ["DRAFT", "AUTHORISED"],
        contactIds: ["835a5877-2fa9-4c4f-b84e-179f7e7d8bc0"],
        summaryOnly: true,
      },
      context,
    );

    expect(result).toEqual({
      invoices: [{ InvoiceID: "3c9a5d13-e20d-43f1-937d-a2265642eb14", Status: "DRAFT" }],
      pagination: { page: 2, pageSize: 25, pageCount: 1, itemCount: 1 },
    });
    const apiCall = vi
      .mocked(fetcher)
      .mock.calls.find(([input]) => requestUrl(input).pathname === "/api.xro/2.0/Invoices")!;
    expect(Object.fromEntries(requestUrl(apiCall[0]).searchParams)).toEqual({
      page: "2",
      pageSize: "25",
      order: "UpdatedDateUTC DESC",
      summaryOnly: "true",
      Statuses: "DRAFT,AUTHORISED",
      ContactIDs: "835a5877-2fa9-4c4f-b84e-179f7e7d8bc0",
    });
  });

  it("creates invoices as drafts with Xero field names", async () => {
    const fetcher = createXeroFetch();
    const context = createContext(
      { clientId: "draft-client", clientSecret: "secret", scopes: "accounting.invoices" },
      fetcher,
    );

    await xeroActionHandlers.create_draft_invoice!(
      {
        type: "ACCREC",
        contactId: "835a5877-2fa9-4c4f-b84e-179f7e7d8bc0",
        reference: "PROJECT-2158",
        idempotencyKey: "flow-run-2158",
        lineItems: [{ description: "Consulting", quantity: 2, unitAmount: 175, accountCode: "200" }],
      },
      context,
    );

    const apiCall = vi
      .mocked(fetcher)
      .mock.calls.find(([input]) => requestUrl(input).pathname === "/api.xro/2.0/Invoices")!;
    expect(apiCall[1]?.method).toBe("PUT");
    expect(new Headers(apiCall[1]?.headers).get("idempotency-key")).toBe("flow-run-2158");
    expect(JSON.parse(String(apiCall[1]?.body))).toEqual({
      Invoices: [
        {
          Type: "ACCREC",
          Contact: { ContactID: "835a5877-2fa9-4c4f-b84e-179f7e7d8bc0" },
          Reference: "PROJECT-2158",
          Status: "DRAFT",
          LineItems: [{ Description: "Consulting", Quantity: 2, UnitAmount: 175, AccountCode: "200" }],
        },
      ],
    });
  });

  it("retrieves the reconciliation flags Xero exposes across accounting resources", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.hostname === "identity.xero.com") {
        return jsonResponse({ access_token: "reconciliation-token", expires_in: 1800, token_type: "Bearer" });
      }
      switch (url.pathname) {
        case "/api.xro/2.0/BankTransactions":
          return jsonResponse({ BankTransactions: [{ BankTransactionID: "bank-1", IsReconciled: false }] });
        case "/api.xro/2.0/Payments":
          return jsonResponse({ Payments: [{ PaymentID: "payment-1", IsReconciled: true }] });
        case "/api.xro/2.0/BatchPayments":
          return jsonResponse({ BatchPayments: [{ BatchPaymentID: "batch-1", IsReconciled: true }] });
        case "/api.xro/2.0/BankTransfers":
          return jsonResponse({
            BankTransfers: [{ BankTransferID: "transfer-1", FromIsReconciled: true, ToIsReconciled: false }],
          });
        default:
          throw new Error(`Unexpected Xero URL: ${url}`);
      }
    }) as ProviderFetch;
    const context = createContext(
      {
        clientId: "reconciliation-client",
        clientSecret: "secret",
        scopes: "accounting.payments.read accounting.banktransactions.read",
      },
      fetcher,
    );

    const bankTransactions = await xeroActionHandlers.list_bank_transactions!(
      {
        page: 2,
        reconciled: false,
        includeDeleted: true,
        unitDecimalPlaces: 4,
        where: 'Status=="AUTHORISED"',
        ifModifiedSince: "2026-08-01T00:00:00Z",
      },
      context,
    );
    const payments = await xeroActionHandlers.list_payments!({ page: 1, pageSize: 250, reconciled: true }, context);
    const batchPayments = await xeroActionHandlers.list_batch_payments!({ reconciled: true }, context);
    const bankTransfers = await xeroActionHandlers.list_bank_transfers!(
      { sourceReconciled: true, destinationReconciled: false, includeDeleted: true },
      context,
    );

    expect(bankTransactions).toEqual({
      bankTransactions: [{ BankTransactionID: "bank-1", IsReconciled: false }],
      pagination: null,
    });
    expect(payments).toEqual({
      payments: [{ PaymentID: "payment-1", IsReconciled: true }],
      pagination: null,
    });
    expect(batchPayments).toEqual({
      batchPayments: [{ BatchPaymentID: "batch-1", IsReconciled: true }],
      pagination: null,
    });
    expect(bankTransfers).toEqual({
      bankTransfers: [{ BankTransferID: "transfer-1", FromIsReconciled: true, ToIsReconciled: false }],
      pagination: null,
    });

    const apiCalls = vi.mocked(fetcher).mock.calls.filter(([input]) => requestUrl(input).hostname === "api.xero.com");
    const bankTransactionCall = apiCalls.find(
      ([input]) => requestUrl(input).pathname === "/api.xro/2.0/BankTransactions",
    )!;
    expect(Object.fromEntries(requestUrl(bankTransactionCall[0]).searchParams)).toEqual({
      page: "2",
      where: '(Status=="AUTHORISED") AND (IsReconciled==false)',
      includeDeleted: "true",
      unitdp: "4",
    });
    expect(new Headers(bankTransactionCall[1]?.headers).get("if-modified-since")).toBe("2026-08-01T00:00:00Z");

    const paymentCall = apiCalls.find(([input]) => requestUrl(input).pathname === "/api.xro/2.0/Payments")!;
    expect(Object.fromEntries(requestUrl(paymentCall[0]).searchParams)).toEqual({
      page: "1",
      pageSize: "250",
      where: "(IsReconciled==true)",
    });

    const batchPaymentCall = apiCalls.find(([input]) => requestUrl(input).pathname === "/api.xro/2.0/BatchPayments")!;
    expect(Object.fromEntries(requestUrl(batchPaymentCall[0]).searchParams)).toEqual({
      where: "(IsReconciled==true)",
    });

    const bankTransferCall = apiCalls.find(([input]) => requestUrl(input).pathname === "/api.xro/2.0/BankTransfers")!;
    expect(Object.fromEntries(requestUrl(bankTransferCall[0]).searchParams)).toEqual({
      where: "(FromIsReconciled==true) AND (ToIsReconciled==false)",
      includeDeleted: "true",
    });
  });

  it("retrieves the Bank Summary report for a requested period", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.hostname === "identity.xero.com") {
        return jsonResponse({ access_token: "report-token", expires_in: 1800, token_type: "Bearer" });
      }
      expect(url.pathname).toBe("/api.xro/2.0/Reports/BankSummary");
      expect(Object.fromEntries(url.searchParams)).toEqual({ fromDate: "2026-08-01", toDate: "2026-08-15" });
      return jsonResponse({ Reports: [{ ReportID: "BankSummary", ReportName: "Bank Summary", Rows: [] }] });
    }) as ProviderFetch;
    const context = createContext(
      {
        clientId: "report-client",
        clientSecret: "secret",
        scopes: "accounting.reports.banksummary.read",
      },
      fetcher,
    );

    const result = await xeroActionHandlers.get_bank_summary!(
      { fromDate: "2026-08-01", toDate: "2026-08-15" },
      context,
    );

    expect(result).toEqual({ report: { ReportID: "BankSummary", ReportName: "Bank Summary", Rows: [] } });
  });

  it("retrieves partner Finance API reconciliation summaries and statement matches", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.hostname === "identity.xero.com") {
        return jsonResponse({ access_token: "finance-token", expires_in: 1800, token_type: "Bearer" });
      }
      if (url.pathname === "/finance.xro/1.0/CashValidation") {
        return jsonResponse([
          {
            accountId: "73151de8-3676-4887-a021-edec960dd537",
            bankStatement: { statementLines: { unreconciledLines: 8, reconciledLines: 3 } },
          },
        ]);
      }
      if (url.pathname === "/finance.xro/1.0/BankStatementsPlus/statements") {
        return jsonResponse({
          bankAccountId: "73151de8-3676-4887-a021-edec960dd537",
          statements: [{ statementId: "7c29eee9-47f0-4179-bd46-9adb4f21cc7f", statementLines: [] }],
        });
      }
      throw new Error(`Unexpected Xero URL: ${url}`);
    }) as ProviderFetch;
    const context = createContext(
      {
        clientId: "finance-client",
        clientSecret: "secret",
        scopes: "finance.cashvalidation.read finance.bankstatementsplus.read",
      },
      fetcher,
    );

    const validation = await xeroActionHandlers.get_cash_validation!(
      { balanceDate: "2026-08-15", asAtSystemDate: "2026-08-14", beginDate: "2026-07-01" },
      context,
    );
    const reconciliation = await xeroActionHandlers.get_bank_statement_reconciliation!(
      {
        bankAccountId: "73151de8-3676-4887-a021-edec960dd537",
        fromDate: "2026-07-01",
        toDate: "2026-08-15",
        summaryOnly: false,
      },
      context,
    );

    expect(validation).toEqual({
      accounts: [
        {
          accountId: "73151de8-3676-4887-a021-edec960dd537",
          bankStatement: { statementLines: { unreconciledLines: 8, reconciledLines: 3 } },
        },
      ],
    });
    expect(reconciliation).toEqual({
      reconciliation: {
        bankAccountId: "73151de8-3676-4887-a021-edec960dd537",
        statements: [{ statementId: "7c29eee9-47f0-4179-bd46-9adb4f21cc7f", statementLines: [] }],
      },
    });

    const apiCalls = vi.mocked(fetcher).mock.calls.filter(([input]) => requestUrl(input).hostname === "api.xero.com");
    expect(requestUrl(apiCalls[0]![0]).toString()).toBe(
      "https://api.xero.com/finance.xro/1.0/CashValidation?balanceDate=2026-08-15&asAtSystemDate=2026-08-14&beginDate=2026-07-01",
    );
    expect(requestUrl(apiCalls[1]![0]).toString()).toBe(
      "https://api.xero.com/finance.xro/1.0/BankStatementsPlus/statements?BankAccountID=73151de8-3676-4887-a021-edec960dd537&FromDate=2026-07-01&ToDate=2026-08-15&SummaryOnly=false",
    );
  });

  it("retrieves JSON from any configured Xero API family with endpoint-specific parameters", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (url.hostname === "identity.xero.com") {
        return jsonResponse({ access_token: "projects-token", expires_in: 1800, token_type: "Bearer" });
      }
      expect(url.toString()).toBe(
        "https://api.xero.com/projects.xro/2.0/Projects?page=2&pageSize=100&states=INPROGRESS",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer projects-token");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("xero-tenant-id")).toBe("95b6ff88-508e-407f-b76a-f7d4db9345bb");
      expect(init?.method).toBe("GET");
      return jsonResponse({ items: [{ projectId: "project-1", name: "Roy Hill" }] });
    }) as ProviderFetch;
    const context = createContext(
      { clientId: "projects-client", clientSecret: "secret", scopes: "projects.read" },
      fetcher,
    );

    const result = await xeroActionHandlers.retrieve_endpoint!(
      {
        api: "projects",
        endpoint: "/Projects",
        query: { page: 2, pageSize: 100, states: "INPROGRESS" },
        tenantId: "95b6ff88-508e-407f-b76a-f7d4db9345bb",
      },
      context,
    );

    expect(result).toMatchObject({
      status: 200,
      data: { items: [{ projectId: "project-1", name: "Roy Hill" }] },
    });
  });

  it("returns binary endpoint content as base64", async () => {
    const bytes = Uint8Array.from([37, 80, 68, 70]);
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.hostname === "identity.xero.com") {
        return jsonResponse({ access_token: "files-token", expires_in: 1800, token_type: "Bearer" });
      }
      expect(url.pathname).toBe("/files.xro/1.0/Files/file-1/Content");
      return new Response(bytes, { headers: { "content-type": "application/pdf" } });
    }) as ProviderFetch;
    const context = createContext({ clientId: "files-client", clientSecret: "secret", scopes: "files.read" }, fetcher);

    const result = await xeroActionHandlers.retrieve_endpoint!(
      {
        api: "files",
        endpoint: "/Files/file-1/Content",
        accept: "application/pdf",
      },
      context,
    );

    expect(result).toMatchObject({
      status: 200,
      bodyEncoding: "base64",
      data: Buffer.from(bytes).toString("base64"),
    });
  });

  it("rejects absolute endpoint URLs before requesting a token", async () => {
    const fetcher = vi.fn() as ProviderFetch;
    const context = createContext(
      { clientId: "guard-client", clientSecret: "secret", scopes: "accounting.settings.read" },
      fetcher,
    );

    await expect(
      xeroActionHandlers.retrieve_endpoint!(
        { api: "accounting", endpoint: "https://example.com/private-data" },
        context,
      ),
    ).rejects.toThrow("endpoint must be a relative path starting with /");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("automatically replaces a rejected access token without user interaction", async () => {
    let tokenNumber = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (url.hostname === "identity.xero.com") {
        tokenNumber += 1;
        return jsonResponse({ access_token: `token-${tokenNumber}`, expires_in: 1800, token_type: "Bearer" });
      }
      if (new Headers(init?.headers).get("authorization") === "Bearer token-1") {
        return jsonResponse({ Message: "Token expired" }, 401);
      }
      return jsonResponse({
        Organisations: [{ OrganisationID: "95b6ff88-508e-407f-b76a-f7d4db9345bb", Name: "Example Pty Ltd" }],
      });
    }) as ProviderFetch;
    const context = createContext(
      { clientId: "retry-client", clientSecret: "secret", scopes: "accounting.settings.read" },
      fetcher,
    );

    const result = await xeroActionHandlers.get_organisation!({}, context);

    expect(result).toEqual({
      organisation: { OrganisationID: "95b6ff88-508e-407f-b76a-f7d4db9345bb", Name: "Example Pty Ltd" },
    });
    expect(tokenNumber).toBe(2);
  });

  it("preserves a non-JSON Xero API error instead of reporting invalid JSON", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.hostname === "identity.xero.com") {
        return jsonResponse({
          access_token: "plain-error-token",
          expires_in: 1800,
          token_type: "Bearer",
          scope: "accounting.invoices.read",
        });
      }
      return new Response("The Xero API is temporarily unavailable", {
        status: 503,
        headers: { "xero-correlation-id": "correlation-503" },
      });
    }) as ProviderFetch;
    const context = createContext(
      { clientId: "plain-error-client", clientSecret: "secret", scopes: "accounting.invoices.read" },
      fetcher,
    );

    await expect(xeroActionHandlers.list_invoices!({ page: 1 }, context)).rejects.toMatchObject({
      status: 503,
      message: "The Xero API is temporarily unavailable",
      details: {
        xeroResponse: "The Xero API is temporarily unavailable",
        requestedScopes: ["accounting.invoices.read"],
        tokenScopes: ["accounting.invoices.read"],
        accessTokenRefreshAttempted: false,
        correlationId: "correlation-503",
      },
    });
  });

  it("reports token scopes after Xero rejects an automatically refreshed token", async () => {
    let tokenNumber = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.hostname === "identity.xero.com") {
        tokenNumber += 1;
        return jsonResponse({
          access_token: `rejected-token-${tokenNumber}`,
          expires_in: 1800,
          token_type: "Bearer",
          scope: "accounting.banktransactions.read",
        });
      }
      return jsonResponse(
        {
          Title: "Unauthorized",
          Status: 401,
          Detail: "AuthorizationUnsuccessful",
          Instance: "xero-instance-401",
        },
        401,
        { "xero-correlation-id": "correlation-401" },
      );
    }) as ProviderFetch;
    const context = createContext(
      {
        clientId: "rejected-token-client",
        clientSecret: "secret",
        scopes: "accounting.banktransactions.read",
      },
      fetcher,
    );

    await expect(xeroActionHandlers.list_bank_transactions!({ page: 1 }, context)).rejects.toMatchObject({
      status: 401,
      message: "Xero rejected the access token after an automatic refresh: AuthorizationUnsuccessful",
      details: {
        xeroResponse: {
          Title: "Unauthorized",
          Status: 401,
          Detail: "AuthorizationUnsuccessful",
          Instance: "xero-instance-401",
        },
        requestedScopes: ["accounting.banktransactions.read"],
        tokenScopes: ["accounting.banktransactions.read"],
        accessTokenRefreshAttempted: true,
        correlationId: "correlation-401",
      },
    });
    expect(tokenNumber).toBe(2);
  });
});

function createContext(values: Record<string, string>, fetcher: ProviderFetch): XeroContext {
  return {
    credential: {
      clientId: values.clientId!,
      clientSecret: values.clientSecret!,
      scopes: values.scopes!.split(" "),
    },
    fetcher,
  };
}

function createXeroFetch(): ProviderFetch {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    if (url.hostname === "identity.xero.com") {
      return jsonResponse({
        access_token: "xero-access-token",
        expires_in: 1800,
        token_type: "Bearer",
      });
    }
    if (url.pathname.endsWith("/Organisation")) {
      return jsonResponse({
        Organisations: [
          {
            OrganisationID: "95b6ff88-508e-407f-b76a-f7d4db9345bb",
            Name: "Example Pty Ltd",
            BaseCurrency: "AUD",
            CountryCode: "AU",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/Invoices")) {
      return jsonResponse({
        Invoices: [{ InvoiceID: "3c9a5d13-e20d-43f1-937d-a2265642eb14", Status: "DRAFT" }],
        pagination: { page: 2, pageSize: 25, pageCount: 1, itemCount: 1 },
      });
    }
    throw new Error(`Unexpected Xero URL: ${url}`);
  }) as ProviderFetch;
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}
