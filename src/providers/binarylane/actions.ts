import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "binarylane";

const noInputSchema = s.object("No input is required.", {});
const serverIdSchema = s.positiveInteger("BinaryLane server ID.");
const actionIdSchema = s.positiveInteger("BinaryLane asynchronous action ID.");
const pageSchema = s.positiveInteger("Page number to return.");
const perPageSchema = s.integer("Maximum number of results to return per page.", { minimum: 1, maximum: 200 });
const paginationInputFields = {
  page: pageSchema,
  perPage: perPageSchema,
};

const accountSchema = s.looseObject(
  {
    email: s.email("Email address registered for the BinaryLane account."),
    email_verified: s.boolean("Whether BinaryLane has verified the account email address."),
    two_factor_authentication_enabled: s.boolean("Whether app-based two-factor authentication is enabled."),
    status: s.stringEnum(["incomplete", "active", "warning", "locked"], {
      description: "Current BinaryLane account status.",
    }),
    configured_payment_methods: s.stringArray("Payment methods configured for the account."),
    additional_ipv4_limit: s.nonNegativeInteger("Maximum number of additional IPv4 addresses for the account."),
  },
  { description: "BinaryLane account profile." },
);

const serverSchema = s.looseObject(
  {
    id: serverIdSchema,
    name: s.nonEmptyString("Server hostname."),
    memory: s.nonNegativeInteger("Server memory in MB."),
    vcpus: s.nonNegativeInteger("Number of virtual CPUs."),
    disk: s.nonNegativeInteger("Total server disk capacity in GB."),
    vpc_id: s.nullableInteger("VPC ID, or null when the server uses the default public network."),
    created_at: s.dateTime("Timestamp when the server was created."),
    status: s.stringEnum(["new", "active", "archive", "off"], { description: "Current server status." }),
    size_slug: s.nonEmptyString("Slug of the server's selected size."),
    features: s.stringArray("Features currently enabled for the server."),
    region: s.looseObject("Region assigned to the server."),
    image: s.looseObject("Base image used to create the server."),
    size: s.looseObject("Current server size."),
    networks: s.looseObject("Public and private networks assigned to the server."),
  },
  { description: "BinaryLane server." },
);

const actionSchema = s.looseObject(
  {
    id: actionIdSchema,
    status: s.stringEnum(["in-progress", "completed", "errored"], {
      description: "Current asynchronous action status.",
    }),
    type: s.nonEmptyString("BinaryLane action type."),
    started_at: s.dateTime("Timestamp when action processing started."),
    completed_at: s.nullableString("Timestamp when action processing completed, or null while in progress.", {
      format: "date-time",
    }),
    resource_type: s.nullableString("Resource type associated with the action."),
    resource_id: s.nullableInteger("Resource ID associated with the action."),
    title: s.nonEmptyString("Short display name for the action."),
    reason: s.string("User-friendly explanation of the action state."),
    progress: s.looseObject("Progress reported by BinaryLane."),
    result_data: s.nullableString("Result returned by a completed query action."),
  },
  { description: "BinaryLane asynchronous action." },
);

const metaSchema = s.looseObject(
  { total: s.nonNegativeInteger("Total number of matching records.") },
  { description: "BinaryLane pagination metadata." },
);
const linksSchema = s.nullable(s.looseObject("BinaryLane pagination links."));

const regionSchema = s.looseObject(
  {
    slug: s.nonEmptyString("Unique region slug."),
    name: s.nonEmptyString("Region display name."),
    sizes: s.stringArray("Size slugs available in the region."),
    available: s.boolean("Whether the region accepts new resources."),
    features: s.stringArray("Features offered by the region."),
    name_servers: s.stringArray("Nameservers available in the region."),
  },
  { description: "BinaryLane region." },
);

const sizeSchema = s.looseObject(
  {
    slug: s.nonEmptyString("Unique size slug."),
    description: s.nullableString("Human-readable size description."),
    available: s.boolean("Whether the size is available for new servers."),
    regions: s.stringArray("Region slugs where the size is offered."),
    price_monthly: s.number("Monthly price in Australian dollars.", { minimum: 0 }),
    price_hourly: s.number("Hourly price in Australian dollars.", { minimum: 0 }),
    disk: s.nonNegativeInteger("Included storage in GB."),
    memory: s.nonNegativeInteger("Included memory in MB."),
    transfer: s.number("Included data transfer in TB.", { minimum: 0 }),
    vcpus: s.nonNegativeInteger("Number of virtual CPUs."),
    vcpu_units: s.nonEmptyString("Unit represented by the virtual CPU count."),
  },
  { description: "BinaryLane server size." },
);

const serverInputSchema = s.actionInput({ serverId: serverIdSchema }, ["serverId"], "Target BinaryLane server.");
const actionOutputSchema = s.actionOutput(
  {
    accepted: s.literal(true, { description: "Whether BinaryLane accepted the command." }),
    action: s.nullable(actionSchema),
  },
  "BinaryLane server command acknowledgement. Action can be null when BinaryLane accepts the command without a response body.",
);
const actionLifecycleStatus = "binarylane.get_action";

