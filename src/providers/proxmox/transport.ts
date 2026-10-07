import { createProviderFetch, ProviderRequestError } from "../provider-runtime.ts";

interface ProxmoxFetchOptions {
  fetcher: typeof fetch;
  allowPrivateNetwork: boolean;
  skipTlsVerification: boolean;
}

/** Keep a connection's optional TLS exception inside the normal SSRF guard. */
export function createProxmoxFetch(options: ProxmoxFetchOptions): typeof fetch {
  return createProviderFetch({
    fetch: options.skipTlsVerification ? fetchWithoutTlsVerification : options.fetcher,
    allowPrivateNetwork: () => options.allowPrivateNetwork,
  });
}

// This transport is private to the guarded factory above. It never follows redirects.
async function fetchWithoutTlsVerification(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof navigator === "object" && navigator.userAgent === "Cloudflare-Workers") {
    throw new ProviderRequestError(400, "Skipping TLS verification requires a Node.js deployment of Open Connector.");
  }
  // Load Node's transport only when a connection explicitly enables the TLS exception.
  const [{ request: httpsRequest }, { Readable }] = await Promise.all([import("node:https"), import("node:stream")]);
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "https:") throw new ProviderRequestError(400, "The TLS exception transport requires HTTPS");
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpsRequest(
      url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
        rejectUnauthorized: false,
        // No shared agent or TLS sessions can carry this setting to other connections.
        agent: false,
      },
      (incoming) => {
        try {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          }
          const status = incoming.statusCode ?? 502;
          const noBody = request.method === "HEAD" || [204, 205, 304].includes(status);
          if (noBody) incoming.resume();
          resolve(
            new Response(noBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, headers }),
          );
        } catch (error) {
          incoming.destroy();
          reject(new TypeError("fetch failed", { cause: error }));
        }
      },
    );
    outgoing.on("error", (error) =>
      reject(request.signal.aborted ? request.signal.reason : new TypeError("fetch failed", { cause: error })),
    );
    outgoing.end(body);
  });
}
