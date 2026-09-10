import type { JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import {
  deviceCheckinSchema,
  deviceRecordSchema,
  historyEventSchema,
  requestRecordSchema,
  ticketRecordSchema,
} from "./resource-schemas.ts";

export type AssetGatewayMethod = "GET" | "POST" | "PATCH";
export type AssetGatewayResponseKind = "metadata" | "list" | "record" | "created_record" | "cursor_page" | "comment";

export interface AssetGatewayQueryField {
  input: string;
  parameter: string;
}

export interface AssetGatewayOperation {
  name: string;
  description: string;
  method: AssetGatewayMethod;
  path: string;
  pathField?: string;
  queryFields?: readonly AssetGatewayQueryField[];
  bodyField?: string;
  etagField?: string;
  responseKind: AssetGatewayResponseKind;
  outputField?: string;
  permission: "read" | "write";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  followUpActions?: readonly string[];
}

interface AssetGatewayResourceDefinition {
  path: string;
  singular: string;
  plural: string;
  label: string;
  idField: string;
  bodyField: string;
  createSchema: JsonSchema;
  updateSchema: JsonSchema;
  recordSchema: JsonSchema;
  listFilter: AssetGatewayQueryField;
  listFilterSchema: JsonSchema;
  supportsEnrollmentFilter?: boolean;
}

const managementApiPrefix = "asset_gateway.";
const dateOrEmpty = (description: string): JsonSchema =>
  s.anyOf(description, [s.date("A date in YYYY-MM-DD format."), s.literal("", { description: "Clear the date." })]);
const optionalLinkId = (description: string): JsonSchema => s.nullable(s.positiveInteger(description));

const commonAssetFields = {
  allocated_to: s.string({ description: "The person or account to which the asset is allocated.", maxLength: 250 }),
  purchased_on: dateOrEmpty("The purchase date, or an empty string to clear it."),
  warranty_until: dateOrEmpty("The warranty end date, or an empty string to clear it."),
  warranty_provider: s.string({ description: "The warranty provider.", maxLength: 250 }),
  reseller: s.string({ description: "The reseller or supplier.", maxLength: 250 }),
  order_reference: s.string({ description: "The purchase order or reseller reference.", maxLength: 250 }),
};

const requestFields = {
  company_name: s.nonWhitespaceString(
    "The company name. Required for all-company tokens and immutable after creation.",
    { maxLength: 250 },
  ),
  title: s.nonWhitespaceString("The request title.", { maxLength: 250 }),
  description: s.string({ description: "The request description.", maxLength: 10_000 }),
  enrollment_id: optionalLinkId("A linked device ID in the same company, or null to unlink it."),
  status: s.stringEnum("The request status. Purchase and delivery dates are required for later statuses.", [
    "Requested",
    "Sourcing",
    "Approved",
    "Ordered",
    "Delivered",
    "Allocated",
    "Cancelled",
  ]),
  asset_type: s.nonWhitespaceString("An asset type name returned by get_metadata.", { maxLength: 250 }),
  license_type: s.stringEnum("The licence type for software requests.", ["", "Subscription", "Perpetual"]),
  renewal_on: dateOrEmpty("The software licence renewal date, or an empty string to clear it."),
  template_id: optionalLinkId("A same-company asset template ID, or null to unlink it."),
  recipient: s.nonWhitespaceString("The intended recipient.", { maxLength: 250 }),
  reseller: commonAssetFields.reseller,
  reseller_options: s.string({ description: "Reseller options or quotation detail.", maxLength: 10_000 }),
  order_reference: commonAssetFields.order_reference,
  purchased_on: commonAssetFields.purchased_on,
  expected_on: dateOrEmpty("The expected delivery date, or an empty string to clear it."),
  delivered_on: dateOrEmpty("The delivery date, or an empty string to clear it."),
  warranty_until: commonAssetFields.warranty_until,
  warranty_provider: commonAssetFields.warranty_provider,
};

const ticketFields = {
  company_name: s.nonWhitespaceString(
    "The company name. Required for all-company tokens and immutable after creation.",
    { maxLength: 250 },
  ),
  title: s.nonWhitespaceString("The ticket title.", { maxLength: 250 }),
  description: s.string({ description: "The ticket description.", maxLength: 10_000 }),
  enrollment_id: optionalLinkId("A linked device ID in the same company, or null to unlink it."),
  status: s.stringEnum("The ticket status.", ["Open", "In progress", "Waiting", "Resolved", "Closed"]),
  assigned_to: s.string({ description: "The person assigned to the ticket.", maxLength: 250 }),
  priority: s.stringEnum("The ticket priority.", ["Low", "Normal", "High", "Urgent"]),
};

const deviceFields = {
  company_name: s.nonWhitespaceString(
    "The company name. Required for all-company tokens and immutable after creation.",
    { maxLength: 250 },
  ),
  device_label: s.nonWhitespaceString("The device label.", { maxLength: 250 }),
  location: s.string({ description: "The device location.", maxLength: 250 }),
  active: s.boolean("Whether enrollment and device-agent check-in remain enabled."),
  ...commonAssetFields,
};

const requestCreateSchema = s.object("The asset request to create.", requestFields, {
  required: ["title", "recipient"],
});
const requestUpdateSchema = updateSchema(
  "The request fields to update. Omitted fields are preserved.",
  withoutCompanyName(requestFields),
);
const ticketCreateSchema = s.object("The support ticket to create.", ticketFields, { required: ["title"] });
const ticketUpdateSchema = updateSchema(
  "The ticket fields to update. Omitted fields are preserved.",
  withoutCompanyName(ticketFields),
);
const deviceCreateSchema = s.object("The device inventory record to create.", deviceFields, {
  required: ["device_label"],
});
const deviceUpdateSchema = updateSchema(
  "The device fields to update. Agent telemetry is read-only.",
  withoutCompanyName(deviceFields),
);

const resources: AssetGatewayResourceDefinition[] = [
  {
    path: "/requests",
    singular: "request",
    plural: "requests",
    label: "asset request",
    idField: "requestId",
    bodyField: "request",
    createSchema: requestCreateSchema,
    updateSchema: requestUpdateSchema,
    recordSchema: requestRecordSchema,
    listFilter: { input: "status", parameter: "status" },
    listFilterSchema: requestFields.status,
    supportsEnrollmentFilter: true,
  },
  {
    path: "/tickets",
    singular: "ticket",
    plural: "tickets",
    label: "support ticket",
    idField: "ticketId",
    bodyField: "ticket",
    createSchema: ticketCreateSchema,
    updateSchema: ticketUpdateSchema,
    recordSchema: ticketRecordSchema,
    listFilter: { input: "status", parameter: "status" },
    listFilterSchema: ticketFields.status,
    supportsEnrollmentFilter: true,
  },
  {
    path: "/devices",
    singular: "device",
    plural: "devices",
    label: "device",
    idField: "deviceId",
    bodyField: "device",
    createSchema: deviceCreateSchema,
    updateSchema: deviceUpdateSchema,
    recordSchema: deviceRecordSchema,
    listFilter: { input: "active", parameter: "active" },
    listFilterSchema: s.boolean("Filter by active or inactive devices."),
  },
];

export const assetGatewayOperations: readonly AssetGatewayOperation[] = [
  {
    name: "get_metadata",
    description:
      "Get visible companies, asset types, templates, statuses, and priorities. Use this before creating records instead of guessing editable values.",
    method: "GET",
    path: "/metadata",
    responseKind: "metadata",
    permission: "read",
    inputSchema: s.actionInput({}),
    outputSchema: s.actionOutput({
      companies: s.array("Companies visible to the management token.", s.unknownObject("One company.")),
      assetTypes: s.array("Configured asset types.", s.unknownObject("One asset type.")),
      assetTemplates: s.array("Visible asset templates.", s.unknownObject("One asset template.")),
      statuses: s.unknownObject("Allowed request and ticket statuses."),
      priorities: s.stringArray("Allowed ticket priorities."),
    }),
  },
  ...resources.flatMap(createResourceOperations),
  {
    name: "list_device_checkins",
    description:
      "List up to 200 stored check-in log entries for one device, newest first. These are historical agent reports, not a live network scan.",
    method: "GET",
    path: "/devices/{id}/checkins",
    pathField: "deviceId",
    queryFields: [{ input: "beforeId", parameter: "before_id" }],
    responseKind: "cursor_page",
    outputField: "checkins",
    permission: "read",
    inputSchema: s.object(
      "Check-in log lookup for one device.",
      {
        deviceId: s.positiveInteger("The device ID."),
        beforeId: s.positiveInteger("The next_before_id from the previous page."),
      },
      { required: ["deviceId"] },
    ),
    outputSchema: s.actionOutput({
      checkins: s.array("Stored device check-ins, newest first.", deviceCheckinSchema),
      nextBeforeId: s.nullableInteger("The cursor for the next page, or null when no more check-ins remain."),
    }),
    followUpActions: ["asset_gateway.get_device"],
  },
];

function createResourceOperations(resource: AssetGatewayResourceDefinition): AssetGatewayOperation[] {
  const recordId = s.positiveInteger(`The ${resource.label} ID.`);
  const listFilters: Record<string, JsonSchema> = {
    q: s.nonWhitespaceString(`Search ${resource.plural} by their indexed text fields.`),
    companyName: s.nonWhitespaceString("Only return records for this visible company."),
    [resource.listFilter.input]: resource.listFilterSchema,
    limit: s.integer({
      description: "The maximum number of records to return.",
      minimum: 1,
      maximum: 200,
      default: 50,
    }),
    offset: s.nonNegativeInteger("The zero-based record offset.", { default: 0 }),
  };
  const queryFields: AssetGatewayQueryField[] = [
    { input: "q", parameter: "q" },
    { input: "companyName", parameter: "company_name" },
    resource.listFilter,
  ];
  if (resource.supportsEnrollmentFilter) {
    listFilters.enrollmentId = s.positiveInteger("Only return records linked to this device ID.");
    queryFields.push({ input: "enrollmentId", parameter: "enrollment_id" });
  }
  queryFields.push({ input: "limit", parameter: "limit" }, { input: "offset", parameter: "offset" });
  const recordOutput = (created: boolean): JsonSchema =>
    s.object(
      `The ${resource.label} response with its concurrency revision.`,
      {
        [resource.singular]: resource.recordSchema,
        revision: s.nonEmptyString("The record revision hash."),
        etag: s.nonEmptyString("The ETag, including quotes, to use for a later update."),
        location: s.nonEmptyString("The relative API location of the created record."),
      },
      { optional: created ? [] : ["location"] },
    );
  const getAction = `${managementApiPrefix}get_${resource.singular}`;
  const historyAction = `${managementApiPrefix}list_${resource.singular}_history`;

  return [
    {
      name: `list_${resource.plural}`,
      description:
        resource.singular === "device"
          ? "List and search devices with their latest hardware, OS, network, location, agent, Tailscale, virtualization, SSH public-key, and group inventory, ordered newest first."
          : `List and search ${resource.plural} visible to the management token, ordered newest first. Use enrollmentId to return records linked to one device.`,
      method: "GET",
      path: resource.path,
      queryFields,
      responseKind: "list",
      outputField: resource.plural,
      permission: "read",
      inputSchema: s.object(`Filters for listing ${resource.plural}.`, listFilters, {
        optional: Object.keys(listFilters),
      }),
      outputSchema: s.actionOutput({
        [resource.plural]: s.array(`The returned ${resource.plural}.`, resource.recordSchema),
        total: s.nonNegativeInteger("The total matching record count."),
        limit: s.positiveInteger("The applied page size."),
        offset: s.nonNegativeInteger("The applied record offset."),
      }),
      followUpActions: [getAction],
    },
    {
      name: `create_${resource.singular}`,
      description: `Create one ${resource.label}. This is not idempotent; reconcile an ambiguous timeout before retrying.`,
      method: "POST",
      path: resource.path,
      bodyField: resource.bodyField,
      responseKind: "created_record",
      outputField: resource.singular,
      permission: "write",
      inputSchema: s.actionInput({ [resource.bodyField]: resource.createSchema }, [resource.bodyField]),
      outputSchema: recordOutput(true),
      followUpActions: [getAction, historyAction],
    },
    {
      name: `get_${resource.singular}`,
      description:
        resource.singular === "device"
          ? "Get one device with hardware, OS, network, location, allocation, purchase/warranty, agent status, Tailscale, virtualization, SSH public-key, and group inventory, plus the ETag required for a conflict-safe update. Use enrollmentId with list_requests or list_tickets to read linked records."
          : `Get one ${resource.label} and the ETag required for a conflict-safe update.`,
      method: "GET",
      path: `${resource.path}/{id}`,
      pathField: resource.idField,
      responseKind: "record",
      outputField: resource.singular,
      permission: "read",
      inputSchema: s.actionInput({ [resource.idField]: recordId }, [resource.idField]),
      outputSchema: recordOutput(false),
      followUpActions:
        resource.singular === "device"
          ? [
              `${managementApiPrefix}update_device`,
              historyAction,
              `${managementApiPrefix}list_device_checkins`,
              `${managementApiPrefix}list_requests`,
              `${managementApiPrefix}list_tickets`,
            ]
          : [`${managementApiPrefix}update_${resource.singular}`, historyAction],
    },
    {
      name: `update_${resource.singular}`,
      description: `Update supplied fields on one ${resource.label}. Call get_${resource.singular} first and pass its current ETag; omitted fields are preserved.`,
      method: "PATCH",
      path: `${resource.path}/{id}`,
      pathField: resource.idField,
      bodyField: "changes",
      etagField: "etag",
      responseKind: "record",
      outputField: resource.singular,
      permission: "write",
      inputSchema: s.actionInput(
        {
          [resource.idField]: recordId,
          etag: s.nonWhitespaceString("The current ETag returned by get, including its quotes."),
          changes: resource.updateSchema,
        },
        [resource.idField, "etag", "changes"],
      ),
      outputSchema: recordOutput(false),
      followUpActions: [getAction, historyAction],
    },
    {
      name: `list_${resource.singular}_history`,
      description: `List up to 200 history events and internal comments for one ${resource.label}, newest first.`,
      method: "GET",
      path: `${resource.path}/{id}/history`,
      pathField: resource.idField,
      queryFields: [{ input: "beforeId", parameter: "before_id" }],
      responseKind: "cursor_page",
      outputField: "events",
      permission: "read",
      inputSchema: s.object(
        `History lookup for one ${resource.label}.`,
        {
          [resource.idField]: recordId,
          beforeId: s.positiveInteger("The next_before_id from the previous page."),
        },
        { required: [resource.idField] },
      ),
      outputSchema: s.actionOutput({
        events: s.array("History events, newest first.", historyEventSchema),
        nextBeforeId: s.nullableInteger("The cursor for the next page, or null when no more events remain."),
      }),
    },
    {
      name: `add_${resource.singular}_comment`,
      description: `Add an internal comment to one ${resource.label}. This is not idempotent; reconcile an ambiguous timeout before retrying.`,
      method: "POST",
      path: `${resource.path}/{id}/comments`,
      pathField: resource.idField,
      bodyField: "comment",
      responseKind: "comment",
      permission: "write",
      inputSchema: s.actionInput(
        {
          [resource.idField]: recordId,
          comment: s.object("The internal comment to add.", {
            body: s.nonWhitespaceString("The comment body.", { maxLength: 10_000 }),
          }),
        },
        [resource.idField, "comment"],
      ),
      outputSchema: s.actionOutput({ ok: s.boolean("Whether the comment was accepted.") }),
      followUpActions: [historyAction],
    },
  ];
}

function updateSchema(description: string, properties: Record<string, JsonSchema>): JsonSchema {
  const schema = s.object(description, properties, { optional: Object.keys(properties) });
  schema.minProperties = 1;
  return schema;
}

function withoutCompanyName(properties: Record<string, JsonSchema>): Record<string, JsonSchema> {
  return Object.fromEntries(Object.entries(properties).filter(([name]) => name !== "company_name"));
}
