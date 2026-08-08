import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { AzureDevOpsActionHandler, AzureDevOpsRuntimeDeps } from "./client.ts";

import { requiredString } from "../../core/cast.ts";
import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { azureDevOpsJsonRequest, readAzureDevOpsCollection } from "./client.ts";
import { azureDevOpsGitActionHandlers } from "./git-actions.ts";
import { azureDevOpsProjectActionHandlers } from "./project-actions.ts";
import { azureDevOpsWorkItemActionHandlers } from "./work-item-actions.ts";

const service = "azure_devops";

export const azureDevOpsActionHandlers: Record<string, AzureDevOpsActionHandler> = {
  ...azureDevOpsProjectActionHandlers,
  ...azureDevOpsGitActionHandlers,
  ...azureDevOpsWorkItemActionHandlers,
};

export const executors: ProviderExecutors = defineProviderExecutors<AzureDevOpsRuntimeDeps>({
  service,
  handlers: azureDevOpsActionHandlers,
  skipDnsValidation: true,
  async createContext(context: ExecutionContext, fetcher): Promise<AzureDevOpsRuntimeDeps> {
    const credential = await context.getCredential(service);
    if (credential?.authType !== "api_key") {
      throw new ProviderRequestError(401, "Configure a personal access token for this provider first.");
    }
    return {
      authorization: createPatAuthorization(credential.apiKey),
      organization: requiredString(credential.values.organization, "organization"),
      fetcher,
      signal: context.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const organization = requiredString(input.values.organization, "organization");
    const response = await azureDevOpsJsonRequest<unknown>(
      organization,
      "_apis/projects",
      {
        authorization: createPatAuthorization(input.apiKey),
        organization,
        fetcher,
        signal,
      },
      { query: { $top: 1 } },
    );
    readAzureDevOpsCollection(response.body, "Azure DevOps projects");
    return {
      profile: {
        accountId: `azure-devops:${organization.toLowerCase()}`,
        displayName: organization,
      },
      metadata: { organization },
    };
  },
};

function createPatAuthorization(personalAccessToken: string): string {
  return `Basic ${btoa(`:${personalAccessToken}`)}`;
}
