import type { ProviderDefinition } from "../../core/types.ts";

import { officeCliActions } from "./actions.ts";

const service = "officecli";

export const provider: ProviderDefinition = {
  service,
  displayName: "OfficeCLI",
  description:
    "Create, inspect, edit, validate, and transfer Word, Excel, and PowerPoint files through a self-hosted OfficeCLI API.",
  categories: ["Productivity", "Documents"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Token",
      placeholder: "Enter the OFFICECLI_API_TOKEN value",
      description: "The bearer token configured on the companion OfficeCLI API container.",
      extraFields: [
        {
          key: "baseUrl",
          label: "API URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "http://officecli-api:3030",
          description:
            "The OfficeCLI API origin. Private Docker or LAN addresses require OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK on the Open Connector runtime.",
        },
      ],
    },
  ],
  homepageUrl: "https://github.com/iOfficeAI/OfficeCLI",
  actions: officeCliActions,
};
