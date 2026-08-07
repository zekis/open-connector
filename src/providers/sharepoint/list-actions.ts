import type { SharePointActionHandler } from "./graph-client.ts";

import {
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requiredRecord,
  requiredString,
} from "../../core/cast.ts";
import { encodePathSegment } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";
import { sharePointCollectionRequest, sharePointJsonRequest } from "./graph-client.ts";

export const sharePointListActionHandlers: Record<string, SharePointActionHandler> = {
  async list_lists(input, deps) {
    const nextLink = optionalString(input.nextLink);
    return sharePointCollectionRequest(nextLink ?? `${buildSitePath(input)}/lists`, deps, {
      nextLinkKind: nextLink ? "lists" : undefined,
    });
  },

  get_list(input, deps) {
    return sharePointJsonRequest(`${buildListPath(input)}`, deps, {
      query: optionalBoolean(input.includeColumns) === false ? undefined : { $expand: "columns" },
    });
  },

  async list_list_items(input, deps) {
    const nextLink = optionalString(input.nextLink);
    const fieldNames = optionalStringArray(input.fieldNames);
    if (fieldNames?.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
      throw new ProviderRequestError(400, "fieldNames must contain SharePoint column internal names.");
    }
    const expand = fieldNames?.length ? `fields($select=${fieldNames.join(",")})` : "fields";
    return sharePointCollectionRequest(nextLink ?? `${buildListPath(input)}/items`, deps, {
      nextLinkKind: nextLink ? "list_items" : undefined,
      query: nextLink
        ? undefined
        : {
            $expand: expand,
            $filter: optionalString(input.filter),
            $top: optionalInteger(input.top),
          },
    });
  },

  create_list_item(input, deps) {
    return sharePointJsonRequest(`${buildListPath(input)}/items`, deps, {
      method: "POST",
      body: {
        fields: readFieldValues(input.fields),
      },
    });
  },

  update_list_item_fields(input, deps) {
    return sharePointJsonRequest(
      `${buildListPath(input)}/items/${encodePathSegment(requiredString(input.itemId, "itemId"))}/fields`,
      deps,
      {
        method: "PATCH",
        headers: { "if-match": optionalString(input.ifMatch) },
        body: readFieldValues(input.fields),
      },
    );
  },
};

function buildSitePath(input: Record<string, unknown>): string {
  return `sites/${encodePathSegment(requiredString(input.siteId, "siteId"))}`;
}

function buildListPath(input: Record<string, unknown>): string {
  return `${buildSitePath(input)}/lists/${encodePathSegment(requiredString(input.listId, "listId"))}`;
}

function readFieldValues(value: unknown): Record<string, unknown> {
  const fields = requiredRecord(value, "fields", (message) => new ProviderRequestError(400, message));
  if (Object.keys(fields).length === 0) {
    throw new ProviderRequestError(400, "fields must contain at least one SharePoint column value.");
  }
  return fields;
}
