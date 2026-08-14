import { adminHeaders, fetchJson, runtimeHeaders } from "./client.ts";

const apiKey = process.env.VAULTGARDENER_MEMORY_TOKEN;
const baseUrl = process.env.VAULTGARDENER_MEMORY_BASE_URL;
if (!apiKey || !baseUrl) {
  console.log("Set VAULTGARDENER_MEMORY_TOKEN and VAULTGARDENER_MEMORY_BASE_URL to run this example.");
  process.exit(0);
}

await fetchJson("http://localhost:3000/api/connections/vaultgardener_memory", {
  method: "PUT",
  headers: adminHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ authType: "api_key", values: { apiKey, baseUrl } }),
});

const result = await fetchJson("http://localhost:3000/v1/actions/vaultgardener_memory.memory_search", {
  method: "POST",
  headers: runtimeHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({
    input: {
      query: "What decisions were made about the active project?",
      session_id: crypto.randomUUID(),
      limit: 5,
    },
  }),
});

console.log(JSON.stringify(result, null, 2));
