import type { ProviderDefinition } from "../../core/types.ts";

import { binaryLaneActions } from "./actions.ts";

const service = "binarylane";

export const provider: ProviderDefinition = {
  service,
  displayName: "BinaryLane",
  description: "Manage BinaryLane cloud servers, lifecycle actions, regions, and available sizes.",
  categories: ["Developer Tools"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Nova API Key",
      placeholder: "BinaryLane API token",
      description:
        "BinaryLane Nova API key sent as a Bearer token. Create one under Account > Security > Nova API Key in mPanel: https://support.binarylane.com.au/support/solutions/articles/11000125203-getting-started-with-binarylane-api",
      extraFields: [],
    },
  ],
  homepageUrl: "https://www.binarylane.com.au/",
  actions: binaryLaneActions,
};
