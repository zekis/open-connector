import type { ProviderDefinition } from "../../core/types.ts";

import { sharePointActions } from "./actions.ts";
import { sharePointOAuthScopes } from "./scopes.ts";

const service = "sharepoint";

/**
 * SharePoint Online provider backed by Microsoft Graph sites, drives, and lists APIs.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "SharePoint",
  description: "Discover SharePoint sites and work with document libraries, files, folders, and list items.",
  categories: ["Storage", "Productivity", "Data"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      scopes: sharePointOAuthScopes,
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
  ],
  homepageUrl: "https://www.microsoft.com/microsoft-365/sharepoint/collaboration",
  actions: sharePointActions,
};
