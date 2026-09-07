import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "officecli";

const documentPathSchema = s.nonEmptyString(
  "A path relative to the OfficeCLI document root. Supported document extensions are .docx, .xlsx, and .pptx.",
);

const documentInfoSchema = s.object("A document stored by the OfficeCLI API.", {
  path: documentPathSchema,
  name: s.nonEmptyString("The document file name."),
  extension: s.stringEnum("The Office document extension.", [".docx", ".xlsx", ".pptx"]),
  sizeBytes: s.nonNegativeInteger("The document size in bytes."),
  modifiedAt: s.dateTime("When the document was last modified."),
});

const transitFileOutputSchema = s.object("A file stored in Open Connector transit storage.", {
  fileId: s.nonEmptyString("The local transit file identifier."),
  downloadUrl: s.url("The local URL for downloading the file."),
  sizeBytes: s.nonNegativeInteger("The file size in bytes."),
  name: s.nonEmptyString("The file name."),
  mimeType: s.nonEmptyString("The file MIME type."),
});

const commandResultOutputSchema = s.actionOutput(
  {
    result: s.unknown("The structured JSON result returned by OfficeCLI."),
    warnings: s.array("Warnings written by OfficeCLI while processing the command.", s.string("One warning.")),
  },
  "The result of an OfficeCLI command.",
  ["result"],
);

const batchPropertyValueSchema = s.nullable(
  s.anyOf("An OfficeCLI property value.", [
    s.string("A string property value."),
    s.number("A numeric property value."),
    s.boolean("A boolean property value."),
  ]),
);

const batchItemSchema = s.object(
  "One OfficeCLI batch command. Use parent and type for add; path and props for set; path for remove; and path plus to, before, or after for move.",
  {
    command: s.stringEnum("The OfficeCLI operation to perform.", [
      "add",
      "set",
      "remove",
      "move",
      "copy",
      "swap",
      "get",
      "query",
    ]),
    path: s.nonEmptyString("The DOM path targeted by set, remove, move, copy, swap, or get."),
    parent: s.nonEmptyString("The parent DOM path targeted by add."),
    type: s.nonEmptyString("The element type to add."),
    from: s.nonEmptyString("The source path accepted by some move and copy operations."),
    to: s.nonEmptyString("The destination parent or path for move, copy, or swap."),
    path2: s.nonEmptyString("The second DOM path for swap."),
    before: s.nonEmptyString("Insert before this DOM path."),
    after: s.nonEmptyString("Insert after this DOM path."),
    index: s.nonNegativeInteger("The zero-based destination index."),
    selector: s.nonEmptyString("The CSS-like selector used by query."),
    depth: s.nonNegativeInteger("The child depth returned by get."),
    props: s.record("OfficeCLI element properties keyed by property name.", batchPropertyValueSchema),
  },
  {
    optional: [
      "path",
      "parent",
      "type",
      "from",
      "to",
      "path2",
      "before",
      "after",
      "index",
      "selector",
      "depth",
      "props",
    ],
  },
);

