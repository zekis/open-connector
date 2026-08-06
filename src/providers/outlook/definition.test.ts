import { describe, expect, it } from "vitest";
import { provider } from "./definition.ts";

describe("Outlook OAuth authorization", () => {
  it("asks Microsoft to show the account selector", () => {
    const oauth = provider.auth.find((auth) => auth.type === "oauth2");

    expect(oauth?.authorizationParams?.prompt).toBe("select_account");
  });
});
