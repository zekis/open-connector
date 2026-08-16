import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { azureDevOpsPermissions } from "./permissions.ts";

const service = "azure_devops";

interface AzureDevOpsActionSource {
  name: string;
  description: string;
  providerPermissions: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const organization = s.nonEmptyString(
  "Optional Azure DevOps organization override. Defaults to the organization configured with the PAT connection.",
);
const projectIdOrName = s.nonEmptyString("Azure DevOps project ID or project name.");
const repositoryIdOrName = s.nonEmptyString("Azure Repos repository ID or repository name.");
const workItemId = s.positiveInteger("Azure DevOps work item ID.");
const rawObject = s.unknownObject("Additional Azure DevOps resource properties.");
const fieldValues = s.record(s.unknown("Azure DevOps work item field value."), {
  description: "Work item fields keyed by Azure DevOps reference name, such as Microsoft.VSTS.Common.Priority.",
});
fieldValues.minProperties = 1;

const project = s.looseObject(
  {
    id: s.nonEmptyString("Project ID."),
    name: s.nonEmptyString("Project name."),
    description: s.string("Project description."),
    url: s.url("Project REST URL."),
    state: s.string("Project state."),
    revision: s.integer("Project revision."),
    visibility: s.string("Project visibility."),
    lastUpdateTime: s.dateTime("Project last-update timestamp."),
  },
  { description: "Azure DevOps project." },
);

const repository = s.looseObject(
  {
    id: s.nonEmptyString("Repository ID."),
    name: s.nonEmptyString("Repository name."),
    url: s.url("Repository REST URL."),
    remoteUrl: s.url("Repository HTTPS clone URL."),
    sshUrl: s.string("Repository SSH clone URL."),
    webUrl: s.url("Repository browser URL."),
    defaultBranch: s.string("Default branch ref."),
    isDisabled: s.boolean("Whether the repository is disabled."),
    project: rawObject,
  },
  { description: "Azure Repos Git repository." },
);

const gitRef = s.looseObject(
  {
    name: s.nonEmptyString("Full Git ref name, such as refs/heads/main."),
    objectId: s.nonEmptyString("Commit or tag object ID at the ref tip."),
    peeledObjectId: s.string("Commit object ID referenced by an annotated tag."),
    isLocked: s.boolean("Whether the ref is locked."),
    creator: rawObject,
    url: s.url("Ref REST URL."),
  },
  { description: "Azure Repos branch or tag ref." },
);

const gitItem = s.looseObject(
  {
    objectId: s.nonEmptyString("Git object ID."),
    commitId: s.nonEmptyString("Commit ID used to retrieve the item."),
    path: s.nonEmptyString("Repository-relative item path."),
    gitObjectType: s.string("Git object type, such as tree or blob."),
    isFolder: s.boolean("Whether the item is a folder."),
    isSymLink: s.boolean("Whether the item is a symbolic link."),
    url: s.url("Item REST URL."),
    contentMetadata: rawObject,
    latestProcessedChange: rawObject,
  },
  { description: "Azure Repos file or folder metadata." },
);

const transitFile = s.object(
  {
    fileId: s.nonEmptyString("Local transit file identifier."),
    downloadUrl: s.url("Local URL for downloading the repository archive."),
    sizeBytes: s.nonNegativeInteger("Archive size in bytes."),
    name: s.nonEmptyString("Archive filename."),
    mimeType: s.nonEmptyString("Archive MIME type."),
  },
  {
    required: ["fileId", "downloadUrl", "sizeBytes", "name", "mimeType"],
    description: "Downloaded repository archive stored by the local transit file service.",
  },
);

const workItemAttachment = s.looseObject(
  {
    id: s.nonEmptyString("Attachment ID."),
    url: s.url("Azure DevOps attachment REST URL."),
  },
  { description: "Uploaded Azure DevOps work item attachment." },
);

const pullRequest = s.looseObject(
  {
    pullRequestId: s.positiveInteger("Pull request ID."),
    title: s.nonEmptyString("Pull request title."),
    description: s.string("Pull request description."),
    status: s.string("Pull request status."),
    isDraft: s.boolean("Whether the pull request is a draft."),
    sourceRefName: s.string("Source branch ref."),
    targetRefName: s.string("Target branch ref."),
    creationDate: s.dateTime("Pull request creation timestamp."),
    repository,
    createdBy: rawObject,
    reviewers: s.array(rawObject, { description: "Pull request reviewers." }),
  },
  { description: "Azure Repos pull request." },
);

const workItem = s.looseObject(
  {
    id: workItemId,
    rev: s.positiveInteger("Work item revision."),
    url: s.url("Work item REST URL."),
    fields: fieldValues,
    relations: s.array(rawObject, { description: "Work item relations when requested." }),
  },
  { description: "Azure DevOps work item." },
);

const workItemType = s.looseObject(
  {
    name: s.nonEmptyString("Work item type name."),
    referenceName: s.nonEmptyString("Work item type reference name."),
    description: s.string("Work item type description."),
    color: s.string("Work item type color."),
    icon: rawObject,
    states: s.array(rawObject, { description: "Work item workflow states." }),
    fields: s.array(rawObject, { description: "Work item type fields." }),
  },
  { description: "Azure DevOps work item type." },
);

const workItemComment = s.looseObject(
  {
    commentId: s.positiveInteger("Comment ID."),
    workItemId,
    text: s.string("Comment text."),
    renderedText: s.string("Rendered comment HTML."),
    format: s.string("Comment format."),
    createdDate: s.dateTime("Comment creation timestamp."),
    modifiedDate: s.dateTime("Comment last-modified timestamp."),
    createdBy: rawObject,
    modifiedBy: rawObject,
  },
  { description: "Azure DevOps work item comment." },
);

const top = s.integer("Maximum records to return.", { minimum: 1, maximum: 200 });
const numericCursor = s.stringPattern("^\\d+$", {
  description: "Non-negative numeric cursor returned by the previous page.",
});
const opaqueCursor = s.nonEmptyString("Opaque continuation token returned by the previous page.");
const gitVersion = s.nonEmptyString("Branch name, tag name, or commit SHA. Defaults to the repository default branch.");
const gitVersionType = s.stringEnum(["branch", "tag", "commit"], {
  description: "How Azure DevOps should interpret version. Used only when version is provided.",
});
const repositoryPath = s.nonEmptyString("Repository path beginning with /. Defaults to the repository root.");
const expandWorkItem = s.stringEnum(["None", "Relations", "Fields", "Links", "All"], {
  description: "Additional work item data to expand.",
});

const updateWorkItemInput = actionInput(
  {
    organization,
    project: projectIdOrName,
    id: workItemId,
    fields: fieldValues,
    removeFields: s.stringArray("Work item field reference names to remove.", {
      minItems: 1,
      itemDescription: "Azure DevOps work item field reference name.",
    }),
    revision: s.positiveInteger("Expected current revision used for optimistic concurrency."),
    suppressNotifications: s.boolean("Suppress work item notification delivery for this update."),
  },
  ["id"],
);
updateWorkItemInput.anyOf = [{ required: ["fields"] }, { required: ["removeFields"] }];

const actions: AzureDevOpsActionSource[] = [
  action(
    "list_projects",
    "List projects available in an Azure DevOps organization.",
    [azureDevOpsPermissions.profileRead, azureDevOpsPermissions.projectRead],
    actionInput({ organization, top, cursor: opaqueCursor }),
    collectionOutput("projects", project, "Azure DevOps projects."),
  ),
  action(
    "list_repositories",
    "List Azure Repos Git repositories across an organization or within one project.",
    [azureDevOpsPermissions.codeRead],
    actionInput({ organization, project: projectIdOrName, includeHidden: s.boolean("Include hidden repositories.") }),
    actionOutput({ repositories: s.array(repository, { description: "Azure Repos repositories." }) }),
  ),
  action(
    "list_git_refs",
    "List branches, tags, or other Git refs in an Azure Repos repository.",
    [azureDevOpsPermissions.codeRead],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        repository: repositoryIdOrName,
        filter: s.nonEmptyString("Ref prefix filter, such as heads/ or tags/. Azure DevOps prepends refs/."),
        filterContains: s.nonEmptyString("Return refs whose names contain this text."),
        top: s.integer("Maximum refs to return.", { minimum: 1, maximum: 1000 }),
        cursor: opaqueCursor,
      },
      ["project", "repository"],
    ),
    collectionOutput("refs", gitRef, "Azure Repos Git refs."),
  ),
  action(
    "list_repository_items",
    "Browse files and folders in an Azure Repos repository at a branch, tag, or commit.",
    [azureDevOpsPermissions.codeRead],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        repository: repositoryIdOrName,
        scopePath: repositoryPath,
        recursionLevel: s.stringEnum(["none", "oneLevel", "oneLevelPlusNestedEmptyFolders", "full"], {
          description: "How deeply to enumerate repository items. Defaults to oneLevel.",
        }),
        version: gitVersion,
        versionType: gitVersionType,
        includeContentMetadata: s.boolean("Include file content type, extension, encoding, and binary metadata."),
        latestProcessedChange: s.boolean("Include the latest commit known to have changed each item."),
        maxItems: s.integer("Maximum items to return from the retrieved tree.", { minimum: 1, maximum: 2000 }),
      },
      ["project", "repository"],
    ),
    actionOutput({
      items: s.array(gitItem, { description: "Repository files and folders." }),
      totalCount: s.nonNegativeInteger("Total items returned by Azure DevOps before the local result limit."),
      truncated: s.boolean("Whether more items existed than maxItems allowed in this result."),
    }),
  ),
  action(
    "read_repository_file",
    "Read a bounded line range from a text file in an Azure Repos repository at a branch, tag, or commit.",
    [azureDevOpsPermissions.codeRead],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        repository: repositoryIdOrName,
        path: s.nonEmptyString("Repository file path beginning with /."),
        version: gitVersion,
        versionType: gitVersionType,
        startLine: s.positiveInteger("One-based first line to return. Defaults to 1."),
        lineCount: s.integer("Maximum lines to return. Defaults to 500.", { minimum: 1, maximum: 2000 }),
        resolveLfs: s.boolean("Resolve a Git LFS pointer and return the referenced text content when possible."),
      },
      ["project", "repository", "path"],
    ),
    actionOutput({
      item: gitItem,
      content: s.string("Requested source-code text range."),
      startLine: s.positiveInteger("One-based first returned line."),
      endLine: s.nonNegativeInteger("One-based final returned line."),
      totalLines: s.nonNegativeInteger("Total lines in the repository file."),
      nextStartLine: s.nullableInteger("Next one-based line to request, or null when the end was reached."),
      truncated: s.boolean("Whether additional lines remain after this response."),
    }),
  ),
  action(
    "download_repository_archive",
    "Download a ZIP snapshot of an Azure Repos repository path at a branch, tag, or commit for checkout-like offline use.",
    [azureDevOpsPermissions.codeRead],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        repository: repositoryIdOrName,
        scopePath: repositoryPath,
        version: gitVersion,
        versionType: gitVersionType,
        zipForUnix: s.boolean("Preserve POSIX executable and symbolic-link metadata in the ZIP archive."),
      },
      ["project", "repository"],
    ),
    actionOutput({ archive: transitFile }),
  ),
  action(
    "list_pull_requests",
    "List Azure Repos pull requests in a project, optionally filtered by repository, status, branch, creator, or reviewer.",
    [azureDevOpsPermissions.codeRead],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        repository: repositoryIdOrName,
        status: s.stringEnum(["notSet", "active", "abandoned", "completed", "all"], {
          description: "Pull request status filter. Defaults to active.",
        }),
        sourceRefName: s.nonEmptyString("Source branch name or full ref."),
        targetRefName: s.nonEmptyString("Target branch name or full ref."),
        creatorId: s.nonEmptyString("Creator identity ID."),
        reviewerId: s.nonEmptyString("Reviewer identity ID."),
        top,
        cursor: numericCursor,
      },
      ["project"],
    ),
    collectionOutput("pullRequests", pullRequest, "Azure Repos pull requests."),
  ),
  action(
    "create_pull_request",
    "Create an Azure Repos pull request between two branches.",
    [azureDevOpsPermissions.codeWrite],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        repository: repositoryIdOrName,
        sourceRefName: s.nonEmptyString("Source branch name or full ref."),
        targetRefName: s.nonEmptyString("Target branch name or full ref."),
        title: s.nonEmptyString("Pull request title."),
        description: s.string("Pull request description."),
        isDraft: s.boolean("Create the pull request as a draft."),
        reviewerIds: s.stringArray("Azure DevOps identity IDs to add as reviewers.", {
          minItems: 1,
          itemDescription: "Azure DevOps reviewer identity ID.",
        }),
        workItemIds: s.stringArray("Work item IDs to link to the pull request.", {
          minItems: 1,
          itemDescription: "Azure DevOps work item ID.",
        }),
      },
      ["project", "repository", "sourceRefName", "targetRefName", "title"],
    ),
    actionOutput({ pullRequest }),
  ),
  action(
    "list_work_item_types",
    "List the work item types available in an Azure DevOps project, including PBIs, user stories, bugs, and tasks.",
    [azureDevOpsPermissions.workRead],
    actionInput({ organization, project: projectIdOrName }, ["project"]),
    actionOutput({ workItemTypes: s.array(workItemType, { description: "Project work item types." }) }),
  ),
  action(
    "query_work_items",
    "Run a WIQL query and optionally resolve the matching IDs into complete Azure DevOps work items.",
    [azureDevOpsPermissions.workRead],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        wiql: s.nonEmptyString("Azure DevOps Work Item Query Language statement."),
        top,
        includeDetails: s.boolean("Resolve query results into complete work items. Defaults to true."),
        fields: s.stringArray("Work item field reference names to return when resolving details.", {
          minItems: 1,
          maxItems: 100,
          itemDescription: "Azure DevOps work item field reference name.",
        }),
        expand: expandWorkItem,
      },
      ["wiql"],
    ),
    actionOutput({
      workItems: s.array(workItem, { description: "Matching work items or WIQL work item references." }),
      relations: s.array(rawObject, { description: "WIQL relation results for tree or one-hop queries." }),
      columns: s.array(rawObject, { description: "Columns selected by the WIQL query." }),
      queryType: s.string("WIQL query result type."),
    }),
  ),
  action(
    "get_work_item",
    "Get one Azure DevOps PBI, user story, bug, task, or other work item by ID.",
    [azureDevOpsPermissions.workRead],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        id: workItemId,
        fields: s.stringArray("Work item field reference names to return.", {
          minItems: 1,
          maxItems: 100,
          itemDescription: "Azure DevOps work item field reference name.",
        }),
        expand: expandWorkItem,
      },
      ["id"],
    ),
    actionOutput({ workItem }),
  ),
  action(
    "create_work_item",
    "Create an Azure DevOps PBI, user story, bug, task, or other project work item.",
    [azureDevOpsPermissions.workWrite],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        type: s.nonEmptyString("Project work item type name, such as Product Backlog Item, User Story, Bug, or Task."),
        title: s.nonEmptyString("Work item title."),
        description: s.string("Work item description, usually HTML for the System.Description field."),
        state: s.nonEmptyString("Initial workflow state."),
        assignedTo: s.nonEmptyString(
          "Assignee display name, email address, or identity descriptor accepted by Azure DevOps.",
        ),
        areaPath: s.nonEmptyString("Area path."),
        iterationPath: s.nonEmptyString("Iteration path."),
        tags: s.stringArray("Work item tags.", { minItems: 1, itemDescription: "Work item tag." }),
        fields: fieldValues,
        suppressNotifications: s.boolean("Suppress work item notification delivery for this create operation."),
      },
      ["project", "type", "title"],
    ),
    actionOutput({ workItem }),
  ),
  action(
    "update_work_item",
    "Update or remove fields on an existing Azure DevOps work item.",
    [azureDevOpsPermissions.workWrite],
    updateWorkItemInput,
    actionOutput({ workItem }),
  ),
  action(
    "add_work_item_attachment",
    "Upload an image or other file and attach it to an existing Azure DevOps work item.",
    [azureDevOpsPermissions.workWrite],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        id: workItemId,
        file: s.transitFile("Image or other file uploaded through POST /api/files."),
        comment: s.string("Optional comment shown with the work item attachment."),
        revision: s.positiveInteger("Expected current work item revision for optimistic concurrency."),
        suppressNotifications: s.boolean("Suppress work item notification delivery for this attachment."),
      },
      ["project", "id", "file"],
    ),
    actionOutput({ attachment: workItemAttachment, workItem }),
  ),
  action(
    "list_work_item_comments",
    "List comments on an Azure DevOps work item.",
    [azureDevOpsPermissions.workRead],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        id: workItemId,
        top,
        cursor: opaqueCursor,
        order: s.stringEnum(["asc", "desc"], { description: "Comment creation order." }),
      },
      ["project", "id"],
    ),
    collectionOutput("comments", workItemComment, "Work item comments."),
  ),
  action(
    "add_work_item_comment",
    "Add a Markdown or HTML comment to an Azure DevOps work item.",
    [azureDevOpsPermissions.workWrite],
    actionInput(
      {
        organization,
        project: projectIdOrName,
        id: workItemId,
        text: s.nonEmptyString("Comment text."),
        format: s.stringEnum(["markdown", "html"], { description: "Comment format. Defaults to markdown." }),
      },
      ["project", "id", "text"],
    ),
    actionOutput({ comment: workItemComment }),
  ),
];

export const azureDevOpsActions: ActionDefinition[] = actions.map((source) =>
  defineProviderAction(service, {
    name: source.name,
    description: source.description,
    requiredScopes: [],
    providerPermissions: source.providerPermissions,
    inputSchema: source.inputSchema,
    outputSchema: source.outputSchema,
  }),
);

function action(
  name: string,
  description: string,
  providerPermissions: string[],
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): AzureDevOpsActionSource {
  return { name, description, providerPermissions, inputSchema, outputSchema };
}

function actionInput(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, "Azure DevOps action input.");
}

function actionOutput(properties: Record<string, JsonSchema>): JsonSchema {
  return s.actionOutput(properties, "Azure DevOps action output.");
}

function collectionOutput(key: string, itemSchema: JsonSchema, description: string): JsonSchema {
  return actionOutput({
    [key]: s.array(itemSchema, { description }),
    nextCursor: s.nullableString("Cursor for the next page, if one is available."),
  });
}
