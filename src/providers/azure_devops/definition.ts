import type { ProviderDefinition } from "../../core/types.ts";

import { azureDevOpsActions } from "./actions.ts";

const service = "azure_devops";

/**
 * PAT-authenticated Azure DevOps Services provider backed by the Core, Git, and Work Item Tracking REST APIs.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Azure DevOps",
  description:
    "Work with Azure DevOps projects, repository source code, branches, pull requests, PBIs, bugs, and other work items.",
  categories: ["Developer Tools", "Productivity"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Personal access token",
      placeholder: "Azure DevOps PAT",
      description:
        "Azure DevOps personal access token used with HTTP Basic authentication. Grant only the Code, Project and Team, and Work Items scopes needed by the enabled actions.",
      extraFields: [
        {
          key: "organization",
          label: "Organization",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "contoso",
          description: "Azure DevOps organization name from https://dev.azure.com/{organization}.",
        },
      ],
    },
  ],
  homepageUrl: "https://azure.microsoft.com/products/devops",
  actions: azureDevOpsActions,
};
