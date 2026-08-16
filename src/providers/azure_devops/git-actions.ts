import type { AzureDevOpsActionHandler } from "./client.ts";

import {
  optionalBoolean,
  optionalInteger,
  optionalRawString,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requiredString,
} from "../../core/cast.ts";
import { encodePathSegment, readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";
import {
  azureDevOpsJsonRequest,
  azureDevOpsProjectPath,
  azureDevOpsRequest,
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

  async list_git_refs(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const repository = requiredString(input.repository, "repository");
    const response = await azureDevOpsJsonRequest<unknown>(
      organization,
      repositoryGitPath(project, repository, "refs"),
      deps,
      {
        query: {
          filter: normalizeRefFilter(input.filter),
          filterContains: optionalString(input.filterContains),
          $top: optionalInteger(input.top) ?? 100,
          continuationToken: optionalString(input.cursor),
        },
      },
    );
    return {
      refs: readAzureDevOpsCollection(response.body, "Azure DevOps Git refs"),
      nextCursor: response.continuationToken,
    };
  },

  async list_repository_items(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const repository = requiredString(input.repository, "repository");
    const response = await azureDevOpsJsonRequest<unknown>(
      organization,
      repositoryGitPath(project, repository, "items"),
      deps,
      {
        query: {
          scopePath: readRepositoryPath(input.scopePath, "scopePath", "/"),
          recursionLevel: optionalString(input.recursionLevel) ?? "oneLevel",
          includeContentMetadata: optionalBoolean(input.includeContentMetadata) !== false,
          latestProcessedChange: optionalBoolean(input.latestProcessedChange),
          ...gitVersionQuery(input),
        },
      },
    );
    const items = readAzureDevOpsCollection(response.body, "Azure DevOps repository items");
    const maxItems = boundedInteger(input.maxItems, "maxItems", 500, 2000);
    return {
      items: items.slice(0, maxItems),
      totalCount: items.length,
      truncated: items.length > maxItems,
    };
  },

  async read_repository_file(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const repository = requiredString(input.repository, "repository");
    const response = await azureDevOpsJsonRequest<Record<string, unknown>>(
      organization,
      repositoryGitPath(project, repository, "items"),
      deps,
      {
        query: {
          path: readRepositoryPath(input.path, "path"),
          includeContent: true,
          includeContentMetadata: true,
          resolveLfs: optionalBoolean(input.resolveLfs),
          ...gitVersionQuery(input),
        },
      },
    );
    if (optionalBoolean(response.body.isFolder)) {
      throw new ProviderRequestError(400, "path must identify a repository file, not a folder.");
    }
    const metadata = optionalRecord(response.body.contentMetadata);
    if (optionalBoolean(metadata?.isBinary)) {
      throw new ProviderRequestError(400, "The requested repository item is binary and cannot be read as text.");
    }
    const content = optionalRawString(response.body.content);
    if (content === undefined) {
      throw new ProviderRequestError(502, "Azure DevOps did not return repository file content.");
    }
    const lines = content.split(/\r\n|\n|\r/u);
    const startLine = boundedInteger(input.startLine, "startLine", 1, Number.MAX_SAFE_INTEGER);
    if (startLine > lines.length) {
      throw new ProviderRequestError(400, `startLine exceeds the file's ${lines.length} lines.`);
    }
    const lineCount = boundedInteger(input.lineCount, "lineCount", 500, 2000);
    const endLine = Math.min(lines.length, startLine + lineCount - 1);
    const item = { ...response.body };
    delete item.content;
    return {
      item,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      startLine,
      endLine,
      totalLines: lines.length,
      nextStartLine: endLine < lines.length ? endLine + 1 : null,
      truncated: endLine < lines.length,
    };
  },

  async download_repository_archive(input, deps) {
    if (!deps.transitFiles) {
      throw new ProviderRequestError(400, "Transit file storage is required to download a repository archive.");
    }
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const repository = requiredString(input.repository, "repository");
    const response = await azureDevOpsRequest(organization, repositoryGitPath(project, repository, "items"), deps, {
      accept: "application/zip",
      query: {
        scopePath: readRepositoryPath(input.scopePath, "scopePath", "/"),
        $format: "zip",
        zipForUnix: optionalBoolean(input.zipForUnix),
        ...gitVersionQuery(input),
      },
    });
    const name = `${safeArchiveName(repository)}-${safeArchiveName(optionalString(input.version) ?? "default")}.zip`;
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: deps.transitFiles.maxBytes,
      fieldName: "Azure DevOps repository archive",
      createError: (message) => new ProviderRequestError(413, message),
    });
    const archive = await deps.transitFiles.create(
      new File([Uint8Array.from(bytes)], name, { type: "application/zip" }),
    );
    return { archive };
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

function repositoryGitPath(project: string, repository: string, resource: string): string {
  return azureDevOpsProjectPath(project, `_apis/git/repositories/${encodePathSegment(repository)}/${resource}`);
}

function gitVersionQuery(input: Record<string, unknown>): Record<string, string | undefined> {
  const version = optionalString(input.version);
  const versionType = optionalString(input.versionType);
  if (!version && versionType) {
    throw new ProviderRequestError(400, "versionType requires version.");
  }
  return {
    "versionDescriptor.version": version,
    "versionDescriptor.versionType": version ? (versionType ?? "branch") : undefined,
  };
}

function readRepositoryPath(value: unknown, fieldName: string, fallback?: string): string {
  const path = optionalString(value) ?? fallback;
  if (!path || !path.startsWith("/")) {
    throw new ProviderRequestError(400, `${fieldName} must begin with /.`);
  }
  return path;
}

function boundedInteger(value: unknown, fieldName: string, fallback: number, maximum: number): number {
  const result = optionalInteger(value) ?? fallback;
  if (result < 1 || result > maximum) {
    throw new ProviderRequestError(400, `${fieldName} must be between 1 and ${maximum}.`);
  }
  return result;
}

function normalizeRefFilter(value: unknown): string | undefined {
  return optionalString(value)?.replace(/^refs\//u, "");
}

function safeArchiveName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "") || "repository";
}

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
