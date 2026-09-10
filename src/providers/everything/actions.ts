import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "everything";

const fileResultSchema = s.object("A file or folder returned by Everything.", {
  type: s.stringEnum("Whether the result is a file or folder.", ["file", "folder"]),
  name: s.nonEmptyString("The file or folder name."),
  path: s.string("The containing Windows path."),
  fullPath: s.nonEmptyString("The complete Windows path. Pass this value to download_file."),
  sizeBytes: s.nullableInteger("The file size in bytes, or null when unavailable or the result is a folder."),
  dateModified: s.nullableString("The modification time as an ISO 8601 timestamp, or null when unavailable."),
});

const transitFileSchema = s.object("A downloaded file stored in Open Connector transit storage.", {
  fileId: s.nonEmptyString("The local transit file identifier."),
  downloadUrl: s.string("The local transit URL for downloading the file."),
  sizeBytes: s.nonNegativeInteger("The downloaded file size in bytes."),
  name: s.nonEmptyString("The file name."),
  mimeType: s.nonEmptyString("The file MIME type returned by Everything."),
});

const searchFilesAction = defineProviderAction(service, {
  name: "search_files",
  description:
    "Search the connected Windows computer's Everything index and return matching file and folder paths with metadata.",
  inputSchema: s.object(
    "An Everything HTTP Server file search.",
    {
      query: s.nonWhitespaceString(
        "Everything search text. Everything operators and functions such as ext:xlsx, path:, parent:, dm:, and boolean operators are supported.",
      ),
      offset: s.nonNegativeInteger("Zero-based result offset.", { default: 0 }),
      count: s.integer("Maximum number of results to return.", { minimum: 1, maximum: 200, default: 50 }),
      sort: s.stringEnum(["name", "path", "date_modified", "size"], {
        description: "Result sort field.",
        default: "name",
      }),
      direction: s.stringEnum(["ascending", "descending"], {
        description: "Result sort direction.",
        default: "ascending",
      }),
      matchCase: s.boolean({ description: "Match letter case.", default: false }),
      wholeWord: s.boolean({ description: "Match whole words only.", default: false }),
      matchPath: s.boolean({ description: "Match against the full path instead of only the name.", default: false }),
      regex: s.boolean({ description: "Interpret query as a regular expression.", default: false }),
      matchDiacritics: s.boolean({ description: "Match diacritical marks.", default: false }),
    },
    {
      optional: [
        "offset",
        "count",
        "sort",
        "direction",
        "matchCase",
        "wholeWord",
        "matchPath",
        "regex",
        "matchDiacritics",
      ],
    },
  ),
  outputSchema: s.object("Normalized Everything search results.", {
    totalResults: s.nonNegativeInteger("Total matches in the Everything index before paging."),
    offset: s.nonNegativeInteger("Zero-based offset used for this request."),
    returnedResults: s.nonNegativeInteger("Number of results returned in this response."),
    results: s.array("Matching files and folders.", fileResultSchema, { maxItems: 200 }),
  }),
  followUpActions: ["everything.download_file"],
});

const downloadFileAction = defineProviderAction(service, {
  name: "download_file",
  description:
    "Download one indexed file from the connected Everything HTTP Server into Open Connector transit storage.",
  inputSchema: s.object("An exact indexed file to download.", {
    path: s.nonWhitespaceString("Complete Windows path returned as fullPath by search_files."),
  }),
  outputSchema: s.object("The downloaded Everything file.", {
    sourcePath: s.nonEmptyString("The Windows path downloaded from Everything."),
    file: transitFileSchema,
  }),
});

export const everythingActions: ActionDefinition[] = [searchFilesAction, downloadFileAction];
