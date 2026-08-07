import type { AzureDevOpsActionHandler } from "./client.ts";

import {
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requiredString,
} from "../../core/cast.ts";
import { encodePathSegment } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";
import {
  azureDevOpsJsonRequest,
  azureDevOpsProjectPath,
  readAzureDevOpsCollection,
  resolveAzureDevOpsOrganization,
} from "./client.ts";

export const azureDevOpsGitActionHandlers: Record<string, AzureDevOpsActionHandler> = {
  async list_repositories(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const path = azureDevOpsProjectPath(optionalString(input.project), "_apis/git/repositories");
    const response = await azureDevOpsJsonRequest<unknown>(organization, path, deps, {
      query: {
        includeHidden: optionalBoolean(input.includeHidden),
      },
    });
    return {
      repositories: readAzureDevOpsCollection(response.body, "Azure DevOps repositories"),
    };
  },

  async list_pull_requests(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const repository = optionalString(input.repository);
    const path = repository
      ? azureDevOpsProjectPath(project, `_apis/git/repositories/${encodePathSegment(repository)}/pullrequests`)
      : azureDevOpsProjectPath(project, "_apis/git/pullrequests");
    const top = optionalInteger(input.top) ?? 100;
    const skip = parseCursor(input.cursor);
    const response = await azureDevOpsJsonRequest<unknown>(organization, path, deps, {
      query: {
        "searchCriteria.status": optionalString(input.status) ?? "active",
        "searchCriteria.sourceRefName": normalizeOptionalRef(input.sourceRefName),
        "searchCriteria.targetRefName": normalizeOptionalRef(input.targetRefName),
        "searchCriteria.creatorId": optionalString(input.creatorId),
        "searchCriteria.reviewerId": optionalString(input.reviewerId),
        $top: top,
        $skip: skip,
      },
    });
    const pullRequests = readAzureDevOpsCollection(response.body, "Azure DevOps pull requests");
    return {
      pullRequests,
      nextCursor: pullRequests.length === top ? String(skip + pullRequests.length) : null,
    };
  },

  async create_pull_request(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const repository = requiredString(input.repository, "repository");
    const response = await azureDevOpsJsonRequest<Record<string, unknown>>(
      organization,
      azureDevOpsProjectPath(project, `_apis/git/repositories/${encodePathSegment(repository)}/pullrequests`),
      deps,
      {
        method: "POST",
        body: {
          sourceRefName: normalizeRef(requiredString(input.sourceRefName, "sourceRefName")),
          targetRefName: normalizeRef(requiredString(input.targetRefName, "targetRefName")),
          title: requiredString(input.title, "title"),
          description: optionalString(input.description),
          isDraft: optionalBoolean(input.isDraft),
          reviewers: optionalStringArray(input.reviewerIds)?.map((id) => ({ id })),
          workItemRefs: optionalStringArray(input.workItemIds)?.map((id) => ({ id })),
        },
      },
    );
    return { pullRequest: response.body };
  },
};

function normalizeOptionalRef(value: unknown): string | undefined {
  const ref = optionalString(value);
  return ref ? normalizeRef(ref) : undefined;
}

function normalizeRef(value: string): string {
  return value.startsWith("refs/") ? value : `refs/heads/${value}`;
}

function parseCursor(value: unknown): number {
  const cursor = optionalString(value);
  if (!cursor) {
    return 0;
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProviderRequestError(400, "cursor must be a non-negative integer string.");
  }
  return parsed;
}
