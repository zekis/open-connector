import type { ProviderDefinition } from "../../core/types.ts";

import { microsoftTeamsActions } from "./actions.ts";
import { microsoftTeamsOAuthScopes } from "./scopes.ts";

const service = "microsoft_teams";

/** Microsoft Teams provider backed by Microsoft Graph team, channel, chat, and message APIs. */
export const provider: ProviderDefinition = {
  service,
  displayName: "Microsoft Teams",
  description: "Read Microsoft Teams conversations and send channel or chat messages.",
  categories: ["Communication", "Collaboration"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      scopes: microsoftTeamsOAuthScopes,
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
          defaultValue: "common",
          placeholder: "common",
          description:
            "The Microsoft identity platform tenant segment to use, such as organizations or a specific tenant ID. Microsoft Teams requires a work or school account.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.microsoft.com/microsoft-teams/",
  actions: microsoftTeamsActions,
};
