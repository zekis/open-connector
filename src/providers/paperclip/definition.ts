import type { ProviderDefinition } from "../../core/types.ts";

import { paperclipActions } from "./actions.ts";

const service = "paperclip";

export const provider: ProviderDefinition = {
  service,
  displayName: "Paperclip",
  description:
    "Manage Paperclip companies, projects, agents, issues, skills, routines, and secrets as a signed-in board user.",
  categories: ["Productivity", "Developer Tools"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "baseUrl",
          label: "Instance URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://paperclip.example.com",
          description:
            "The HTTP or HTTPS URL of the Paperclip instance, without an /api path. Private or overlay-network instances require OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK on a self-hosted Open Connector runtime.",
        },
        {
          key: "email",
          label: "Email",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "board-user@example.com",
          description: "The email address of a Paperclip board user.",
        },
        {
          key: "password",
          label: "Password",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "Enter the board-user password",
          description:
            "The Paperclip board-user password. Open Connector signs in through Paperclip's email authentication endpoint and uses the resulting session only for the current action.",
        },
      ],
      testAction: {
        actionName: "get_session",
        input: {},
      },
    },
  ],
  homepageUrl: "https://github.com/paperclipai/paperclip",
  actions: paperclipActions,
};
