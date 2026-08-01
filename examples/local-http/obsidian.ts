// Obsidian REST and MCP server plugin: https://github.com/dsebastien/obsidian-cli-rest

import { adminHeaders, fetchJson, runtimeHeaders } from "./client.ts";

const apiKey = process.env.OBSIDIAN_API_KEY;
const baseUrl = process.env.OBSIDIAN_BASE_URL;
if (!apiKey || !baseUrl) {
  console.log("Set OBSIDIAN_API_KEY and OBSIDIAN_BASE_URL to run this example.");
  process.exit(0);
}

const values: Record<string, string> = { apiKey, baseUrl };
if (process.env.OBSIDIAN_VAULT) values.vault = process.env.OBSIDIAN_VAULT;

await fetchJson("http://localhost:3000/api/connections/obsidian", {
  method: "PUT",
  headers: adminHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ authType: "api_key", values }),
});

const result = await fetchJson("http://localhost:3000/v1/actions/obsidian.list_files", {
  method: "POST",
  headers: runtimeHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ input: { extension: "md" } }),
});

console.log(JSON.stringify(result, null, 2));
