import type { ProviderDefinition } from "../../core/types.ts";

import { everythingActions } from "./actions.ts";

const service = "everything";

export const provider: ProviderDefinition = {
  service,
  displayName: "Everything",
  description:
    "Search and download indexed files from a Windows computer running the voidtools Everything HTTP Server. Access covers every file exposed by that server's index.",
  categories: ["Productivity", "Documents"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "baseUrl",
          label: "HTTP Server URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "http://100.64.0.10:8686",
          description:
            "The Everything HTTP Server origin, including its port. Private LAN and Tailscale addresses require OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK on the self-hosted Open Connector runtime. Use HTTPS or an encrypted private network because Everything uses HTTP Basic authentication.",
        },
        {
          key: "username",
          label: "Username",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "Everything HTTP username",
          description:
            "The username configured under Everything > Options > HTTP Server. Leave blank only if authentication is disabled.",
        },
        {
          key: "password",
          label: "Password",
          inputType: "password",
          required: false,
          secret: true,
          placeholder: "Everything HTTP password",
          description:
            "The password configured under Everything > Options > HTTP Server. Leave blank only if authentication is disabled. Every indexed file is visible to a valid connection, so restrict the Everything index to intended locations.",
        },
      ],
      testAction: {
        actionName: "search_files",
        input: { query: "*", count: 1 },
      },
    },
  ],
  homepageUrl: "https://www.voidtools.com/support/everything/http/",
  actions: everythingActions,
};
