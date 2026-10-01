import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "erpnext";

const doctypeField = s.nonEmptyString("The ERPNext DocType name to operate on.");
const documentNameField = s.nonEmptyString("The unique name of the ERPNext document.");
const fieldNamesField = s.anyOf("One field name or an array of field names to request from ERPNext.", [
  s.nonEmptyString("One field name to request from ERPNext."),
  s.stringArray("Field names to request from ERPNext.", {
    minItems: 1,
    itemDescription: "A field name to request from ERPNext.",
  }),
]);
const looseObjectSchema = s.looseObject("An ERPNext document or nested payload.");
const documentsOutputSchema = s.array("The ERPNext documents returned by the request.", looseObjectSchema);
const filtersSchema = s.anyOf("Filters passed through to ERPNext as JSON.", [
  s.record("A field-to-value filter object accepted by ERPNext.", s.unknown("A filter value.")),
  s.array(
    "An array of positional filter tuples accepted by ERPNext.",
    s.array("A positional filter tuple accepted by ERPNext.", s.unknown("A filter tuple value."), {
      minItems: 1,
    }),
    { minItems: 1 },
  ),
]);
const documentMutationSchema = s.record(
  "The document fields to create or update in ERPNext.",
  s.unknown("One ERPNext document field value."),
);
const fieldValueSchema = s.unknown("The field value or object returned by ERPNext.");

const getValueInputSchema = s.object(
  "The input payload for reading one or more ERPNext field values. Provide exactly one of name or filters.",
  {
    doctype: doctypeField,
    name: documentNameField,
    filters: filtersSchema,
    fieldname: fieldNamesField,
  },
  { optional: ["name", "filters"] },
);

export const erpnextActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_document_attachments",
    description:
      "List files attached to an ERPNext or Frappe document, including private resumes. Pass a returned file_url to download_file.",
    inputSchema: s.object(
      {
        doctype: doctypeField,
        name: documentNameField,
        start: s.integer("The zero-based attachment offset.", { minimum: 0 }),
        page_length: s.positiveInteger("Maximum attachments to return. Defaults to 20."),
      },
      { optional: ["start", "page_length"] },
    ),
    outputSchema: s.object(
      {
        attachments: s.array(
          s.object(
            {
              name: s.string("The File document identifier."),
              file_name: s.string("The attachment filename."),
              file_url: s.string(
                "Attachment path to pass to download_file. External links cannot be downloaded by this action.",
              ),
              is_private: s.integer("1 for a private attachment, 0 for a public attachment."),
              file_size: s.number("Attachment size in bytes."),
            },
            { required: ["name", "file_name", "file_url", "is_private", "file_size"] },
          ),
        ),
      },
      { required: ["attachments"] },
    ),
  }),
  defineProviderAction(service, {
    name: "download_file",
    description:
      "Download a public or private ERPNext/Frappe attachment such as a resume into temporary file storage. Requires file storage and permission to read the attachment.",
    inputSchema: s.object(
      {
        file_url: s.nonEmptyString(
          "The exact /files/... or /private/files/... path from an Attach field or list_document_attachments. External URLs are not supported.",
        ),
      },
      { required: ["file_url"] },
    ),
    outputSchema: s.object(
      {
        file: s.object(
          {
            fileId: s.string("Temporary file identifier."),
            downloadUrl: s.string("URL for downloading the stored attachment."),
            name: s.string("Attachment filename."),
            mimeType: s.string("Attachment MIME type."),
            sizeBytes: s.integer("Downloaded size in bytes.", { minimum: 0 }),
          },
          { required: ["fileId", "downloadUrl", "name", "mimeType", "sizeBytes"] },
        ),
      },
      { required: ["file"] },
    ),
  }),
  defineProviderAction(service, {
    name: "get_logged_user",
    description: "Get the currently authenticated ERPNext user for the configured connection.",
    inputSchema: s.object("The input payload for fetching the current ERPNext user.", {}),
    outputSchema: s.object("The authenticated ERPNext user returned by the server.", {
      user: s.string("The authenticated ERPNext user identifier."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_documents",
    description:
      "List ERPNext documents for a DocType with optional field selection, filters, sorting, and pagination.",
    inputSchema: s.object(
      "The input payload for listing ERPNext documents.",
      {
        doctype: doctypeField,
        fields: s.stringArray("The ERPNext document fields to include in the response.", {
          minItems: 1,
          itemDescription: "A document field to include in the list response.",
        }),
        filters: filtersSchema,
        order_by: s.nonEmptyString("The ERPNext order_by expression such as modified desc."),
        start: s.integer("The zero-based ERPNext list offset.", { minimum: 0 }),
        page_length: s.positiveInteger("The maximum number of ERPNext documents to return."),
      },
      { optional: ["fields", "filters", "order_by", "start", "page_length"] },
    ),
    outputSchema: s.object("The ERPNext documents returned by the list query.", {
      documents: documentsOutputSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "get_document",
    description: "Get one ERPNext document by DocType and name.",
    inputSchema: s.object("The input payload for fetching one ERPNext document.", {
      doctype: doctypeField,
      name: documentNameField,
    }),
    outputSchema: s.object("The ERPNext document returned by the request.", {
      document: looseObjectSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "create_document",
    description: "Create one ERPNext document for the specified DocType.",
    inputSchema: s.object("The input payload for creating an ERPNext document.", {
      doctype: doctypeField,
      data: documentMutationSchema,
    }),
    outputSchema: s.object("The created ERPNext document.", {
      document: looseObjectSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "update_document",
    description: "Update selected fields on one ERPNext document.",
    inputSchema: s.object("The input payload for updating an ERPNext document.", {
      doctype: doctypeField,
      name: documentNameField,
      fields: documentMutationSchema,
    }),
    outputSchema: s.object("The updated ERPNext document.", {
      document: looseObjectSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "delete_document",
    description: "Delete one ERPNext document by DocType and name.",
    inputSchema: s.object("The input payload for deleting one ERPNext document.", {
      doctype: doctypeField,
      name: documentNameField,
    }),
    outputSchema: s.object("The deletion status returned by ERPNext.", {
      ok: s.boolean("Whether ERPNext confirmed the document deletion."),
    }),
  }),
  defineProviderAction(service, {
    name: "get_document_count",
    description: "Get the count of ERPNext documents that match an optional filter.",
    inputSchema: s.object(
      "The input payload for counting ERPNext documents.",
      {
        doctype: doctypeField,
        filters: filtersSchema,
      },
      { optional: ["filters"] },
    ),
    outputSchema: s.object("The ERPNext document count.", {
      count: s.integer("The count returned by ERPNext.", { minimum: 0 }),
    }),
  }),
  defineProviderAction(service, {
    name: "get_document_value",
    description: "Get one ERPNext field value or a group of field values without loading the full document.",
    inputSchema: getValueInputSchema,
    outputSchema: s.object("The ERPNext field value or value object returned by the request.", {
      value: fieldValueSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "set_document_value",
    description: "Set one field value on an ERPNext document and return the updated document.",
    inputSchema: s.object("The input payload for updating one ERPNext field value.", {
      doctype: doctypeField,
      name: documentNameField,
      fieldname: s.nonEmptyString("The ERPNext field name to update."),
      value: fieldValueSchema,
    }),
    outputSchema: s.object("The ERPNext document returned after the update.", {
      document: looseObjectSchema,
    }),
  }),
];
