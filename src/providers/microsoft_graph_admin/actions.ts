import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { microsoftGraphAdminProviderScopes } from "./scopes.ts";

const service = "microsoft_graph_admin";

interface MicrosoftGraphAdminActionSource {
  name: string;
  description: string;
  requiredScopes: string[];
  providerPermissions: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const graphObject = s.record(true, { description: "A Microsoft Graph resource." });
const userId = s.nonEmptyString("Microsoft Entra user ID or user principal name.");
const skuId = s.uuid("Microsoft 365 subscribed SKU ID.");
const fieldNames = s.array(s.nonEmptyString("Microsoft Graph field name."), {
  minItems: 1,
  description: "Fields to request from Microsoft Graph.",
});
const nextLink = s.url("Opaque Microsoft Graph pagination URL returned by a previous response.");
const user = s.looseObject(
  {
    id: s.nonEmptyString("Microsoft Entra user ID."),
    accountEnabled: s.boolean("Whether sign-in is enabled."),
    displayName: s.string("User display name."),
    userPrincipalName: s.string("User principal name."),
    mail: s.nullableString("Primary email address."),
    mailNickname: s.string("Mail alias."),
    givenName: s.nullableString("Given name."),
    surname: s.nullableString("Surname."),
    jobTitle: s.nullableString("Job title."),
    department: s.nullableString("Department."),
    officeLocation: s.nullableString("Office location."),
    mobilePhone: s.nullableString("Mobile phone number."),
    businessPhones: s.array(s.string("Business phone number.")),
    usageLocation: s.nullableString("ISO 3166 two-letter usage location used for license assignment."),
  },
  { description: "Microsoft Entra user account." },
);
const passwordProfile = s.object(
  {
    password: s.string({ minLength: 8, maxLength: 256, description: "Temporary or replacement password." }),
    forceChangePasswordNextSignIn: s.boolean("Require the user to change the password at next sign-in."),
    forceChangePasswordNextSignInWithMfa: s.boolean("Require MFA before changing the password at next sign-in."),
  },
  { required: ["password"], description: "Microsoft Entra password profile." },
);
const licenseAssignment = s.object(
  {
    skuId,
    disabledPlans: s.array(s.uuid("Service plan ID to disable within this license."), {
      description: "Service plan IDs to disable. Defaults to none.",
    }),
  },
  { required: ["skuId"], description: "License to add to the user." },
);

function input(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, "Microsoft Graph Admin action input.");
}

function collectionOutput(key: string, description: string): JsonSchema {
  return s.object(
    {
      [key]: s.array(graphObject, { description }),
      nextLink: s.nullableString("Pagination URL for the next page, or null when there is no next page."),
    },
    { required: [key, "nextLink"], description },
  );
}

