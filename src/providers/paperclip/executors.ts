import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { PaperclipActionContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
import { createPaperclipContext, paperclipActionHandlers, validatePaperclipCredential } from "./runtime.ts";

const service = "paperclip";

export const executors: ProviderExecutors = defineProviderExecutors<PaperclipActionContext>({
  service,
  handlers: paperclipActionHandlers,
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<PaperclipActionContext> {
    const credential = await requireCustomCredential(context, service);
    return createPaperclipContext(credential.values, fetcher, context.signal);
  },
  fallbackMessage: "Paperclip request failed",
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    });
    return validatePaperclipCredential(input.values, guardedFetcher, signal);
  },
};
