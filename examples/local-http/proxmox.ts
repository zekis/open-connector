import { adminHeaders, fetchJson, runtimeHeaders } from "./client.ts";

const baseUrl = process.env.PROXMOX_BASE_URL;
const tokenId = process.env.PROXMOX_TOKEN_ID;
const tokenSecret = process.env.PROXMOX_TOKEN_SECRET;
if (!baseUrl || !tokenId || !tokenSecret) {
  console.log("Skipped: set PROXMOX_BASE_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET to run this example.");
  process.exit(0);
}

// Save the connection, then inspect nodes. This example does not create or start VMs.
await fetchJson("http://localhost:3000/api/connections/proxmox", {
  method: "PUT",
  headers: adminHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ authType: "custom_credential", values: { baseUrl, tokenId, tokenSecret } }),
});
const result = await fetchJson("http://localhost:3000/v1/actions/proxmox.list_nodes", {
  method: "POST",
  headers: runtimeHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({ input: {} }),
});
console.log(JSON.stringify(result, null, 2));
