import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { binaryLaneActionHandlers, validateBinaryLaneCredential } from "./runtime.ts";

const service = "binarylane";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, binaryLaneActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateBinaryLaneCredential(input.apiKey, fetcher, signal);
  },
};