const actions: MicrosoftGraphAdminActionSource[] = [
  action(
    "list_users",
    "List and search Microsoft 365 user accounts in the connected tenant.",
    [microsoftGraphAdminProviderScopes.userReadAll],
    input({
      top: s.integer({ minimum: 1, maximum: 999, description: "Maximum users to return on this page." }),
      select: fieldNames,
      filter: s.string("Microsoft Graph OData user filter."),
      search: s.string('Microsoft Graph user search expression, such as "displayName:Alex".'),
      orderBy: s.string("Microsoft Graph user ordering expression."),
      count: s.boolean("Include the total matching user count."),
      nextLink,
    }),
    collectionOutput("users", "Microsoft 365 users returned by Microsoft Graph."),
  ),
  action(
    "get_user",
    "Get one Microsoft 365 user account by ID or user principal name.",
    [microsoftGraphAdminProviderScopes.userReadAll],
    input({ userId, select: fieldNames }, ["userId"]),
    user,
  ),
  action(
    "create_user",
    "Create a Microsoft 365 user account with an initial password.",
    [microsoftGraphAdminProviderScopes.userReadWriteAll],
    input(
      {
        accountEnabled: s.boolean("Whether the new account can sign in."),
        displayName: s.nonEmptyString("Display name for the new user."),
        mailNickname: s.nonEmptyString("Mail alias for the new user."),
        userPrincipalName: s.nonEmptyString("User principal name, including a verified tenant domain."),
        passwordProfile,
        givenName: s.string("Given name."),
        surname: s.string("Surname."),
        jobTitle: s.string("Job title."),
        department: s.string("Department."),
        officeLocation: s.string("Office location."),
        mobilePhone: s.string("Mobile phone number."),
        businessPhones: s.array(s.string("Business phone number.")),
        usageLocation: s.string({
          minLength: 2,
          maxLength: 2,
          description: "ISO 3166 two-letter usage location required before many licenses can be assigned.",
        }),
      },
      ["accountEnabled", "displayName", "mailNickname", "userPrincipalName", "passwordProfile"],
    ),
    user,
  ),
  action(
    "update_user",
    "Update profile, user principal name, or usage location fields on a Microsoft 365 user account.",
    [microsoftGraphAdminProviderScopes.userReadWriteAll],
    input(
      {
        userId,
        displayName: s.string("Display name."),
        mailNickname: s.string("Mail alias."),
        userPrincipalName: s.string("User principal name."),
        givenName: s.nullableString("Given name, or null to clear it."),
        surname: s.nullableString("Surname, or null to clear it."),
        jobTitle: s.nullableString("Job title, or null to clear it."),
        department: s.nullableString("Department, or null to clear it."),
        officeLocation: s.nullableString("Office location, or null to clear it."),
        usageLocation: s.nullableString("ISO 3166 two-letter usage location, or null to clear it."),
      },
      ["userId"],
    ),
    user,
  ),
  action(
    "set_user_account_enabled",
    "Enable or block sign-in for a Microsoft 365 user account.",
    [microsoftGraphAdminProviderScopes.userEnableDisableAccountAll, microsoftGraphAdminProviderScopes.userReadAll],
    input(
      {
        userId,
        accountEnabled: s.boolean("Whether the user account can sign in."),
      },
      ["userId", "accountEnabled"],
    ),
    s.requiredObject("Account sign-in state update confirmation.", {
      updated: s.literal(true, { description: "Whether Microsoft Graph accepted the update." }),
      userId,
      accountEnabled: s.boolean("Whether the user account can sign in."),
    }),
  ),
  action(
    "reset_user_password",
    "Set a replacement password for a Microsoft 365 user account.",
    [microsoftGraphAdminProviderScopes.userPasswordProfileReadWriteAll],
    input({ userId, passwordProfile }, ["userId", "passwordProfile"]),
    s.requiredObject("Password reset confirmation.", {
      updated: s.literal(true, { description: "Whether Microsoft Graph accepted the password reset." }),
      userId,
    }),
  ),
  action(
    "delete_user",
    "Delete a Microsoft 365 user account from the active directory.",
    [microsoftGraphAdminProviderScopes.userReadWriteAll],
    input({ userId }, ["userId"]),
    s.requiredObject("Deleted user confirmation.", {
      deleted: s.literal(true, { description: "Whether Microsoft Graph accepted the deletion." }),
      userId,
    }),
  ),
  action(
    "list_subscribed_skus",
    "List Microsoft 365 products and license capacity subscribed by the tenant.",
    [microsoftGraphAdminProviderScopes.licenseAssignmentReadAll],
    input({ select: fieldNames, nextLink }),
    collectionOutput("skus", "Subscribed Microsoft 365 products returned by Microsoft Graph."),
  ),
  action(
    "list_user_licenses",
    "List the licenses and service plans assigned to one Microsoft 365 user.",
    [microsoftGraphAdminProviderScopes.licenseAssignmentReadAll],
    input({ userId, nextLink }, ["userId"]),
    collectionOutput("licenses", "License details assigned to the user."),
  ),
  action(
    "assign_user_licenses",
    "Add or remove Microsoft 365 licenses on one user in a single Graph operation.",
    [microsoftGraphAdminProviderScopes.licenseAssignmentReadWriteAll],
    input(
      {
        userId,
        addLicenses: s.array(licenseAssignment, { description: "Licenses to add or update on the user." }),
        removeLicenses: s.array(skuId, { description: "SKU IDs to remove from the user." }),
      },
      ["userId", "addLicenses", "removeLicenses"],
    ),
    user,
  ),
];

export const microsoftGraphAdminActions: ActionDefinition[] = actions.map((item) =>
  defineProviderAction(service, item),
);

function action(
  name: string,
  description: string,
  scopes: string[],
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): MicrosoftGraphAdminActionSource {
  return {
    name,
    description,
    requiredScopes: scopes,
    providerPermissions: scopes,
    inputSchema,
    outputSchema,
  };
}
