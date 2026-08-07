import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { AzureDevOpsActionHandler, AzureDevOpsRuntimeDeps } from "./client.ts";

import { optionalString, requiredString } from "../../core/cast.ts";
import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { azureDevOpsProfileRequest, azureDevOpsJsonRequest, readAzureDevOpsCollection } from "./client.ts";
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
    if (credential?.authType === "oauth2") {
      return {
        authorization: `${credential.tokenType} ${credential.accessToken}`,
        fetcher,
        signal: context.signal,
      };
    }
    if (credential?.authType === "api_key") {
      return {
        authorization: createPatAuthorization(credential.apiKey),
        organization: requiredString(credential.values.organization, "organization"),
        fetcher,
        signal: context.signal,
      };
    }
    throw new ProviderRequestError(
      401,
      "Connect Azure DevOps with Microsoft Entra OAuth or a personal access token first.",
    );
  },
});

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const response = await azureDevOpsProfileRequest<Record<string, unknown>>({
      authorization: `${input.tokenType} ${input.accessToken}`,
      fetcher,
      signal,
    });
    const accountId =
      optionalString(response.body.id) ?? optionalString(response.body.publicAlias) ?? "azure-devops-user";
    return {
      profile: {
        accountId,
        displayName:
          optionalString(response.body.emailAddress) ?? optionalString(response.body.displayName) ?? accountId,
      },
      metadata: {
        currentUser: response.body,
      },
    };
  },

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
