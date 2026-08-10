import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { MicrosoftTodoActionHandler, MicrosoftTodoRuntimeDeps } from "./graph-client.ts";

import { compactObject, optionalString, requiredRecord, requiredString } from "../../core/cast.ts";
import { defineOAuthProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { microsoftTodoCollectionRequest, microsoftTodoJsonRequest, microsoftTodoRequest } from "./graph-client.ts";

export const microsoftTodoActionHandlers: Record<string, MicrosoftTodoActionHandler> = {
  get_profile(_input, deps) {
    return getProfile(deps);
  },
  list_task_lists(input, deps) {
    return listTaskLists(input, deps);
  },
  get_task_list(input, deps) {
    return getTaskList(input, deps);
  },
  create_task_list(input, deps) {
    return createTaskList(input, deps);
  },
  update_task_list(input, deps) {
    return updateTaskList(input, deps);
  },
  delete_task_list(input, deps) {
    return deleteTaskList(input, deps);
  },
  list_tasks(input, deps) {
    return listTasks(input, deps);
  },
  get_task(input, deps) {
    return getTask(input, deps);
  },
  create_task(input, deps) {
    return createTask(input, deps);
  },
  update_task(input, deps) {
    return updateTask(input, deps);
  },
  delete_task(input, deps) {
    return deleteTask(input, deps);
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors("microsoft_todo", microsoftTodoActionHandlers);

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const currentAccount = await microsoftTodoJsonRequest<{
      id?: unknown;
      displayName?: unknown;
      mail?: unknown;
      userPrincipalName?: unknown;
    }>(
      "me",
      {
        accessToken: input.accessToken,
        tokenType: input.tokenType,
        fetcher,
        signal,
      },
      {
        query: { $select: "id,displayName,mail,userPrincipalName" },
      },
    );
    const accountId = requiredString(currentAccount.id, "Microsoft To Do current account ID");
    return {
      profile: {
        accountId,
        displayName:
          optionalString(currentAccount.mail) ??
          optionalString(currentAccount.userPrincipalName) ??
          optionalString(currentAccount.displayName) ??
          accountId,
      },
      metadata: {
        currentAccount,
      },
    };
  },
};

async function getProfile(deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  return microsoftTodoJsonRequest("me", deps, {
    query: { $select: "id,displayName,mail,userPrincipalName" },
  });
}

async function listTaskLists(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const result = await microsoftTodoCollectionRequest(nextLink ?? "me/todo/lists", deps, {
    nextLinkKind: "task_lists",
    query: nextLink
      ? undefined
      : compactObject({
          $top: typeof input.top === "number" ? input.top : undefined,
          $select: stringList(input.select),
        }),
  });
  return {
    taskLists: result.items,
    nextLink: result.nextLink,
  };
}

async function getTaskList(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  return microsoftTodoJsonRequest(`me/todo/lists/${pathId(input.taskListId, "taskListId")}`, deps, {
    query: compactObject({ $select: stringList(input.select) }),
  });
}

async function createTaskList(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  return microsoftTodoJsonRequest("me/todo/lists", deps, {
    method: "POST",
    body: { displayName: requiredString(input.displayName, "displayName") },
  });
}

async function updateTaskList(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  return microsoftTodoJsonRequest(`me/todo/lists/${pathId(input.taskListId, "taskListId")}`, deps, {
    method: "PATCH",
    headers: { "if-match": optionalString(input.ifMatch) },
    body: { displayName: requiredString(input.displayName, "displayName") },
  });
}

async function deleteTaskList(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  await microsoftTodoRequest(`me/todo/lists/${pathId(input.taskListId, "taskListId")}`, deps, {
    method: "DELETE",
    headers: { "if-match": optionalString(input.ifMatch) },
  });
  return { success: true };
}

async function listTasks(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const result = await microsoftTodoCollectionRequest(
    nextLink ?? `me/todo/lists/${pathId(input.taskListId, "taskListId")}/tasks`,
    deps,
    {
      nextLinkKind: "tasks",
      query: nextLink
        ? undefined
        : compactObject({
            $top: typeof input.top === "number" ? input.top : undefined,
            $filter: optionalString(input.filter),
            $orderby: optionalString(input.orderby),
            $select: stringList(input.select),
          }),
    },
  );
  return {
    tasks: result.items,
    nextLink: result.nextLink,
  };
}

async function getTask(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  return microsoftTodoJsonRequest(taskPath(input), deps, {
    query: compactObject({ $select: stringList(input.select) }),
  });
}

async function createTask(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  return microsoftTodoJsonRequest(`me/todo/lists/${pathId(input.taskListId, "taskListId")}/tasks`, deps, {
    method: "POST",
    body: buildTaskWritePayload(input, true),
  });
}

async function updateTask(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  return microsoftTodoJsonRequest(taskPath(input), deps, {
    method: "PATCH",
    headers: { "if-match": optionalString(input.ifMatch) },
    body: buildTaskWritePayload(input, false),
  });
}

async function deleteTask(input: Record<string, unknown>, deps: MicrosoftTodoRuntimeDeps): Promise<unknown> {
  await microsoftTodoRequest(taskPath(input), deps, {
    method: "DELETE",
    headers: { "if-match": optionalString(input.ifMatch) },
  });
  return { success: true };
}

function buildTaskWritePayload(input: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  return compactObject({
    title: typeof input.title === "string" ? input.title : creating ? requiredString(input.title, "title") : undefined,
    body: typeof input.body === "string" ? { content: input.body, contentType: "html" } : undefined,
    categories: stringValues(input.categories),
    completedDateTime: optionalDateTimeTimeZone(input.completedDateTime, "completedDateTime"),
    dueDateTime: optionalDateTimeTimeZone(input.dueDateTime, "dueDateTime"),
    importance: optionalString(input.importance),
    isReminderOn: typeof input.isReminderOn === "boolean" ? input.isReminderOn : undefined,
    recurrence:
      input.recurrence === undefined
        ? undefined
        : requiredRecord(input.recurrence, "recurrence", (message) => new ProviderRequestError(400, message)),
    reminderDateTime: optionalDateTimeTimeZone(input.reminderDateTime, "reminderDateTime"),
    startDateTime: optionalDateTimeTimeZone(input.startDateTime, "startDateTime"),
    status: optionalString(input.status),
    linkedResources: creating ? normalizeLinkedResources(input.linkedResources) : undefined,
  });
}

function optionalDateTimeTimeZone(value: unknown, fieldName: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const item = requiredRecord(value, fieldName, (message) => new ProviderRequestError(400, message));
  return {
    dateTime: requiredString(item.dateTime, `${fieldName}.dateTime`),
    timeZone: requiredString(item.timeZone, `${fieldName}.timeZone`),
  };
}

function normalizeLinkedResources(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((resource) => {
    const item = requiredRecord(resource, "linkedResource", (message) => new ProviderRequestError(400, message));
    return compactObject({
      applicationName: requiredString(item.applicationName, "linkedResource.applicationName"),
      displayName: requiredString(item.displayName, "linkedResource.displayName"),
      webUrl: requiredString(item.webUrl, "linkedResource.webUrl"),
      externalId: optionalString(item.externalId),
    });
  });
}

function taskPath(input: Record<string, unknown>): string {
  return `me/todo/lists/${pathId(input.taskListId, "taskListId")}/tasks/${pathId(input.taskId, "taskId")}`;
}

function pathId(value: unknown, fieldName: string): string {
  return encodeURIComponent(requiredString(value, fieldName));
}

function stringList(value: unknown): string | undefined {
  const values = stringValues(value);
  return values && values.length > 0 ? values.join(",") : undefined;
}

function stringValues(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}
