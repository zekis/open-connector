import { describe, expect, it } from "vitest";
import { policyRuleListMaxItems, policyRuleMaxBytes, readRuntimePolicyRules, readTokenPolicy } from "./policy-input.ts";

describe("policy input", () => {
  it("trims and stably deduplicates complete Runtime policy rules", () => {
    expect(
      readRuntimePolicyRules({
        allowedActions: [" github.* ", "github.*", "github.create_issue"],
        blockedActions: [],
        allowedProxies: [" github ", "github"],
        blockedProxies: ["*"],
      }),
    ).toEqual({
      allowedActions: ["github.*", "github.create_issue"],
      blockedActions: [],
      allowedProxies: ["github"],
      blockedProxies: ["*"],
    });
  });

  it("accepts connection-scoped actions and rejects malformed scopes", () => {
    expect(
      readTokenPolicy({ allowedActions: ["xero.*", "outlook.*@shared-id"], blockedActions: [], allowedProxies: [] })
        .allowedActions,
    ).toEqual(["xero.*", "outlook.*@shared-id"]);
    for (const rule of ["outlook.*@", "outlook.*@*", "outlook.*@one@two", "outlook.*@two words"]) {
      expect(() => readTokenPolicy({ allowedActions: [rule], blockedActions: [], allowedProxies: [] })).toThrow();
    }
  });

  it("allows omitted token rules only during creation", () => {
    expect(readTokenPolicy({}, true)).toEqual({ allowedActions: [], blockedActions: [], allowedProxies: [] });
    expect(() => readTokenPolicy({})).toThrow("allowedActions must be an array of strings");
  });

  it.each(["github*", "github.*.issues", "github.", ".create_issue", "github create_issue"])(
    "rejects invalid action rule %s",
    (rule) => {
      expect(() => readTokenPolicy({ allowedActions: [rule], blockedActions: [], allowedProxies: [] })).toThrow(
        "contains an invalid action rule",
      );
    },
  );

  it("rejects invalid proxy wildcards", () => {
    expect(() =>
      readRuntimePolicyRules({
        allowedActions: [],
        blockedActions: [],
        allowedProxies: ["git*"],
        blockedProxies: [],
      }),
    ).toThrow("contains an invalid proxy rule");
    expect(() => readTokenPolicy({ allowedActions: [], blockedActions: [], allowedProxies: ["git*"] })).toThrow(
      "contains an invalid proxy rule",
    );
    expect(() =>
      readTokenPolicy({ allowedActions: [], blockedActions: [], allowedProxies: [], blockedProxies: ["github"] }),
    ).toThrow("does not support proxy block rules");
  });

  it("enforces normalized item and UTF-8 byte limits", () => {
    const rules = Array.from({ length: policyRuleListMaxItems + 1 }, (_, index) => `github.action_${index}`);
    expect(() => readTokenPolicy({ allowedActions: rules, blockedActions: [], allowedProxies: [] })).toThrow(
      `more than ${policyRuleListMaxItems}`,
    );
    expect(() =>
      readTokenPolicy({
        allowedActions: [`github.${"界".repeat(policyRuleMaxBytes)}`],
        blockedActions: [],
        allowedProxies: [],
      }),
    ).toThrow(`${policyRuleMaxBytes} UTF-8 bytes`);
  });
});
