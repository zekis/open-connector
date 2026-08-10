import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { microsoftTodoProviderScopes, microsoftTodoTaskScopes } from "./scopes.ts";

const service = "microsoft_todo";

interface MicrosoftTodoActionSource {
  name: string;
  description: string;
  requiredScopes: string[];
  providerPermissions: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const rawObject = s.record(true, { description: "A Microsoft Graph JSON object." });
const nonEmptyString = (description: string): JsonSchema => s.string({ minLength: 1, description });
const stringArray = (description: string): JsonSchema =>
  s.array(nonEmptyString("A string value."), { minItems: 1, description });
const taskListId = nonEmptyString("Microsoft To Do task-list ID.");
const taskId = nonEmptyString("Microsoft To Do task ID.");
const nextLink = s.url("Opaque pagination URL returned by a previous Microsoft To Do response.");
const dateTimeTimeZone = s.object(
  {
    dateTime: nonEmptyString("Local ISO 8601 date and time, such as 2026-08-10T09:00:00."),
    timeZone: nonEmptyString("Microsoft time-zone name, such as W. Australia Standard Time or UTC."),
  },
  {
    required: ["dateTime", "timeZone"],
    description: "Microsoft Graph date, time, and time-zone value.",
  },
);
const linkedResource = s.object(
  {
    applicationName: nonEmptyString("Name of the application that owns the linked resource."),
    displayName: nonEmptyString("Human-readable name of the linked resource."),
    webUrl: s.url("URL that opens the linked resource."),
    externalId: s.string({ description: "External identifier assigned by the source application." }),
  },
  {
    required: ["applicationName", "displayName", "webUrl"],
    description: "Source resource linked to a new task.",
  },
);
const taskList = s.looseObject(
  {
    id: nonEmptyString("Task-list ID."),
    displayName: nonEmptyString("Task-list name."),
    isOwner: s.boolean({ description: "Whether the connected account owns the task list." }),
    isShared: s.boolean({ description: "Whether the task list is shared with other users." }),
    wellknownListName: s.string({ description: "Built-in list classification assigned by Microsoft To Do." }),
  },
  { description: "Microsoft To Do task-list resource." },
);
const task = s.looseObject(
  {
    id: nonEmptyString("Task ID."),
    title: s.string({ description: "Task title." }),
    body: rawObject,
    bodyLastModifiedDateTime: s.string({ description: "ISO 8601 timestamp for the last body change." }),
    categories: s.array(s.string(), { description: "Outlook categories assigned to the task." }),
    completedDateTime: rawObject,
    createdDateTime: s.string({ description: "ISO 8601 task creation timestamp." }),
    dueDateTime: rawObject,
    hasAttachments: s.boolean({ description: "Whether the task has attachments." }),
    importance: s.string({ description: "Task importance: low, normal, or high." }),
    isReminderOn: s.boolean({ description: "Whether a reminder is enabled." }),
    lastModifiedDateTime: s.string({ description: "ISO 8601 task modification timestamp." }),
    linkedResources: s.array(rawObject, { description: "Resources linked to the task." }),
    recurrence: rawObject,
    reminderDateTime: rawObject,
    startDateTime: rawObject,
    status: s.string({ description: "Task progress status." }),
  },
  { description: "Microsoft To Do task resource." },
);
const profile = s.looseObject(
  {
    id: nonEmptyString("Unique identifier for the current Microsoft account."),
    displayName: s.string({ description: "Display name of the current account." }),
    mail: s.nullableString("Primary SMTP address for the current account."),
    userPrincipalName: s.string({ description: "User principal name for the current account." }),
  },
  { description: "Current Microsoft account profile." },
);
const success = s.object(
  {
    success: s.literal(true, { description: "Whether the Microsoft To Do operation completed successfully." }),
  },
  { required: ["success"], description: "Successful Microsoft To Do mutation acknowledgement." },
);

function input(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, "Microsoft To Do action input.");
}

const taskWriteFields = {
  title: s.string({ description: "Task title." }),
  body: s.string({ description: "Task body as HTML; plain text is also valid HTML content." }),
  categories: stringArray("Outlook categories to assign to the task."),
  completedDateTime: dateTimeTimeZone,
  dueDateTime: dateTimeTimeZone,
  importance: s.stringEnum(["low", "normal", "high"], { description: "Task importance." }),
  isReminderOn: s.boolean({ description: "Whether Microsoft To Do should show a reminder." }),
  recurrence: rawObject,
  reminderDateTime: dateTimeTimeZone,
  startDateTime: dateTimeTimeZone,
  status: s.stringEnum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"], {
    description: "Task progress status.",
  }),
};

