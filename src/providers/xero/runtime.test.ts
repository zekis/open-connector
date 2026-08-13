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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
