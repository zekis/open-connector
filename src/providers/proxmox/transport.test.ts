import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";

import { readFileSync } from "node:fs";
import { createServer, request } from "node:https";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProxmoxContext, proxmoxHandlers, validateProxmoxCredential } from "./runtime.ts";

// Route the screened public test address to a local TLS fixture without external network access.
vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return {
    ...actual,
    request: vi.fn((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const local = new URL(url);
      local.hostname = "127.0.0.1";
      return actual.request(local, options, callback);
    }),
  };
});

// Synthetic, publicly committed test-only certificate and key; never use them for a deployment.
const server = createServer(
  {
    key: readFileSync(new URL("./fixtures/test-server-key.pem", import.meta.url)),
    cert: readFileSync(new URL("./fixtures/test-server-cert.pem", import.meta.url)),
  },
  (req, res) => {
    if (req.url?.endsWith("/status/current")) {
      res.writeHead(700);
      res.end();
      return;
    }
    if (req.url?.endsWith("/status/start")) {
      res.writeHead(307, { location: "https://other.example.com" });
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: req.url === "/api2/json/nodes" ? [] : {} }));
  },
);
let baseUrl: string;
const tlsSettingBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const values = { tokenId: "test@pve!connector", tokenSecret: "test-secret" };

const localFetch: typeof fetch = (input, init) => {
  const local = new URL(input instanceof Request ? input.url : String(input));
  local.hostname = "127.0.0.1";
  return fetch(local, init);
};

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `https://93.184.216.34:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("Proxmox connection TLS exception", () => {
  it("rejects unsupported response statuses without an uncaught exception", async () => {
    const context = createProxmoxContext({ ...values, baseUrl, skipTlsVerification: "true" }, localFetch);
    await expect(proxmoxHandlers.get_vm_status!({ node: "pve1", vmid: 101 }, context)).rejects.toMatchObject({
      status: 502,
    });
  });

  it("reports unsupported TLS exceptions on Workers before sending a request", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    try {
      const context = createProxmoxContext({ ...values, baseUrl, skipTlsVerification: "true" }, localFetch);
      await expect(validateProxmoxCredential(context)).rejects.toThrow("Node.js deployment");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a self-signed server only for opted-in connections, in validation and actions", async () => {
    const normal = createProxmoxContext({ ...values, baseUrl }, localFetch);
    await expect(validateProxmoxCredential(normal)).rejects.toThrow("self-signed certificate");
    const optedIn = createProxmoxContext({ ...values, baseUrl, skipTlsVerification: "true" }, localFetch);
    await expect(validateProxmoxCredential(optedIn)).resolves.toBeDefined();
    await expect(proxmoxHandlers.list_nodes!({}, optedIn)).resolves.toEqual({ nodes: [] });
    expect(request).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ rejectUnauthorized: false, agent: false }),
      expect.any(Function),
    );
    const unchecked = createProxmoxContext({ ...values, baseUrl, skipTlsVerification: "false" }, localFetch);
    await expect(validateProxmoxCredential(unchecked)).rejects.toThrow("self-signed certificate");
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(tlsSettingBefore);
  });

  it("keeps reserved addresses blocked even with both checkboxes selected", () => {
    for (const baseUrl of ["https://127.0.0.1", "https://169.254.169.254"]) {
      expect(() =>
        createProxmoxContext(
          { ...values, baseUrl, allowPrivateNetwork: "true", skipTlsVerification: "true" },
          localFetch,
        ),
      ).toThrow();
    }
  });

  it("does not follow redirects when certificate verification is skipped", async () => {
    const context = createProxmoxContext({ ...values, baseUrl, skipTlsVerification: "true" }, localFetch);
    const before = vi.mocked(request).mock.calls.length;
    await expect(proxmoxHandlers.start_vm!({ node: "pve1", vmid: 101 }, context)).rejects.toThrow("redirected");
    expect(vi.mocked(request).mock.calls.length - before).toBe(1);
  });

  it("cancels opted-in requests with the caller's signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const context = createProxmoxContext(
      { ...values, baseUrl, skipTlsVerification: "true" },
      localFetch,
      controller.signal,
    );
    await expect(validateProxmoxCredential(context)).rejects.toMatchObject({ status: 504 });
  });
});
