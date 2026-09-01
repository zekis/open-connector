import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { MicrosoftGraphAdminActionHandler, MicrosoftGraphAdminRuntimeDeps } from "./graph-client.ts";

import { compactObject, optionalBoolean, optionalString, requiredRecord, requiredString } from "../../core/cast.ts";
import { encodePathSegment } from "../../core/request.ts";
import { defineOAuthProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import {
  microsoftGraphAdminCollectionRequest,
  microsoftGraphAdminJsonRequest,
  microsoftGraphAdminRequest,
} from "./graph-client.ts";

const service = "microsoft_graph_admin";
const defaultUserSelect =
  "id,accountEnabled,displayName,userPrincipalName,mail,mailNickname,givenName,surname,jobTitle,department,officeLocation,mobilePhone,businessPhones,usageLocation";
const createUserFields = [
  "accountEnabled",
  "displayName",
  "mailNickname",
  "userPrincipalName",
  "passwordProfile",
  "givenName",
  "surname",
  "jobTitle",
  "department",
  "officeLocation",
  "mobilePhone",
  "businessPhones",
  "usageLocation",
];
const mutableUserFields = [
  "displayName",
  "mailNickname",
  "userPrincipalName",
  "givenName",
  "surname",
  "jobTitle",
  "department",
  "officeLocation",
  "usageLocation",
];

export const microsoftGraphAdminActionHandlers: Record<string, MicrosoftGraphAdminActionHandler> = {
  list_users(input, deps) {
    return listUsers(input, deps);
  },
  get_user(input, deps) {
    return getUser(input, deps);
  },
  create_user(input, deps) {
    return createUser(input, deps);
  },
  update_user(input, deps) {
    return updateUser(input, deps);
  },
  set_user_account_enabled(input, deps) {
    return setUserAccountEnabled(input, deps);
  },
  reset_user_password(input, deps) {
    return resetUserPassword(input, deps);
  },
  delete_user(input, deps) {
    return deleteUser(input, deps);
  },
  list_subscribed_skus(input, deps) {
    return listSubscribedSkus(input, deps);
  },
  list_user_licenses(input, deps) {
    return listUserLicenses(input, deps);
  },
  assign_user_licenses(input, deps) {
    return assignUserLicenses(input, deps);
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, microsoftGraphAdminActionHandlers);

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const currentAccount = await microsoftGraphAdminJsonRequest<{
      id?: unknown;
      displayName?: unknown;
      mail?: unknown;
      userPrincipalName?: unknown;
    }>(
      "me",
      { accessToken: input.accessToken, tokenType: input.tokenType, fetcher, signal },
      { query: { $select: "id,displayName,mail,userPrincipalName" } },
    );
    const accountId = requiredString(currentAccount.id, "Microsoft Graph Admin current account ID");
    return {
      profile: {
        accountId,
        displayName:
          optionalString(currentAccount.mail) ??
          optionalString(currentAccount.userPrincipalName) ??
          optionalString(currentAccount.displayName) ??
          accountId,
      },
      metadata: { currentAccount },
    };
  },
};

async function listUsers(input: Record<string, unknown>, deps: MicrosoftGraphAdminRuntimeDeps): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const advancedQuery = input.count === true || optionalString(input.search) !== undefined;
  const result = await microsoftGraphAdminCollectionRequest(nextLink ?? "users", deps, {
    nextLinkKind: "users",
    headers: advancedQuery && !nextLink ? { ConsistencyLevel: "eventual" } : undefined,
    query: nextLink
      ? undefined
      : compactObject({
          $top: typeof input.top === "number" ? input.top : undefined,
          $select: stringList(input.select) ?? defaultUserSelect,
          $filter: optionalString(input.filter),
          $search: optionalString(input.search),
          $orderby: optionalString(input.orderBy),
          $count: optionalBoolean(input.count),
        }),
  });
  return { users: result.items, nextLink: result.nextLink };
}

async function getUser(input: Record<string, unknown>, deps: MicrosoftGraphAdminRuntimeDeps): Promise<unknown> {
  return microsoftGraphAdminJsonRequest(`users/${userPathId(input)}`, deps, {
    query: { $select: stringList(input.select) ?? defaultUserSelect },
  });
}

async function createUser(input: Record<string, unknown>, deps: MicrosoftGraphAdminRuntimeDeps): Promise<unknown> {
  return microsoftGraphAdminJsonRequest("users", deps, {
    method: "POST",
    body: userMutation(input, createUserFields),
  });
}

