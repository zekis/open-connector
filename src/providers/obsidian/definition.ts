import type { ProviderDefinition } from "../../core/types.ts";

import { obsidianActions } from "./actions.ts";

const service = "obsidian";

export const provider: ProviderDefinition = {
  service,
  displayName: "Obsidian",
  description: "List, search, read, and write notes through a self-hosted Obsidian REST server.",
  categories: ["Productivity", "Storage"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Key",
      placeholder: "Enter the REST and MCP server API key",
      description:
        "Bearer token configured by the Obsidian REST and MCP server community plugin. Treat this token as full vault access.",
      extraFields: [
        {
          key: "baseUrl",
          label: "Server URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "http://100.x.x.x:27124",
          description:
            "Root URL of the Obsidian REST and MCP server. Public addresses work by default; private or overlay-network targets such as Tailscale require OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK on the self-hosted connector. Loopback, reserved, and cloud-metadata targets remain blocked.",
        },
        {
          key: "vault",
          label: "Vault Name",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "Projects",
          description:
            "Optional Obsidian vault name. Leave blank to use the default vault configured in the REST and MCP server plugin.",
        },
      ],
    },
  ],
  homepageUrl: "https://github.com/dsebastien/obsidian-cli-rest",
  events: [
    {
      id: "obsidian.file_created",
      displayName: "File created",
      description: "Runs when a new file appears in the Obsidian vault.",
      polling: {
        actionId: "obsidian.list_files",
        input: {},
        result: { kind: "strings", collectionField: "files", payloadField: "path" },
      },
    },
  ],
  actions: obsidianActions,
};
