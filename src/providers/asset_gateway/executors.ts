import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { AssetGatewayActionContext } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
import { assetGatewayActionHandlers, createAssetGatewayContext, validateAssetGatewayCredential } from "./runtime.ts";

const service = "asset_gateway";

export const executors: ProviderExecutors = defineProviderExecutors<AssetGatewayActionContext>({
  service,
  handlers: assetGatewayActionHandlers,
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<AssetGatewayActionContext> {
    const credential = await requireApiKeyCredential(context, service);
    return createAssetGatewayContext(credential.values, credential.apiKey, fetcher, context.signal);
  },
  fallbackMessage: "Asset Gateway request failed",
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    });
    return validateAssetGatewayCredential(input.values, input.apiKey, guardedFetcher, signal);
  },
};
