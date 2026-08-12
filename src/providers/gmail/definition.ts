import type { ProviderDefinition } from "../../core/types.ts";

import { gmailActions } from "./actions.ts";
import { gmailOAuthScopes } from "./scopes.ts";

const service = "gmail";

/**
 * Gmail provider backed by the Gmail API and user-provided Google OAuth app.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Gmail",
  categories: ["Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: gmailOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
      authorizationParams: {
        access_type: "offline",
        prompt: "consent",
      },
    },
  ],
  homepageUrl: "https://mail.google.com",
  events: [
    {
      id: "gmail.new_received_email",
      displayName: "New received email",
      description: "Runs when a new message appears in the Gmail inbox.",
      polling: {
        actionId: "gmail.fetch_emails",
        input: { maxResults: 50, detail: "summary", query: "in:inbox" },
        result: { kind: "records", collectionField: "messages", idFields: ["messageId", "id"] },
      },
    },
    {
      id: "gmail.new_sent_email",
      displayName: "New sent email",
      description: "Runs when a new message appears in Gmail Sent Mail.",
      polling: {
        actionId: "gmail.fetch_emails",
        input: { maxResults: 50, detail: "summary", query: "in:sent" },
        result: { kind: "records", collectionField: "messages", idFields: ["messageId", "id"] },
      },
    },
  ],
  actions: gmailActions,
};
