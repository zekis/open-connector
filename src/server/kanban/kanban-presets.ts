import type { KanbanColumn, KanbanSource } from "./kanban-types.ts";

export interface KanbanPreset {
  id: string;
  service: string;
  name: string;
  description: string;
  boardName: string;
  columns: KanbanColumn[];
  source: Omit<KanbanSource, "connectionId">;
}

/** Curated deterministic mappings for common connector collections. */
export const kanbanPresets: KanbanPreset[] = [
  {
    id: "microsoft-todo-status",
    service: "microsoft_todo",
    name: "Microsoft To Do by status",
    description: "Organize one task list by Microsoft To Do status and write moves back to the task.",
    boardName: "Microsoft To Do",
    columns: [
      { id: "not-started", label: "Not started", value: "notStarted" },
      { id: "in-progress", label: "In progress", value: "inProgress" },
      { id: "waiting", label: "Waiting", value: "waitingOnOthers" },
      { id: "completed", label: "Completed", value: "completed" },
      { id: "deferred", label: "Deferred", value: "deferred" },
    ],
    source: {
      id: "microsoft-todo-tasks",
      name: "Microsoft To Do tasks",
      actionId: "microsoft_todo.list_tasks",
      input: { taskListId: "REPLACE_WITH_TASK_LIST_ID" },
      itemsPath: "$.tasks[*]",
      mapping: {
        id: "$.id",
        title: "$.title",
        column: "$.status",
        description: "$.body.content",
        priority: "$.importance",
        dueDate: "$.dueDateTime.dateTime",
        revision: '$["@odata.etag"]',
      },
      writeBack: {
        actionId: "microsoft_todo.update_task",
        inputTemplate: {
          taskListId: "$source.input.taskListId",
          taskId: "$raw.id",
          status: "$target.value",
        },
      },
    },
  },
  {
    id: "azure-devops-state",
    service: "azure_devops",
    name: "Azure DevOps work items by state",
    description: "Query work items with WIQL and write state transitions back with revision checking.",
    boardName: "Azure DevOps work items",
    columns: [
      { id: "new", label: "New", value: "New" },
      { id: "active", label: "Active", value: "Active" },
      { id: "resolved", label: "Resolved", value: "Resolved" },
      { id: "closed", label: "Closed", value: "Closed" },
    ],
    source: {
      id: "azure-devops-work-items",
      name: "Azure DevOps work items",
      actionId: "azure_devops.query_work_items",
      input: {
        project: "REPLACE_WITH_PROJECT",
        wiql: "SELECT [System.Id], [System.Title], [System.State] FROM WorkItems ORDER BY [System.ChangedDate] DESC",
        includeDetails: true,
      },
      itemsPath: "$.workItems[*]",
      mapping: {
        id: "$.id",
        title: '$.fields["System.Title"]',
        column: '$.fields["System.State"]',
        description: '$.fields["System.Description"]',
        priority: '$.fields["Microsoft.VSTS.Common.Priority"]',
        labels: '$.fields["System.Tags"]',
        assignee: '$.fields["System.AssignedTo"].displayName',
        url: "$._links.html.href",
        revision: "$.rev",
      },
      writeBack: {
        actionId: "azure_devops.update_work_item",
        inputTemplate: {
          project: "$source.input.project",
          id: "$raw.id",
          revision: "$raw.rev",
          fields: { "System.State": "$target.value" },
        },
      },
    },
  },
  {
    id: "todoist-priority",
    service: "todoist",
    name: "Todoist tasks by priority",
    description: "Organize Todoist tasks by priority and persist changes when cards move.",
    boardName: "Todoist priorities",
    columns: [
      { id: "normal", label: "Normal", value: 1 },
      { id: "medium", label: "Medium", value: 2 },
      { id: "high", label: "High", value: 3 },
      { id: "urgent", label: "Urgent", value: 4 },
    ],
    source: {
      id: "todoist-tasks",
      name: "Todoist tasks",
      actionId: "todoist.list_tasks",
      input: {},
      itemsPath: "$.tasks[*]",
      mapping: {
        id: "$.id",
        title: "$.content",
        column: "$.priority",
        description: "$.description",
        labels: "$.labels",
        assignee: "$.assigned_by_uid",
        dueDate: "$.due.date",
        url: "$.url",
      },
      writeBack: {
        actionId: "todoist.update_task",
        inputTemplate: { taskId: "$raw.id", priority: "$target.value" },
      },
    },
  },
];
