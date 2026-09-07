import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { OfficeCliActionContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
import { createOfficeCliContext, officeCliActionHandlers, validateOfficeCliCredential } from "./runtime.ts";

const service = "officecli";

export const executors: ProviderExecutors = defineProviderExecutors<OfficeCliActionContext>({
  service,
  handlers: officeCliActionHandlers,
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<OfficeCliActionContext> {
    const credential = await requireApiKeyCredential(context, service);
    return createOfficeCliContext(credential.values, credential.apiKey, fetcher, context.signal, context.transitFiles);
  },
  fallbackMessage: "OfficeCLI request failed",
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    });
    return validateOfficeCliCredential(input.values, input.apiKey, guardedFetcher, signal);
  },
};
