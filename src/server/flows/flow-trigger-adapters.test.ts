import { describe, expect, it } from "vitest";
import { createFlowPollPlan, supportsConnectionFlowTrigger } from "./flow-trigger-adapters.ts";

describe("Flow trigger adapters", () => {
  it("builds a provider-declared event detector without a user query", () => {
    const provider = {
      service: "outlook",
      events: [
        {
          id: "outlook.new_sent_email",
          displayName: "New sent email",
          description: "Runs for sent mail.",
          polling: {
            actionId: "outlook.list_messages",
            input: { mailFolderId: "sentitems", top: 50 },
            result: { kind: "records" as const, collectionField: "messages", idFields: ["id"] },
          },
        },
      ],
    };
    const trigger = {
      type: "event" as const,
      connectionId: "outlook-1",
      eventId: "outlook.new_sent_email",
      pollIntervalSeconds: 60,
    };

    expect(supportsConnectionFlowTrigger(trigger, provider)).toBe(true);
    const plan = createFlowPollPlan(trigger, provider);
    expect(plan.input).toEqual({ mailFolderId: "sentitems", top: 50 });
    expect(plan.readItems({ messages: [{ id: "sent-1", subject: "Update" }] })).toEqual([
      { id: "sent-1", payload: { id: "sent-1", subject: "Update" } },
    ]);
  });

  it("builds an Outlook mailbox detector and extracts messages", () => {
    const trigger = {
      type: "new_email" as const,
      connectionId: "outlook-1",
      pollIntervalSeconds: 60,
      query: "isRead eq false",
    };
    const plan = createFlowPollPlan(trigger, "outlook");

    expect(plan.actionId).toBe("outlook.list_messages");
    expect(plan.input).toMatchObject({ filter: "isRead eq false", top: 50 });
    expect(plan.readItems({ messages: [{ id: "message-1", subject: "New request" }, { subject: "No id" }] })).toEqual([
      { id: "message-1", payload: { id: "message-1", subject: "New request" } },
    ]);
  });

  it("filters OneDrive files by extension and ignores folders", () => {
    const plan = createFlowPollPlan(
      {
        type: "file_created",
        connectionId: "drive-1",
        pollIntervalSeconds: 60,
        folder: "/Projects",
        extension: "md",
      },
      "one_drive",
    );

    expect(plan.input).toMatchObject({ folderPath: "/Projects", top: 50 });
    expect(
      plan.readItems({
        items: [
          { id: "file-1", name: "notes.md", file: {} },
          { id: "file-2", name: "notes.txt", file: {} },
          { id: "folder-1", name: "notes.md", folder: {} },
        ],
      }),
    ).toEqual([{ id: "file-1", payload: { id: "file-1", name: "notes.md", file: {} } }]);
  });

  it("reports supported event and connector combinations", () => {
    expect(
      supportsConnectionFlowTrigger({ type: "new_email", connectionId: "gmail-1", pollIntervalSeconds: 60 }, "gmail"),
    ).toBe(true);
    expect(
      supportsConnectionFlowTrigger(
        { type: "file_created", connectionId: "outlook-1", pollIntervalSeconds: 60 },
        "outlook",
      ),
    ).toBe(false);
  });
});