export const binaryLaneActions: readonly ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_account",
    description: "Get the BinaryLane account profile associated with the configured Nova API key.",
    inputSchema: noInputSchema,
    outputSchema: s.actionOutput({ account: accountSchema }, "Current BinaryLane account."),
  }),
  defineProviderAction(service, {
    name: "list_servers",
    description: "List BinaryLane servers with pagination and an optional exact hostname filter.",
    inputSchema: s.object(
      "Filters and pagination for BinaryLane servers.",
      {
        hostname: s.nonEmptyString("Only return the server with this hostname, matched case-insensitively."),
        ...paginationInputFields,
      },
      { optional: ["hostname", "page", "perPage"] },
    ),
    outputSchema: collectionOutputSchema("servers", "Servers returned for the current page.", serverSchema),
    followUpActions: ["binarylane.get_server"],
  }),
  defineProviderAction(service, {
    name: "get_server",
    description: "Get one BinaryLane server by numeric server ID.",
    inputSchema: serverInputSchema,
    outputSchema: s.actionOutput({ server: serverSchema }, "Selected BinaryLane server."),
    followUpActions: ["binarylane.list_server_actions"],
  }),
  defineProviderAction(service, {
    name: "list_server_actions",
    description: "List recent asynchronous actions for a BinaryLane server.",
    inputSchema: s.object(
      "Server and pagination for BinaryLane actions.",
      { serverId: serverIdSchema, ...paginationInputFields },
      { required: ["serverId"], optional: ["page", "perPage"] },
    ),
    outputSchema: collectionOutputSchema("actions", "Actions returned for the current page.", actionSchema),
    followUpActions: ["binarylane.get_action"],
  }),
  defineProviderAction(service, {
    name: "get_action",
    description: "Get the current state and result of a BinaryLane asynchronous action.",
    inputSchema: s.actionInput({ actionId: actionIdSchema }, ["actionId"], "Target BinaryLane action."),
    outputSchema: s.actionOutput({ action: actionSchema }, "Selected BinaryLane action."),
  }),
  serverCommandAction("ping_server", "Ask BinaryLane to ping a server and return an asynchronous action."),
  serverCommandAction(
    "get_server_uptime",
    "Ask BinaryLane to retrieve a server's uptime and return an asynchronous action.",
  ),
  serverCommandAction("power_on_server", "Power on a BinaryLane server."),
  serverCommandAction("power_off_server", "Immediately power off a BinaryLane server."),
  serverCommandAction("reboot_server", "Request an operating-system reboot for a BinaryLane server."),
  serverCommandAction("shutdown_server", "Request an operating-system shutdown for a BinaryLane server."),
  serverCommandAction("power_cycle_server", "Power a BinaryLane server off and then back on."),
  defineProviderAction(service, {
    name: "list_regions",
    description: "List BinaryLane regions and the sizes and features offered by each region.",
    inputSchema: paginationInputSchema("Pagination for BinaryLane regions."),
    outputSchema: collectionOutputSchema("regions", "Regions returned for the current page.", regionSchema),
    followUpActions: ["binarylane.list_sizes"],
  }),
  defineProviderAction(service, {
    name: "list_sizes",
    description: "List BinaryLane server sizes, optionally restricted to a server resize or operating-system image.",
    inputSchema: s.object(
      "Filters and pagination for BinaryLane sizes.",
      {
        serverId: s.positiveInteger("Only return sizes available when resizing this server."),
        image: s.anyOf("Operating-system image ID or slug used to restrict compatible regions.", [
          s.positiveInteger("Operating-system image ID."),
          s.nonEmptyString("Operating-system image slug."),
        ]),
        ...paginationInputFields,
      },
      { optional: ["serverId", "image", "page", "perPage"] },
    ),
    outputSchema: collectionOutputSchema("sizes", "Sizes returned for the current page.", sizeSchema),
  }),
];

function paginationInputSchema(description: string): JsonSchema {
  return s.object(description, paginationInputFields, { optional: ["page", "perPage"] });
}

function collectionOutputSchema(key: string, description: string, itemSchema: JsonSchema): JsonSchema {
  return s.object(
    `Paginated BinaryLane ${key} response.`,
    {
      [key]: s.array(description, itemSchema),
      meta: metaSchema,
      links: linksSchema,
    },
    { required: [key, "meta"], optional: ["links"] },
  );
}

function serverCommandAction(name: string, description: string) {
  return defineProviderAction(service, {
    name,
    description,
    inputSchema: serverInputSchema,
    outputSchema: actionOutputSchema,
    followUpActions: ["binarylane.get_action", "binarylane.get_server"],
    asyncLifecycle: {
      startActionId: `${service}.${name}`,
      statusActionId: actionLifecycleStatus,
    },
  });
}