async function setUserAccountEnabled(
  input: Record<string, unknown>,
  deps: MicrosoftGraphAdminRuntimeDeps,
): Promise<unknown> {
  const id = requiredString(input.userId, "userId");
  const accountEnabled = optionalBoolean(input.accountEnabled);
  if (accountEnabled === undefined) throw new ProviderRequestError(400, "accountEnabled is required.");
  await microsoftGraphAdminRequest(`users/${encodePathSegment(id)}`, deps, {
    method: "PATCH",
    body: { accountEnabled },
  });
  return { updated: true, userId: id, accountEnabled };
}

async function resetUserPassword(
  input: Record<string, unknown>,
  deps: MicrosoftGraphAdminRuntimeDeps,
): Promise<unknown> {
  const id = requiredString(input.userId, "userId");
  const passwordProfile = requiredRecord(input.passwordProfile, "passwordProfile");
  await microsoftGraphAdminRequest(`users/${encodePathSegment(id)}`, deps, {
    method: "PATCH",
    body: { passwordProfile },
  });
  return { updated: true, userId: id };
}

async function updateUser(input: Record<string, unknown>, deps: MicrosoftGraphAdminRuntimeDeps): Promise<unknown> {
  const body = userMutation(input);
  if (Object.keys(body).length === 0) {
    throw new ProviderRequestError(400, "update_user requires at least one user field to change.");
  }
  const path = `users/${userPathId(input)}`;
  await microsoftGraphAdminRequest(path, deps, { method: "PATCH", body });
  return microsoftGraphAdminJsonRequest(path, deps, { query: { $select: defaultUserSelect } });
}

async function deleteUser(input: Record<string, unknown>, deps: MicrosoftGraphAdminRuntimeDeps): Promise<unknown> {
  const id = requiredString(input.userId, "userId");
  await microsoftGraphAdminRequest(`users/${encodePathSegment(id)}`, deps, { method: "DELETE" });
  return { deleted: true, userId: id };
}

async function listSubscribedSkus(
  input: Record<string, unknown>,
  deps: MicrosoftGraphAdminRuntimeDeps,
): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const result = await microsoftGraphAdminCollectionRequest(nextLink ?? "subscribedSkus", deps, {
    nextLinkKind: "subscribed_skus",
    query: nextLink ? undefined : compactObject({ $select: stringList(input.select) }),
  });
  return { skus: result.items, nextLink: result.nextLink };
}

async function listUserLicenses(
  input: Record<string, unknown>,
  deps: MicrosoftGraphAdminRuntimeDeps,
): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const result = await microsoftGraphAdminCollectionRequest(
    nextLink ?? `users/${userPathId(input)}/licenseDetails`,
    deps,
    { nextLinkKind: "user_licenses" },
  );
  return { licenses: result.items, nextLink: result.nextLink };
}

async function assignUserLicenses(
  input: Record<string, unknown>,
  deps: MicrosoftGraphAdminRuntimeDeps,
): Promise<unknown> {
  const addLicenses = Array.isArray(input.addLicenses)
    ? input.addLicenses.map((value) => {
        const license = requiredRecord(value, "addLicenses item");
        return {
          skuId: requiredString(license.skuId, "addLicenses.skuId"),
          disabledPlans: Array.isArray(license.disabledPlans) ? license.disabledPlans.map(String) : [],
        };
      })
    : [];
  const removeLicenses = Array.isArray(input.removeLicenses) ? input.removeLicenses.map(String) : [];
  if (addLicenses.length === 0 && removeLicenses.length === 0) {
    throw new ProviderRequestError(400, "assign_user_licenses requires at least one license to add or remove.");
  }
  return microsoftGraphAdminJsonRequest(`users/${userPathId(input)}/assignLicense`, deps, {
    method: "POST",
    body: { addLicenses, removeLicenses },
  });
}

function userMutation(input: Record<string, unknown>, fields: string[] = mutableUserFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    if (input[field] !== undefined) body[field] = input[field];
  }
  return body;
}

function userPathId(input: Record<string, unknown>): string {
  return encodePathSegment(requiredString(input.userId, "userId"));
}

function stringList(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value.map(String) : undefined;
  return values && values.length > 0 ? values.join(",") : undefined;
}
