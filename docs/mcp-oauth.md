# ChatGPT MCP OAuth

Open Connector can expose its MCP server to ChatGPT through OAuth 2.1 while preserving existing bearer-token access for Codex and other runtime clients.

OAuth is enabled when both of these deployment values are configured:

```bash
OOMOL_CONNECT_ORIGIN="https://connect.example.com"
OOMOL_CONNECT_ADMIN_TOKEN="use-a-secret-from-your-deployment-platform"
```

Keep the admin token in the deployment environment or secret manager. Do not commit it. The public origin must be the externally reachable HTTPS origin without a path or trailing slash.

## ChatGPT connection values

In ChatGPT developer mode, create an MCP connection with:

- Name: `Open Connector`
- Description: `Use approved Open Connector accounts and actions.`
- MCP server URL: `https://connect.example.com/mcp`
- Authentication: `OAuth`
- Client registration: `Dynamic` or `Automatic`

No Client ID or client secret is required. Open Connector publishes a Dynamic Client Registration endpoint and accepts ChatGPT's public OAuth client with PKCE. During linking, Open Connector asks for the existing admin token, then shows a consent page. The admin token is submitted only to Open Connector and is not returned to ChatGPT.

Existing configured bearer tokens and persistent `oct_…` runtime tokens remain valid on `/mcp`. OAuth-issued tokens are audience-bound to the MCP URL and cannot be used on `/v1` routes.

## Discovery endpoints

For an MCP URL of `https://connect.example.com/mcp`, Open Connector publishes:

- Protected resource metadata: `https://connect.example.com/.well-known/oauth-protected-resource/mcp`
- Compatibility protected resource metadata: `https://connect.example.com/.well-known/oauth-protected-resource`
- Authorization server metadata: `https://connect.example.com/.well-known/oauth-authorization-server`
- Authorization endpoint: `https://connect.example.com/oauth/authorize`
- Token endpoint: `https://connect.example.com/oauth/token`
- Dynamic client registration: `https://connect.example.com/oauth/register`

The authorization-code flow requires `S256` PKCE and carries the exact MCP URL through the `resource` parameter. Access tokens last one hour. Refresh tokens rotate on every use and last 90 days.

Open Connector accepts ChatGPT's stable redirect URL and its callback-specific redirect URLs. Dynamic registration records the exact URL supplied by ChatGPT, so no redirect allowlist or manually registered OAuth client is required.

If a ChatGPT form still requires a redirect URL, use:

```text
https://chatgpt.com/connector_platform_oauth_redirect
```

## Verification

Check discovery and the unauthenticated challenge before linking ChatGPT:

```bash
curl https://connect.example.com/.well-known/oauth-protected-resource/mcp
curl https://connect.example.com/.well-known/oauth-authorization-server
curl -i -X POST https://connect.example.com/mcp
```

The MCP request should return `401 Unauthorized` with a `WWW-Authenticate` header whose `resource_metadata` value points to the protected-resource metadata endpoint. Use MCP Inspector or ChatGPT developer mode to exercise registration, admin consent, PKCE exchange, refresh, MCP initialization, tool listing, and a representative tool call.
