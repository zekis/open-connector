import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { ObsidianActionContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
import { createObsidianContext, obsidianActionHandlers, validateObsidianCredential } from "./runtime.ts";

const service = "obsidian";

export const executors: ProviderExecutors = defineProviderExecutors<ObsidianActionContext>({
  service,
  handlers: obsidianActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<ObsidianActionContext> {
    const credential = await requireApiKeyCredential(context, service);
    return createObsidianContext(credential.values, credential.apiKey, fetcher, context.signal);
  },
  fallbackMessage: "Obsidian request failed",
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    });
    return validateObsidianCredential(input.values, input.apiKey, guardedFetcher, signal);
  },
};
