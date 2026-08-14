import type { ProviderDefinition } from "../../core/types.ts";

import { vaultGardenerMemoryActions } from "./actions.ts";

const service = "vaultgardener_memory";

export const provider: ProviderDefinition = {
  service,
  displayName: "VaultGardener Memory",
  description:
    "Search, read, capture, and reinforce personal knowledge through a VaultGardener memory service while preserving reflex context beside source evidence.",
  categories: ["AI", "Productivity", "Storage"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Memory Token",
      placeholder: "Enter the VaultGardener bearer token",
      description:
        "Bearer token issued by the VaultGardener memory-system owner. Treat this token as access to personal knowledge and never place it in prompts or notes.",
      extraFields: [
        {
          key: "baseUrl",
          label: "Memory REST Base URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://memory.example.com/memory",
          description:
            "Complete REST base URL for the VaultGardener service. Change this value if the service moves; do not include /mcp or a /v1 operation path. Private or overlay-network targets such as Tailscale require OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK on the self-hosted connector. Loopback, reserved, and cloud-metadata targets remain blocked.",
        },
      ],
    },
  ],
  actions: vaultGardenerMemoryActions,
};