const actions: MicrosoftTodoActionSource[] = [
  action(
    "get_profile",
    "Get the connected Microsoft account profile so you can identify which Microsoft To Do account is in use.",
    [microsoftTodoProviderScopes.userRead],
    [microsoftTodoProviderScopes.userRead],
    input({}),
    profile,
  ),
  action(
    "list_task_lists",
    "List Microsoft To Do task lists with optional field selection and pagination.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input({
      top: s.integer({ minimum: 1, maximum: 1000, description: "Maximum number of task lists to return." }),
      select: stringArray("Task-list fields to request from Microsoft Graph."),
      nextLink,
    }),
    s.object(
      {
        taskLists: s.array(taskList, { description: "Task lists returned by Microsoft To Do." }),
        nextLink: s.nullableString("Pagination URL for the next page, or null when there is no next page."),
      },
      { required: ["taskLists", "nextLink"], description: "Microsoft To Do task-list response." },
    ),
  ),
  action(
    "get_task_list",
    "Get one Microsoft To Do task list by ID.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input({ taskListId, select: stringArray("Task-list fields to request from Microsoft Graph.") }, ["taskListId"]),
    taskList,
  ),
  action(
    "create_task_list",
    "Create a Microsoft To Do task list.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input({ displayName: nonEmptyString("Name for the new task list.") }, ["displayName"]),
    taskList,
  ),
  action(
    "update_task_list",
    "Rename a user-created Microsoft To Do task list.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input(
      {
        taskListId,
        displayName: nonEmptyString("New task-list name."),
        ifMatch: s.string({ description: "Optional task-list ETag used for optimistic concurrency." }),
      },
      ["taskListId", "displayName"],
    ),
    taskList,
  ),
  action(
    "delete_task_list",
    "Delete a user-created Microsoft To Do task list and its tasks.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input(
      {
        taskListId,
        ifMatch: s.string({ description: "Optional task-list ETag used for optimistic concurrency." }),
      },
      ["taskListId"],
    ),
    success,
  ),
  action(
    "list_tasks",
    "List tasks in a Microsoft To Do task list with optional OData filtering, sorting, field selection, and pagination.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input(
      {
        taskListId,
        top: s.integer({ minimum: 1, maximum: 1000, description: "Maximum number of tasks to return." }),
        filter: s.string({ description: "OData filter expression for tasks." }),
        orderby: s.string({ description: "OData orderby expression for tasks." }),
        select: stringArray("Task fields to request from Microsoft Graph."),
        nextLink,
      },
      ["taskListId"],
    ),
    s.object(
      {
        tasks: s.array(task, { description: "Tasks returned by Microsoft To Do." }),
        nextLink: s.nullableString("Pagination URL for the next page, or null when there is no next page."),
      },
      { required: ["tasks", "nextLink"], description: "Microsoft To Do task response." },
    ),
  ),
  action(
    "get_task",
    "Get one Microsoft To Do task by task-list ID and task ID.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input(
      {
        taskListId,
        taskId,
        select: stringArray("Task fields to request from Microsoft Graph."),
      },
      ["taskListId", "taskId"],
    ),
    task,
  ),
  action(
    "create_task",
    "Create a task in a Microsoft To Do task list, optionally linking it to a source resource.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input(
      {
        taskListId,
        ...taskWriteFields,
        linkedResources: s.array(linkedResource, {
          maxItems: 25,
          description: "Source resources to associate with the new task.",
        }),
      },
      ["taskListId", "title"],
    ),
    task,
  ),
  action(
    "update_task",
    "Update supplied fields on an existing Microsoft To Do task.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input(
      {
        taskListId,
        taskId,
        ifMatch: s.string({ description: "Optional task ETag used for optimistic concurrency." }),
        ...taskWriteFields,
      },
      ["taskListId", "taskId"],
    ),
    task,
  ),
  action(
    "delete_task",
    "Delete a Microsoft To Do task.",
    microsoftTodoTaskScopes,
    microsoftTodoTaskScopes,
    input(
      {
        taskListId,
        taskId,
        ifMatch: s.string({ description: "Optional task ETag used for optimistic concurrency." }),
      },
      ["taskListId", "taskId"],
    ),
    success,
  ),
];

export const microsoftTodoActions: ActionDefinition[] = actions.map((item) => defineProviderAction(service, item));

function action(
  name: string,
  description: string,
  requiredScopes: string[],
  providerPermissions: string[],
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): MicrosoftTodoActionSource {
  return { name, description, requiredScopes, providerPermissions, inputSchema, outputSchema };
}
