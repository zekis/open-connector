import type { ProviderDefinition } from "../../core/types.ts";

import { proxmoxActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "proxmox",
  displayName: "Proxmox VE",
  description: "Discover cluster resources and provision QEMU virtual machines on Proxmox VE.",
  categories: ["Infrastructure", "Developer Tools"],
  homepageUrl: "https://www.proxmox.com/en/proxmox-virtual-environment/overview",
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "baseUrl",
          label: "Cluster URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://pve.example.com:8006",
          description:
            "HTTP or HTTPS address of a cluster node or reverse proxy. For Tailscale or LAN addresses, enable private network access below. HTTPS connections require a trusted TLS certificate.",
        },
        {
          key: "allowPrivateNetwork",
          label: "Allow private network access (Tailscale / LAN)",
          inputType: "checkbox",
          required: false,
          secret: false,
          description:
            "Allow this connection to reach private addresses. Open Connector must be able to reach your cluster over that network.",
        },
        {
          key: "tokenId",
          label: "API token ID",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "automation@pve!connector",
          description:
            "Full token ID from Datacenter > Permissions > API Tokens. Grant the user and token the permissions needed on the intended VMs, storage, and networks.",
        },
        {
          key: "tokenSecret",
          label: "API token secret",
          inputType: "password",
          required: true,
          secret: true,
          description:
            "Secret shown when the API token is created. See https://pve.proxmox.com/pve-docs/pveum-plain.html#pveum_tokens.",
        },
      ],
    },
  ],
  actions: proxmoxActions,
};
