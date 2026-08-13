// Xero Custom Connections: https://developer.xero.com/documentation/guides/oauth2/custom-connections/

import { adminHeaders, fetchJson, runtimeHeaders } from "./client.ts";

const clientId = process.env.XERO_CLIENT_ID;
const clientSecret = process.env.XERO_CLIENT_SECRET;
const scopes = process.env.XERO_SCOPES ?? "accounting.settings.read accounting.contacts accounting.invoices";

if (!clientId || !clientSecret) {
  console.log("Set XERO_CLIENT_ID and XERO_CLIENT_SECRET to run this example.");
  process.exit(0);
}

await fetchJson("http://localhost:3000/api/connections/xero", {
  method: "PUT",
  headers: adminHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({
    authType: "custom_credential",
    values: { clientId, clientSecret, scopes },
  }),
});

const result = await fetchJson("http://localhost:3000/v1/actions/xero.get_organisation", {
  method: "POST",
  headers: runtimeHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ input: {} }),
});

console.log(JSON.stringify(result, null, 2));
