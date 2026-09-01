import type { ProviderDefinition } from "../../core/types.ts";

import { microsoftGraphAdminActions } from "./actions.ts";
import { microsoftGraphAdminOAuthScopes } from "./scopes.ts";

const service = "microsoft_graph_admin";

/** Microsoft 365 tenant administration through delegated Microsoft Graph permissions. */
export const provider: ProviderDefinition = {
  service,
  displayName: "Microsoft Graph Admin",
  description: "Manage Microsoft 365 user accounts, subscribed products, and user license assignments.",
  categories: ["Business", "Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      scopes: microsoftGraphAdminOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
      pkce: { method: "S256" },
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
          placeholder: "organizations or tenant ID",
          description:
            "The Microsoft Entra tenant segment to administer. Use organizations or, preferably, the tenant ID for the target Microsoft 365 organization.",
        },
      ],
    },
  ],
  homepageUrl: "https://learn.microsoft.com/en-us/graph/overview",
  actions: microsoftGraphAdminActions,
};
