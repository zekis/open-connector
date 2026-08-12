import type { ProviderDefinition } from "../../core/types.ts";

import { outlookActions } from "./actions.ts";
import { outlookOAuthScopes } from "./scopes.ts";

const service = "outlook";

/**
 * Outlook provider backed by Microsoft Graph mail APIs.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Outlook",
  categories: ["Communication", "Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      scopes: outlookOAuthScopes,
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
  events: [
    {
      id: "outlook.new_received_email",
      displayName: "New received email",
      description: "Runs when a new message appears in the Outlook inbox.",
      polling: {
        actionId: "outlook.list_messages",
        input: {
          mailFolderId: "inbox",
          top: 50,
          orderby: "receivedDateTime desc",
          select: [
            "id",
            "subject",
            "receivedDateTime",
            "from",
            "sender",
            "toRecipients",
            "bodyPreview",
            "hasAttachments",
            "importance",
            "webLink",
          ],
        },
        result: { kind: "records", collectionField: "messages", idFields: ["id"] },
      },
    },
    {
      id: "outlook.new_sent_email",
      displayName: "New sent email",
      description: "Runs when a new message appears in Outlook Sent Items.",
      polling: {
        actionId: "outlook.list_messages",
        input: {
          mailFolderId: "sentitems",
          top: 50,
          orderby: "sentDateTime desc",
          select: [
            "id",
            "subject",
            "sentDateTime",
            "from",
            "sender",
            "toRecipients",
            "bodyPreview",
            "hasAttachments",
            "importance",
            "webLink",
          ],
        },
        result: { kind: "records", collectionField: "messages", idFields: ["id"] },
      },
    },
  ],
  actions: outlookActions,
};
