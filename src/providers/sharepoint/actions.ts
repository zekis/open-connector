import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { sharePointProviderScopes, sharePointReadScopes, sharePointWriteScopes } from "./scopes.ts";

const service = "sharepoint";

interface SharePointActionSource {
  name: string;
  description: string;
  requiredScopes: string[];
  providerPermissions: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  followUpActions?: string[];
}

const siteId = s.nonEmptyString("Microsoft Graph SharePoint site ID, or the reserved value root.");
const driveId = s.nonEmptyString("Microsoft Graph drive ID for a SharePoint document library.");
const driveItemId = s.nonEmptyString("Microsoft Graph drive item ID.");
const driveItemPath = s.nonEmptyString("Path relative to the document-library root, such as /Projects/file.xlsx.");
const listId = s.nonEmptyString("Microsoft Graph SharePoint list ID or list title.");
const listItemId = s.nonEmptyString("Microsoft Graph SharePoint list item ID.");
const nextLink = s.url("Opaque Microsoft Graph nextLink returned by the same SharePoint action.");
const top = s.integer("Maximum number of records to return.", { minimum: 1, maximum: 999 });
const rawObject = s.unknownObject("Additional Microsoft Graph resource properties.");
const fieldValues = s.record(s.unknown("A SharePoint column value."), {
  description: "SharePoint list column values keyed by internal column name.",
});
fieldValues.minProperties = 1;

const site = s.looseObject(
  {
    id: s.nonEmptyString("Microsoft Graph site ID."),
    displayName: s.string("Site display name."),
    name: s.string("Site name."),
    description: s.string("Site description."),
    webUrl: s.url("Browser URL for the site."),
    createdDateTime: s.dateTime("Site creation timestamp."),
    lastModifiedDateTime: s.dateTime("Site last-modified timestamp."),
    root: rawObject,
    siteCollection: rawObject,
    sharepointIds: rawObject,
  },
  { description: "SharePoint site returned by Microsoft Graph." },
);

const drive = s.looseObject(
  {
    id: s.nonEmptyString("Microsoft Graph drive ID."),
    name: s.string("Document-library display name."),
    description: s.string("Document-library description."),
    driveType: s.string("Microsoft Graph drive type."),
    webUrl: s.url("Browser URL for the document library."),
    createdDateTime: s.dateTime("Document-library creation timestamp."),
    lastModifiedDateTime: s.dateTime("Document-library last-modified timestamp."),
    owner: rawObject,
    quota: rawObject,
  },
  { description: "SharePoint document library represented as a Microsoft Graph drive." },
);

const driveItem = s.looseObject(
  {
    id: s.nonEmptyString("Microsoft Graph drive item ID."),
    name: s.nonEmptyString("File or folder name."),
    webUrl: s.url("Browser URL for the file or folder."),
    description: s.string("File or folder description."),
    size: s.nonNegativeInteger("File or folder size in bytes."),
    createdDateTime: s.dateTime("Creation timestamp."),
    lastModifiedDateTime: s.dateTime("Last-modified timestamp."),
    eTag: s.string("Drive item entity tag."),
    cTag: s.string("Drive item content tag."),
    parentReference: rawObject,
    createdBy: rawObject,
    lastModifiedBy: rawObject,
    file: rawObject,
    folder: rawObject,
    listItem: rawObject,
    remoteItem: rawObject,
    searchResult: rawObject,
  },
  { description: "SharePoint file or folder represented as a Microsoft Graph drive item." },
);

const list = s.looseObject(
  {
    id: s.nonEmptyString("Microsoft Graph list ID."),
    displayName: s.string("List display name."),
    name: s.string("List name."),
    description: s.string("List description."),
    webUrl: s.url("Browser URL for the list."),
    createdDateTime: s.dateTime("List creation timestamp."),
    lastModifiedDateTime: s.dateTime("List last-modified timestamp."),
    list: rawObject,
    columns: s.array(rawObject, { description: "Column definitions when requested." }),
  },
  { description: "SharePoint list returned by Microsoft Graph." },
);

const listItem = s.looseObject(
  {
    id: s.nonEmptyString("Microsoft Graph list item ID."),
    webUrl: s.url("Browser URL for the list item."),
    createdDateTime: s.dateTime("List item creation timestamp."),
    lastModifiedDateTime: s.dateTime("List item last-modified timestamp."),
    eTag: s.string("List item entity tag."),
    fields: fieldValues,
    createdBy: rawObject,
    lastModifiedBy: rawObject,
    parentReference: rawObject,
  },
  { description: "SharePoint list item returned by Microsoft Graph." },
);

