import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { EverythingActionContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
import { createEverythingContext, everythingActionHandlers, validateEverythingCredential } from "./runtime.ts";

const service = "everything";

export const executors: ProviderExecutors = defineProviderExecutors<EverythingActionContext>({
  service,
  handlers: everythingActionHandlers,
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<EverythingActionContext> {
    const credential = await requireCustomCredential(context, service);
    return createEverythingContext(credential.values, fetcher, context.signal, context.transitFiles);
  },
  fallbackMessage: "Everything HTTP Server request failed",
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const guardedFetcher = createProviderFetch({ fetch: fetcher, allowPrivateNetwork: isPrivateNetworkAccessAllowed });
    return validateEverythingCredential(input.values, guardedFetcher, signal);
  },
};
