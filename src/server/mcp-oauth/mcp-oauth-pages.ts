import type { McpOAuthAuthorizationRequest } from "./mcp-oauth-service.ts";

import { escapeHtml } from "../api/http-utils.ts";

export interface McpOAuthAuthorizationPageOptions {
  request: McpOAuthAuthorizationRequest;
  authorizeUrl: URL;
}

export interface McpOAuthUnlockPageOptions {
  authorizeUrl: URL;
  invalidCredential?: boolean;
}

export function renderMcpOAuthAuthorizationPage(options: McpOAuthAuthorizationPageOptions): string {
  const request = options.request;
  return page(
    "Connect ChatGPT",
    `
      <div class="brand">Open Connector</div>
      <h1>Connect ${escapeHtml(request.client.name)}</h1>
      <p>ChatGPT is requesting access to your Open Connector MCP tools.</p>
      <div class="details">
        <div><span>Resource</span><strong>${escapeHtml(request.resource)}</strong></div>
        <div><span>Permission</span><strong>Use connected accounts and approved actions</strong></div>
        <div><span>Scope</span><strong>${escapeHtml(request.scopes.join(" "))}</strong></div>
      </div>
      <p class="note">Open Connector will continue to enforce your runtime policy, connection permissions, and action approvals.</p>
      <form method="post" action="/oauth/authorize">
        ${authorizationFields(options.authorizeUrl)}
        <div class="actions">
          <button class="secondary" type="submit" name="decision" value="deny">Cancel</button>
          <button type="submit" name="decision" value="approve">Allow access</button>
        </div>
      </form>
    `,
  );
}

export function renderMcpOAuthUnlockPage(options: McpOAuthUnlockPageOptions): string {
  return page(
    "Unlock Open Connector",
    `
      <div class="brand">Open Connector</div>
      <h1>Unlock to continue</h1>
      <p>Enter your Open Connector admin token. It is sent only to this server over HTTPS and is not saved by ChatGPT.</p>
      ${options.invalidCredential ? '<p class="error" role="alert">That admin token was not accepted.</p>' : ""}
      <form method="post" action="/oauth/authorize/login">
        <input type="hidden" name="return_to" value="${escapeHtml(relativeAuthorizationUrl(options.authorizeUrl))}">
        <label for="admin_token">Admin token</label>
        <input id="admin_token" name="admin_token" type="password" autocomplete="current-password" required autofocus>
        <div class="actions single">
          <button type="submit">Continue</button>
        </div>
      </form>
    `,
  );
}

export function renderMcpOAuthErrorPage(message: string): string {
  return page(
    "OAuth request failed",
    `
      <div class="brand">Open Connector</div>
      <h1>Connection failed</h1>
      <p class="error" role="alert">${escapeHtml(message)}</p>
      <p class="note">Return to ChatGPT and try creating the connection again.</p>
    `,
  );
}

function authorizationFields(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n");
}

function relativeAuthorizationUrl(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0d0f12; color: #f5f7fb; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #18233a 0, #0d0f12 48%); }
      main { width: min(100%, 520px); padding: 30px; border: 1px solid #303641; border-radius: 18px; background: rgba(20, 23, 29, .96); box-shadow: 0 24px 70px rgba(0, 0, 0, .35); }
      .brand { color: #78a6ff; font-size: 14px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
      h1 { margin: 10px 0 12px; font-size: 28px; line-height: 1.2; }
      p { color: #c2c8d3; line-height: 1.55; }
      .details { margin: 22px 0; border: 1px solid #323946; border-radius: 12px; overflow: hidden; }
      .details div { display: grid; gap: 6px; padding: 14px 16px; border-bottom: 1px solid #323946; }
      .details div:last-child { border-bottom: 0; }
      .details span, label { color: #929bab; font-size: 13px; }
      .details strong { overflow-wrap: anywhere; font-size: 14px; }
      .note { font-size: 13px; }
      .error { padding: 12px 14px; border: 1px solid #813d48; border-radius: 10px; background: #351b21; color: #ffb8c1; }
      label { display: block; margin: 22px 0 8px; font-weight: 600; }
      input[type=password] { width: 100%; min-height: 46px; padding: 10px 12px; border: 1px solid #3b4453; border-radius: 10px; background: #0e1117; color: inherit; font: inherit; }
      input[type=password]:focus { outline: 2px solid #75a7ff; outline-offset: 2px; }
      .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
      .actions.single button { width: 100%; }
      button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 10px; background: #3978e8; color: white; font: inherit; font-weight: 700; cursor: pointer; }
      button:hover { background: #4a88f5; }
      button.secondary { border: 1px solid #3b4453; background: transparent; color: #d5dae3; }
      @media (max-width: 520px) { main { padding: 22px; } h1 { font-size: 24px; } .actions { flex-direction: column-reverse; } button { width: 100%; } }
    </style>
  </head>
  <body><main>${body}</main></body>
</html>`;
}
