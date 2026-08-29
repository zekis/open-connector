import { describe, expect, it } from "vitest";
import { parseKanbanDefinitionText } from "./kanban-page";

describe("Connected Kanban generated definitions", () => {
  it("accepts a generated board and rejects incomplete advanced JSON", () => {
    const definition = {
      name: "Delivery",
      cardLimit: 50,
      columns: [{ id: "new", label: "New", value: "New" }],
      sources: [
        {
          id: "work",
          name: "Work",
          connectionId: "work-1",
          actionId: "work.list_items",
          input: {},
          itemsPath: "$.items[*]",
          mapping: { id: "$.id", title: "$.title", column: "$.status" },
        },
      ],
    };

    expect(parseKanbanDefinitionText(JSON.stringify(definition))).toEqual(definition);
    expect(parseKanbanDefinitionText('{"name":"Incomplete"}')).toBeUndefined();
    expect(parseKanbanDefinitionText("not json")).toBeUndefined();
  });
});
