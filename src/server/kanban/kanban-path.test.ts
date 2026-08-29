import { describe, expect, it } from "vitest";
import { KanbanPathError, selectKanbanItems, selectKanbanPath } from "./kanban-path.ts";

describe("Kanban JSON paths", () => {
  it("selects nested provider fields, quoted keys, indexes, and wildcards", () => {
    const value = {
      workItems: [
        { id: 42, fields: { "System.Title": "First", tags: ["one", "two"] } },
        { id: 43, fields: { "System.Title": "Second", tags: ["three"] } },
      ],
    };

    expect(selectKanbanItems(value, "$.workItems[*]")).toHaveLength(2);
    expect(selectKanbanPath(value, '$.workItems[0].fields["System.Title"]')).toEqual(["First"]);
    expect(selectKanbanPath(value, "$.workItems[*].fields.tags[*]")).toEqual(["one", "two", "three"]);
  });

  it("rejects recursive and filter expressions", () => {
    expect(() => selectKanbanPath({}, "$..items")).toThrow(KanbanPathError);
    expect(() => selectKanbanPath({}, "$.items[?(@.open)]")).toThrow(KanbanPathError);
  });
});
