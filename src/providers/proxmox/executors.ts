import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ProxmoxContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
import { createProxmoxContext, proxmoxHandlers, validateProxmoxCredential } from "./runtime.ts";

export const executors: ProviderExecutors = defineProviderExecutors<ProxmoxContext>({
  service: "proxmox",
  handlers: proxmoxHandlers,
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  async createContext(context, fetcher) {
    const credential = await requireCustomCredential(context, "proxmox");
    return createProxmoxContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "Proxmox request failed",
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    const guardedFetcher = createProviderFetch({ fetch: fetcher, allowPrivateNetwork: isPrivateNetworkAccessAllowed });
    return validateProxmoxCredential(createProxmoxContext(input.values, guardedFetcher, signal));
  },
};
