import type { AzureDevOpsActionHandler, AzureDevOpsRuntimeDeps } from "./client.ts";

import {
  optionalBoolean,
  optionalInteger,
  optionalObjectArray,
  optionalRecord,
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

interface JsonPatchOperation {
  op: "add" | "remove" | "test";
  path: string;
  value?: unknown;
}

export const azureDevOpsWorkItemActionHandlers: Record<string, AzureDevOpsActionHandler> = {
  async list_work_item_types(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const response = await azureDevOpsJsonRequest<unknown>(
      organization,
      azureDevOpsProjectPath(project, "_apis/wit/workitemtypes"),
      deps,
    );
    return {
      workItemTypes: readAzureDevOpsCollection(response.body, "Azure DevOps work item types"),
    };
  },

  async query_work_items(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = optionalString(input.project);
    const response = await azureDevOpsJsonRequest<Record<string, unknown>>(
      organization,
      azureDevOpsProjectPath(project, "_apis/wit/wiql"),
      deps,
      {
        method: "POST",
        query: { $top: optionalInteger(input.top) ?? 200 },
        body: { query: requiredString(input.wiql, "wiql") },
      },
    );
    const queryWorkItems = optionalObjectArray(
      response.body.workItems,
      "Azure DevOps WIQL work item",
      providerResponseError,
    );
    const relations = optionalObjectArray(
      response.body.workItemRelations,
      "Azure DevOps WIQL relation",
      providerResponseError,
    );
    const ids = collectWorkItemIds(queryWorkItems, relations);
    const includeDetails = optionalBoolean(input.includeDetails) !== false;
    const workItems =
      includeDetails && ids.length > 0
        ? await getWorkItemsByIds(organization, project, ids, input, deps)
        : queryWorkItems;
    return {
      workItems,
      relations,
      columns: optionalObjectArray(response.body.columns, "Azure DevOps WIQL column", providerResponseError),
      queryType: optionalString(response.body.queryType) ?? "flat",
    };
  },

  async get_work_item(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = optionalString(input.project);
    const id = requiredPositiveInteger(input.id, "id");
    const response = await azureDevOpsJsonRequest<Record<string, unknown>>(
      organization,
      azureDevOpsProjectPath(project, `_apis/wit/workitems/${id}`),
      deps,
      {
        query: workItemDetailQuery(input),
      },
    );
    return { workItem: response.body };
  },

  async create_work_item(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const type = requiredString(input.type, "type");
    const fields = new Map(Object.entries(optionalRecord(input.fields) ?? {}));
    fields.set("System.Title", requiredString(input.title, "title"));
    setOptionalField(fields, "System.Description", input.description);
    setOptionalField(fields, "System.State", input.state);
    setOptionalField(fields, "System.AssignedTo", input.assignedTo);
    setOptionalField(fields, "System.AreaPath", input.areaPath);
    setOptionalField(fields, "System.IterationPath", input.iterationPath);
    const tags = optionalStringArray(input.tags);
    if (tags) {
      fields.set("System.Tags", tags.join("; "));
    }
    const patch = [...fields].map<JsonPatchOperation>(([field, value]) => ({
      op: "add",
      path: `/fields/${escapeJsonPointer(field)}`,
      value,
    }));
    const response = await azureDevOpsJsonRequest<Record<string, unknown>>(
      organization,
      azureDevOpsProjectPath(project, `_apis/wit/workitems/$${encodePathSegment(type)}`),
      deps,
      {
        method: "POST",
        contentType: "application/json-patch+json",
        query: {
          $expand: "All",
          suppressNotifications: optionalBoolean(input.suppressNotifications),
        },
        body: patch,
      },
    );
    return { workItem: response.body };
  },

  async update_work_item(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = optionalString(input.project);
    const id = requiredPositiveInteger(input.id, "id");
    const patch: JsonPatchOperation[] = [];
    const revision = optionalInteger(input.revision);
    if (revision !== undefined) {
      patch.push({ op: "test", path: "/rev", value: revision });
    }
    for (const [field, value] of Object.entries(optionalRecord(input.fields) ?? {})) {
      patch.push({ op: "add", path: `/fields/${escapeJsonPointer(field)}`, value });
    }
    for (const field of optionalStringArray(input.removeFields) ?? []) {
      patch.push({ op: "remove", path: `/fields/${escapeJsonPointer(field)}` });
    }
    if (patch.length === 0 || (patch.length === 1 && patch[0]?.op === "test")) {
      throw new ProviderRequestError(400, "update_work_item requires fields or removeFields.");
    }
    const response = await azureDevOpsJsonRequest<Record<string, unknown>>(
      organization,
      azureDevOpsProjectPath(project, `_apis/wit/workitems/${id}`),
      deps,
      {
        method: "PATCH",
        contentType: "application/json-patch+json",
        query: {
          $expand: "All",
          suppressNotifications: optionalBoolean(input.suppressNotifications),
        },
        body: patch,
      },
    );
    return { workItem: response.body };
  },

  async list_work_item_comments(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const id = requiredPositiveInteger(input.id, "id");
    const response = await azureDevOpsJsonRequest<Record<string, unknown>>(
      organization,
      azureDevOpsProjectPath(project, `_apis/wit/workItems/${id}/comments`),
      deps,
      {
        query: {
          "api-version": "7.1-preview.4",
          $top: optionalInteger(input.top),
          continuationToken: optionalString(input.cursor),
          order: optionalString(input.order),
        },
      },
    );
    return {
      comments: optionalObjectArray(response.body.comments, "Azure DevOps comment", providerResponseError),
      nextCursor: optionalString(response.body.continuationToken) ?? response.continuationToken,
    };
  },

  async add_work_item_comment(input, deps) {
    const organization = resolveAzureDevOpsOrganization(input, deps);
    const project = requiredString(input.project, "project");
    const id = requiredPositiveInteger(input.id, "id");
    const response = await azureDevOpsJsonRequest<Record<string, unknown>>(
      organization,
      azureDevOpsProjectPath(project, `_apis/wit/workItems/${id}/comments`),
      deps,
      {
        method: "POST",
        query: {
          "api-version": "7.1-preview.4",
          format: optionalString(input.format) ?? "markdown",
        },
        body: { text: requiredString(input.text, "text") },
      },
    );
    return { comment: response.body };
  },
};

async function getWorkItemsByIds(
  organization: string,
  project: string | undefined,
  ids: number[],
  input: Record<string, unknown>,
  deps: AzureDevOpsRuntimeDeps,
): Promise<Array<Record<string, unknown>>> {
  const response = await azureDevOpsJsonRequest<unknown>(
    organization,
    azureDevOpsProjectPath(project, "_apis/wit/workitems"),
    deps,
    {
      query: {
        ids: ids.join(","),
        errorPolicy: "Omit",
        ...workItemDetailQuery(input),
      },
    },
  );
  return readAzureDevOpsCollection(response.body, "Azure DevOps work items");
}

function workItemDetailQuery(input: Record<string, unknown>): Record<string, string | undefined> {
  return {
    fields: optionalStringArray(input.fields)?.join(","),
    $expand: optionalString(input.expand),
  };
}

function collectWorkItemIds(
  workItems: Array<Record<string, unknown>>,
  relations: Array<Record<string, unknown>>,
): number[] {
  const ids = new Set<number>();
  for (const item of workItems) {
    addWorkItemId(ids, item.id);
  }
  for (const relation of relations) {
    addWorkItemId(ids, optionalRecord(relation.source)?.id);
    addWorkItemId(ids, optionalRecord(relation.target)?.id);
  }
  return [...ids].slice(0, 200);
}

function addWorkItemId(ids: Set<number>, value: unknown): void {
  const id = optionalInteger(value);
  if (id !== undefined && id > 0) {
    ids.add(id);
  }
}

function setOptionalField(fields: Map<string, unknown>, field: string, value: unknown): void {
  const text = optionalString(value);
  if (text !== undefined) {
    fields.set(field, text);
  }
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function requiredPositiveInteger(value: unknown, fieldName: string): number {
  const result = optionalInteger(value);
  if (result === undefined || result <= 0) {
    throw new ProviderRequestError(400, `${fieldName} must be a positive integer.`);
  }
  return result;
}

function providerResponseError(message: string): ProviderRequestError {
  return new ProviderRequestError(502, message);
}
