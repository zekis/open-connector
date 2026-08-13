import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { XeroContext } from "./runtime.ts";

import { createProviderFetch, defineProviderExecutors, requireCustomCredential } from "../provider-runtime.ts";
import { createXeroCredential, validateXeroCredential, xeroActionHandlers } from "./runtime.ts";

const service = "xero";

export const executors: ProviderExecutors = defineProviderExecutors<XeroContext>({
  service,
  handlers: xeroActionHandlers,
  skipDnsValidation: true,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<XeroContext> {
    const stored = await requireCustomCredential(context, service);
    return {
      credential: createXeroCredential(stored.values),
      fetcher,
      signal: context.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const guardedFetcher = createProviderFetch({ fetch: fetcher, skipDnsValidation: true });
    return validateXeroCredential(input.values, guardedFetcher, signal);
  },
};
