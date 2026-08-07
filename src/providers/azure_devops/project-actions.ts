import type { AzureDevOpsActionHandler } from "./client.ts";

import { optionalInteger, optionalString } from "../../core/cast.ts";
import { azureDevOpsJsonRequest, readAzureDevOpsCollection, resolveAzureDevOpsOrganization } from "./client.ts";

export const azureDevOpsProjectActionHandlers: Record<string, AzureDevOpsActionHandler> = {
  async list_projects(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const response = await azureDevOpsJsonRequest<unknown>(organization, "_apis/projects", deps, {
      query: {
        $top: optionalInteger(input.top),
        continuationToken: optionalString(input.cursor),
      },
    });
    return {
      projects: readAzureDevOpsCollection(response.body, "Azure DevOps projects"),
      nextCursor: response.continuationToken,
    };
  },
};
