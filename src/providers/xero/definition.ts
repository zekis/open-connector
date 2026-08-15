import type { ProviderDefinition } from "../../core/types.ts";

import { xeroActions } from "./actions.ts";
import { xeroDefaultCustomConnectionScopes } from "./scopes.ts";

const service = "xero";

/** Xero provider authenticated through a single-organisation Custom Connection. */
export const provider: ProviderDefinition = {
  service,
  displayName: "Xero",
  description:
    "Connect one Xero organisation through a Custom Connection and retrieve data across Xero's Accounting, Assets, Files, Projects, Payroll, and approved partner APIs.",
  categories: ["Finance", "Productivity"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "clientId",
          label: "Client ID",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "Xero Custom Connection client ID",
          description: "Client ID from the authorised Custom Connection in Xero My Apps.",
        },
        {
          key: "clientSecret",
          label: "Client secret",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "Xero Custom Connection client secret",
          description:
            "Client secret generated for the Custom Connection. Open Connector exchanges it for short-lived access tokens automatically.",
        },
        {
          key: "scopes",
          label: "Scopes",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: xeroDefaultCustomConnectionScopes.join(" "),
          description:
            "Space-separated scopes selected on the Custom Connection in Xero My Apps. Enter the matching granular read scopes for every API family and endpoint you want to retrieve. Defaults to accounting settings, contacts, and invoices; keep accounting.settings.read so the connection can identify its organisation.",
        },
      ],
      testAction: {
        actionName: "get_organisation",
        input: {},
      },
    },
  ],
  homepageUrl: "https://www.xero.com/",
  events: [
    {
      id: "xero.new_contact",
      displayName: "New contact",
      description: "Runs when a new contact appears in the connected Xero organisation.",
      polling: {
        actionId: "xero.list_contacts",
        input: { page: 1, pageSize: 100, summaryOnly: true, orderBy: "UpdatedDateUTC DESC" },
        result: { kind: "records", collectionField: "contacts", idFields: ["ContactID"] },
      },
    },
    {
      id: "xero.new_invoice",
      displayName: "New invoice or bill",
      description: "Runs when a new sales invoice or purchase bill appears in the connected Xero organisation.",
      polling: {
        actionId: "xero.list_invoices",
        input: { page: 1, pageSize: 100, summaryOnly: true, orderBy: "UpdatedDateUTC DESC" },
        result: { kind: "records", collectionField: "invoices", idFields: ["InvoiceID"] },
      },
    },
  ],
  actions: xeroActions,
};
