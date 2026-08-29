import { describe, expect, it } from "vitest";
import { inferKanbanActionShape } from "./kanban-page";

describe("Connected Kanban action mapping", () => {
  it("infers a collection, common card fields, and enum columns from an action schema", () => {
    expect(
      inferKanbanActionShape({
        id: "work.query_work_items",
        name: "query_work_items",
        outputSchema: {
          type: "object",
          properties: {
            workItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  subject: { type: "string" },
                  state: { type: "string", enum: ["New", "Active", "Done"] },
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      collection: "workItems",
      id: "id",
      title: "subject",
      column: "state",
      columns: [
        { id: "column-1", label: "New", value: "New" },
        { id: "column-2", label: "Active", value: "Active" },
        { id: "column-3", label: "Done", value: "Done" },
      ],
    });
  });

  it("bounds numeric columns described by an action schema", () => {
    expect(
      inferKanbanActionShape({
        id: "tasks.list_tasks",
        name: "list_tasks",
        outputSchema: {
          properties: {
            tasks: {
              type: "array",
              items: {
                properties: {
                  id: { type: "string" },
                  content: { type: "string" },
                  priority: { type: "integer", minimum: 1, maximum: 3 },
                },
              },
            },
          },
        },
      }).columns,
    ).toEqual([
      { id: "column-1", label: "1", value: 1 },
      { id: "column-2", label: "2", value: 2 },
      { id: "column-3", label: "3", value: 3 },
    ]);
  });
});
