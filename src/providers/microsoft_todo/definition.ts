import type { ProviderDefinition } from "../../core/types.ts";

import { microsoftTodoActions } from "./actions.ts";
import { microsoftTodoOAuthScopes } from "./scopes.ts";

const service = "microsoft_todo";

/** Microsoft To Do provider backed by Microsoft Graph task-list and task APIs. */
export const provider: ProviderDefinition = {
  service,
  displayName: "Microsoft To Do",
  description: "Read and manage Microsoft To Do task lists and tasks.",
  categories: ["Productivity", "Task Management"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      scopes: microsoftTodoOAuthScopes,
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
            "The Microsoft identity platform tenant segment to use, such as common, organizations, consumers, or a specific tenant ID.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.microsoft.com/microsoft-365/microsoft-to-do-list-app",
  actions: microsoftTodoActions,
};
