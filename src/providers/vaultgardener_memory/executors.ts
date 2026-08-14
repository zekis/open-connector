import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { VaultGardenerMemoryContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
import {
  createVaultGardenerMemoryContext,
  validateVaultGardenerMemoryCredential,
  vaultGardenerMemoryActionHandlers,
} from "./runtime.ts";

const service = "vaultgardener_memory";

export const executors: ProviderExecutors = defineProviderExecutors<VaultGardenerMemoryContext>({
  service,
  handlers: vaultGardenerMemoryActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<VaultGardenerMemoryContext> {
    const credential = await requireApiKeyCredential(context, service);
    return createVaultGardenerMemoryContext(credential.values, credential.apiKey, fetcher, context.signal);
  },
  fallbackMessage: "VaultGardener memory request failed",
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    });
    return validateVaultGardenerMemoryCredential(input.values, input.apiKey, guardedFetcher, signal);
  },
};
