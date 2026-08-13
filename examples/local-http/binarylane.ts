// BinaryLane API docs: https://api.binarylane.com.au/reference/

import { adminHeaders, fetchJson, runtimeHeaders } from "./client.ts";

const token = process.env.BINARYLANE_API_TOKEN;
if (!token) {
  console.log("Set BINARYLANE_API_TOKEN to run this example.");
  process.exit(0);
}

await fetchJson("http://localhost:3000/api/connections/binarylane", {
  method: "PUT",
  headers: adminHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ authType: "api_key", values: { apiKey: token } }),
});

const result = await fetchJson("http://localhost:3000/v1/actions/binarylane.list_servers", {
  method: "POST",
  headers: runtimeHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ input: { perPage: 20 } }),
});

console.log(JSON.stringify(result, null, 2));
