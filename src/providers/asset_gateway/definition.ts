import type { ProviderDefinition } from "../../core/types.ts";

import { assetGatewayActions } from "./actions.ts";

const service = "asset_gateway";

export const provider: ProviderDefinition = {
  service,
  displayName: "Asset Gateway",
  description:
    "Manage asset requests, support tickets, device inventory, agent telemetry, and check-in history through a Device Portal management API.",
  categories: ["Productivity", "Infrastructure"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Management token",
      placeholder: "dp_...",
      description:
        "A Device Portal management token. Use a read-and-write token for create, update, and comment actions.",
      extraFields: [
        {
          key: "baseUrl",
          label: "Management API URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://assets.example.com/api/v1",
          description:
            "The portal root URL or its /api/v1 management API URL. Private or overlay-network portals require OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK on a self-hosted Open Connector runtime.",
        },
      ],
    },
  ],
  actions: assetGatewayActions,
};
