import type { ProviderDefinition } from "../../core/types.ts";

import { azureDevOpsActions } from "./actions.ts";
import { azureDevOpsOAuthScopes } from "./scopes.ts";

const service = "azure_devops";

/**
 * Azure DevOps Services provider backed by the Core, Git, and Work Item Tracking REST APIs.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Azure DevOps",
  description: "Work with Azure DevOps projects, repositories, pull requests, PBIs, bugs, and other work items.",
  categories: ["Developer Tools", "Productivity"],
  authTypes: ["oauth2", "api_key"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      scopes: azureDevOpsOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
      pkce: {
        method: "S256",
      },
      authorizationParams: {
        prompt: "select_account",
        response_mode: "query",
      },
      clientConfigFields: [
        {
          key: "tenant",
          label: "Tenant",
          inputType: "text",
          required: true,
          secret: false,
          defaultValue: "organizations",
          placeholder: "organizations",
          description:
            "The Microsoft identity tenant segment to use, such as organizations or a specific Microsoft Entra tenant ID.",
        },
      ],
    },
    {
      type: "api_key",
      label: "Personal access token",
      placeholder: "Azure DevOps PAT",
      description:
        "Azure DevOps personal access token. Microsoft Entra OAuth is recommended for long-running production integrations.",
      extraFields: [
        {
          key: "organization",
          label: "Organization",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "contoso",
          description: "Azure DevOps organization name from https://dev.azure.com/{organization}.",
        },
      ],
    },
  ],
  homepageUrl: "https://azure.microsoft.com/products/devops",
  actions: azureDevOpsActions,
};