const downloadedFile = s.object(
  {
    name: s.nonEmptyString("Downloaded file name."),
    mimeType: s.nonEmptyString("Downloaded file MIME type."),
    sizeBytes: s.nonNegativeInteger("Downloaded file size in bytes."),
    file: s.nullable(
      s.looseObject(
        {
          fileId: s.nonEmptyString("Local transit file ID."),
          downloadUrl: s.nonEmptyString("Local transit file download URL."),
          name: s.nonEmptyString("Transit file name."),
          mimeType: s.nonEmptyString("Transit file MIME type."),
          sizeBytes: s.nonNegativeInteger("Transit file size in bytes."),
        },
        { description: "Local transit file reference when transit storage is enabled." },
      ),
    ),
    contentBase64: s.nullableString("Base64 content returned only when local transit storage is unavailable."),
  },
  {
    required: ["name", "mimeType", "sizeBytes", "file", "contentBase64"],
    description: "Downloaded SharePoint file.",
  },
);

const siteCollection = collectionOutput("SharePoint sites returned by Microsoft Graph.", site);
const driveCollection = collectionOutput("SharePoint document libraries returned by Microsoft Graph.", drive);
const driveItemCollection = collectionOutput("SharePoint files and folders returned by Microsoft Graph.", driveItem);
const listCollection = collectionOutput("SharePoint lists returned by Microsoft Graph.", list);
const listItemCollection = collectionOutput("SharePoint list items returned by Microsoft Graph.", listItem);

const getDriveItemInput = s.actionInput(
  {
    driveId,
    itemId: driveItemId,
    itemPath: driveItemPath,
  },
  ["driveId"],
  "SharePoint action input.",
);
getDriveItemInput.anyOf = [{ required: ["itemId"] }, { required: ["itemPath"] }];

const uploadFileInput = s.actionInput(
  {
    driveId,
    parentItemId: driveItemId,
    folderPath: s.nonEmptyString("Destination folder path relative to the document-library root."),
    name: s.nonEmptyString("Destination filename. Optional when a transit file supplies its name."),
    mimeType: s.nonEmptyString("MIME type for the uploaded content."),
    file: s.transitFile("File uploaded through POST /api/files."),
    contentBase64: s.nonEmptyString("Base64-encoded file content."),
    text: s.string("UTF-8 text file content, including an empty string."),
    conflictBehavior: s.stringEnum(["replace", "rename", "fail"], {
      description: "Behavior when a file already exists. Defaults to replace.",
    }),
  },
  ["driveId"],
  "SharePoint action input.",
);
uploadFileInput.anyOf = [
  { required: ["file"] },
  { required: ["contentBase64", "name"] },
  { required: ["text", "name"] },
];