export const officeCliActions: ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_documents",
    description: "List Word, Excel, and PowerPoint documents stored by the OfficeCLI API.",
    inputSchema: s.actionInput(
      {
        prefix: s.string("Optional relative directory prefix used to narrow the result."),
      },
      [],
    ),
    outputSchema: s.actionOutput({
      documents: s.array("The matching stored documents.", documentInfoSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "upload_document",
    description: "Upload a DOCX, XLSX, or PPTX transit file into the OfficeCLI document store.",
    inputSchema: s.actionInput(
      {
        document: documentPathSchema,
        file: s.transitFile("The DOCX, XLSX, or PPTX file to upload."),
      },
      ["document", "file"],
    ),
    outputSchema: s.actionOutput({ document: documentInfoSchema }),
  }),
  defineProviderAction(service, {
    name: "download_document",
    description: "Download a stored Office document into Open Connector transit storage.",
    inputSchema: s.actionInput({ document: documentPathSchema }, ["document"]),
    outputSchema: s.actionOutput({ file: transitFileOutputSchema }),
  }),
  defineProviderAction(service, {
    name: "delete_document",
    description: "Permanently delete a document from the OfficeCLI document store.",
    inputSchema: s.actionInput({ document: documentPathSchema }, ["document"]),
    outputSchema: s.actionOutput({
      deleted: s.boolean("Whether the document was deleted."),
      document: documentPathSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "create_document",
    description: "Create a blank Word, Excel, or PowerPoint document.",
    inputSchema: s.actionInput(
      {
        document: documentPathSchema,
        force: s.boolean("Overwrite an existing document. Defaults to false."),
      },
      ["document"],
    ),
    outputSchema: commandResultOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_document_element",
    description: "Read an OfficeCLI document DOM element and a bounded number of child levels.",
    inputSchema: s.actionInput(
      {
        document: documentPathSchema,
        path: s.nonEmptyString("The OfficeCLI DOM path. Defaults to /."),
        depth: s.integer("The number of child levels to include, from 0 to 32.", {
          minimum: 0,
          maximum: 32,
        }),
      },
      ["document"],
    ),
    outputSchema: commandResultOutputSchema,
  }),
  defineProviderAction(service, {
    name: "query_document",
    description: "Query Office document elements using OfficeCLI CSS-like selectors.",
    inputSchema: s.actionInput(
      {
        document: documentPathSchema,
        selector: s.nonEmptyString(
          "An OfficeCLI selector such as paragraph[style=Heading1], cell[formula~=SUM], or shape:contains(TODO).",
        ),
        find: s.nonEmptyString("Optional case-insensitive text filter applied to the matches."),
      },
      ["document", "selector"],
    ),
    outputSchema: commandResultOutputSchema,
  }),
  defineProviderAction(service, {
    name: "view_document",
    description: "View document text, structure, statistics, issues, forms, HTML, or SVG through OfficeCLI.",
    inputSchema: s.actionInput(
      {
        document: documentPathSchema,
        mode: s.stringEnum("The OfficeCLI view mode.", [
          "text",
          "annotated",
          "outline",
          "stats",
          "issues",
          "forms",
          "html",
          "svg",
        ]),
      },
      ["document", "mode"],
    ),
    outputSchema: commandResultOutputSchema,
  }),
  defineProviderAction(service, {
    name: "edit_document",
    description:
      "Apply a structured OfficeCLI batch to a document. The batch is atomic by default, so any failed item rolls back all changes.",
    inputSchema: s.actionInput(
      {
        document: documentPathSchema,
        commands: s.array("The ordered OfficeCLI batch commands.", batchItemSchema, {
          minItems: 1,
          maxItems: 500,
        }),
        stopOnError: s.boolean("Stop evaluating commands after the first failure."),
        bestEffort: s.boolean("Keep successful changes when another command fails instead of rolling back the batch."),
      },
      ["document", "commands"],
    ),
    outputSchema: commandResultOutputSchema,
  }),
  defineProviderAction(service, {
    name: "validate_document",
    description: "Validate an Office document and return OfficeCLI's structured findings.",
    inputSchema: s.actionInput({ document: documentPathSchema }, ["document"]),
    outputSchema: commandResultOutputSchema,
  }),
  defineProviderAction(service, {
    name: "dump_document",
    description: "Serialize a document or subtree into replayable OfficeCLI batch JSON.",
    inputSchema: s.actionInput(
      {
        document: documentPathSchema,
        path: s.nonEmptyString("The DOM subtree path to dump. Defaults to /."),
      },
      ["document"],
    ),
    outputSchema: commandResultOutputSchema,
  }),
  defineProviderAction(service, {
    name: "merge_template",
    description: "Create a document by replacing {{key}} placeholders in an OfficeCLI template.",
    inputSchema: s.actionInput(
      {
        template: documentPathSchema,
        outputDocument: documentPathSchema,
        data: s.unknownObject("Template values keyed by placeholder name."),
        force: s.boolean("Overwrite an existing output document. Defaults to false."),
      },
      ["template", "outputDocument", "data"],
    ),
    outputSchema: commandResultOutputSchema,
  }),
  defineProviderAction(service, {
    name: "get_schema_help",
    description: "Get OfficeCLI schema help for a document format or a specific element type.",
    inputSchema: s.actionInput(
      {
        format: s.stringEnum("The Office document format.", ["docx", "xlsx", "pptx"]),
        element: s.nonEmptyString("Optional element type, such as paragraph, cell, shape, chart, or table."),
      },
      ["format"],
    ),
    outputSchema: commandResultOutputSchema,
  }),
];
