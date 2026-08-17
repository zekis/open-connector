import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { StackOverflowRuntimeContext } from "./runtime.ts";

import { requiredString } from "../../core/cast.ts";
import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { stackOverflowActionHandlers, validateStackOverflowCredential } from "./runtime.ts";

const service = "stack_overflow";

export const executors: ProviderExecutors = defineProviderExecutors<StackOverflowRuntimeContext>({
  service,
  handlers: stackOverflowActionHandlers,
  skipDnsValidation: true,
  async createContext(context: ExecutionContext, fetcher): Promise<StackOverflowRuntimeContext> {
    const credential = await context.getCredential(service);
    if (credential?.authType !== "api_key") {
      throw new ProviderRequestError(401, "Configure a Stack Overflow Internal personal access token first.");
    }
    return {
      personalAccessToken: credential.apiKey,
      team: requiredString(credential.values.team, "team"),
      fetcher,
      signal: context.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    const team = requiredString(input.values.team, "team");
    return validateStackOverflowCredential(input.apiKey, team, fetcher, signal);
  },
};