const actions: SharePointActionSource[] = [
  read(
    "search_sites",
    "Search across the connected SharePoint tenant for sites matching a keyword query.",
    s.actionInput(
      { query: s.nonEmptyString("Free-text site search query."), nextLink },
      ["query"],
      "SharePoint action input.",
    ),
    siteCollection,
    ["sharepoint.list_site_drives", "sharepoint.list_lists"],
  ),
  read(
    "get_site",
    "Get one SharePoint site by Microsoft Graph site ID.",
    s.actionInput({ siteId }, ["siteId"], "SharePoint action input."),
    site,
    ["sharepoint.list_site_drives", "sharepoint.list_lists"],
  ),
  read(
    "get_site_by_path",
    "Resolve a SharePoint site from its tenant hostname and server-relative path.",
    s.actionInput(
      {
        hostname: s.string({
          minLength: 1,
          pattern: "^[A-Za-z0-9.-]+$",
          description: "SharePoint hostname, such as contoso.sharepoint.com.",
        }),
        sitePath: s.nonEmptyString("Server-relative site path, such as /sites/Engineering."),
      },
      ["hostname", "sitePath"],
      "SharePoint action input.",
    ),
    site,
    ["sharepoint.list_site_drives", "sharepoint.list_lists"],
  ),
  read(
    "list_site_drives",
    "List the document libraries available in a SharePoint site.",
    s.actionInput(
      { siteId, top, orderBy: s.nonEmptyString("Microsoft Graph order-by expression."), nextLink },
      ["siteId"],
      "SharePoint action input.",
    ),
    driveCollection,
    ["sharepoint.list_folder_children", "sharepoint.search_drive_items"],
  ),
  read(
    "get_drive_item",
    "Get metadata for a SharePoint file or folder by drive item ID or path.",
    getDriveItemInput,
    driveItem,
  ),
  read(
    "list_folder_children",
    "List the direct files and folders inside a SharePoint document-library folder.",
    s.actionInput(
      { driveId, folderItemId: driveItemId, folderPath: driveItemPath, top, nextLink },
      ["driveId"],
      "SharePoint action input.",
    ),
    driveItemCollection,
    ["sharepoint.get_drive_item", "sharepoint.download_file"],
  ),
  read(
    "search_drive_items",
    "Search a SharePoint document library for files and folders matching a keyword query.",
    s.actionInput(
      {
        driveId,
        query: s.nonEmptyString("Keyword query matched against filenames, metadata, and content."),
        top,
        nextLink,
      },
      ["driveId", "query"],
      "SharePoint action input.",
    ),
    driveItemCollection,
    ["sharepoint.get_drive_item", "sharepoint.download_file"],
  ),
  write(
    "create_folder",
    "Create a folder in a SharePoint document library.",
    s.actionInput(
      {
        driveId,
        name: s.nonEmptyString("Folder name."),
        parentItemId: driveItemId,
        parentPath: driveItemPath,
        conflictBehavior: s.stringEnum(["rename", "fail", "replace"], {
          description: "Behavior when a folder with the same name exists. Defaults to rename.",
        }),
      },
      ["driveId", "name"],
      "SharePoint action input.",
    ),
    driveItem,
  ),
  write(
    "upload_file",
    "Upload or replace a file up to 20 MiB in a SharePoint document library.",
    uploadFileInput,
    driveItem,
  ),
  read(
    "download_file",
    "Download a SharePoint file by drive item ID into local transit storage or base64 content.",
    s.actionInput({ driveId, itemId: driveItemId }, ["driveId", "itemId"], "SharePoint action input."),
    downloadedFile,
  ),
  read(
    "list_lists",
    "List the lists in a SharePoint site.",
    s.actionInput({ siteId, nextLink }, ["siteId"], "SharePoint action input."),
    listCollection,
    ["sharepoint.get_list", "sharepoint.list_list_items"],
  ),
  read(
    "get_list",
    "Get SharePoint list metadata and optionally its column definitions.",
    s.actionInput(
      { siteId, listId, includeColumns: s.boolean("Include list column definitions. Defaults to true.") },
      ["siteId", "listId"],
      "SharePoint action input.",
    ),
    list,
    ["sharepoint.list_list_items", "sharepoint.create_list_item"],
  ),
  read(
    "list_list_items",
    "List SharePoint list items with their column values.",
    s.actionInput(
      {
        siteId,
        listId,
        fieldNames: s.stringArray("Column internal names to include in each item's fields.", {
          minItems: 1,
          itemDescription: "SharePoint column internal name.",
        }),
        filter: s.nonEmptyString("Microsoft Graph OData filter expression."),
        top,
        nextLink,
      },
      ["siteId", "listId"],
      "SharePoint action input.",
    ),
    listItemCollection,
    ["sharepoint.update_list_item_fields"],
  ),
  write(
    "create_list_item",
    "Create an item in a SharePoint list from column values.",
    s.actionInput({ siteId, listId, fields: fieldValues }, ["siteId", "listId", "fields"], "SharePoint action input."),
    listItem,
  ),
  write(
    "update_list_item_fields",
    "Update selected column values on an existing SharePoint list item.",
    s.actionInput(
      {
        siteId,
        listId,
        itemId: listItemId,
        fields: fieldValues,
        ifMatch: s.nonEmptyString("Optional eTag used for a conditional update."),
      },
      ["siteId", "listId", "itemId", "fields"],
      "SharePoint action input.",
    ),
    fieldValues,
  ),
];

export const sharePointActions: ActionDefinition[] = actions.map((action) => defineProviderAction(service, action));

function read(
  name: string,
  description: string,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
  followUpActions?: string[],
): SharePointActionSource {
  return {
    name,
    description,
    requiredScopes: sharePointReadScopes,
    providerPermissions: [sharePointProviderScopes.sitesReadAll],
    inputSchema,
    outputSchema,
    followUpActions,
  };
}

function write(
  name: string,
  description: string,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): SharePointActionSource {
  return {
    name,
    description,
    requiredScopes: sharePointWriteScopes,
    providerPermissions: [sharePointProviderScopes.sitesReadWriteAll],
    inputSchema,
    outputSchema,
  };
}

function collectionOutput(description: string, itemSchema: JsonSchema): JsonSchema {
  return s.object(
    {
      items: s.array(itemSchema, { description }),
      nextLink: s.nullableString("Opaque Microsoft Graph nextLink for the next page, if any."),
    },
    { required: ["items", "nextLink"], description },
  );
}
