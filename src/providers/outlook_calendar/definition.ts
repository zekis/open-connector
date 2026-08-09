import type { ProviderDefinition } from "../../core/types.ts";

import { outlookCalendarActions } from "./actions.ts";
import { outlookCalendarOAuthScopes } from "./scopes.ts";

const service = "outlook_calendar";

/** Outlook Calendar provider backed by Microsoft Graph calendar and event APIs. */
export const provider: ProviderDefinition = {
  service,
  displayName: "Outlook Calendar",
  description: "Read Outlook calendars and events, create or update meetings, and respond to invitations.",
  categories: ["Scheduling", "Productivity", "Communication"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      scopes: outlookCalendarOAuthScopes,
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
  homepageUrl: "https://www.microsoft.com/microsoft-365/outlook/email-and-calendar-software-microsoft-outlook",
  actions: outlookCalendarActions,
};
