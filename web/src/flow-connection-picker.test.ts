import type { ConnectionRecord, ProviderDefinition } from "./model";

import { describe, expect, it } from "vitest";
import { flowConnectionDisplayName, flowConnectionMatchesQuery } from "./flow-connection-picker";

const connection: ConnectionRecord = {
  id: "outlook-1",
  service: "outlook",
  connectionName: "work-mail",
  authType: "oauth2",
  profile: { displayName: "zeke@example.com" },
  metadata: {},
};

const provider: ProviderDefinition = {
  service: "outlook",
  displayName: "Microsoft Outlook",
  categories: [],
  authTypes: ["oauth2"],
  auth: [{ type: "oauth2", scopes: [] }],
  actions: [],
};

describe("FlowConnectionPicker", () => {
  it("matches connection and provider fields with multi-term search", () => {
    expect(flowConnectionMatchesQuery(connection, provider, "outlook zeke")).toBe(true);
    expect(flowConnectionMatchesQuery(connection, provider, "MICROSOFT work-mail")).toBe(true);
    expect(flowConnectionMatchesQuery(connection, provider, "sharepoint")).toBe(false);
  });

  it("prefers the authenticated profile display name", () => {
    expect(flowConnectionDisplayName(connection)).toBe("zeke@example.com");
    expect(flowConnectionDisplayName({ ...connection, profile: null })).toBe("work-mail");
  });
});
