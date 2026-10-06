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
        allowedRecipients: [],
      }),
    ).toEqual({
      allowedActions: ["github.*", "github.create_issue"],
      blockedActions: [],
      allowedProxies: ["github"],
      blockedProxies: ["*"],
      allowedRecipients: [],
    });
  });

  it("accepts connection-scoped actions and rejects malformed scopes", () => {
    expect(
      readTokenPolicy({
        allowedActions: ["xero.*", "outlook.*@shared-id"],
        blockedActions: [],
        allowedProxies: [],
        allowedRecipients: [],
      }).allowedActions,
    ).toEqual(["xero.*", "outlook.*@shared-id"]);
    for (const rule of ["outlook.*@", "outlook.*@*", "outlook.*@one@two", "outlook.*@two words"]) {
      expect(() =>
        readTokenPolicy({ allowedActions: [rule], blockedActions: [], allowedProxies: [], allowedRecipients: [] }),
      ).toThrow();
    }
  });

  it("allows omitted token rules only during creation", () => {
    expect(readTokenPolicy({}, true)).toEqual({
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedRecipients: [],
    });
    expect(() => readTokenPolicy({})).toThrow("allowedActions must be an array of strings");
  });

  it.each(["github*", "github.*.issues", "github.", ".create_issue", "github create_issue"])(
    "rejects invalid action rule %s",
    (rule) => {
      expect(() =>
        readTokenPolicy({ allowedActions: [rule], blockedActions: [], allowedProxies: [], allowedRecipients: [] }),
      ).toThrow("contains an invalid action rule");
    },
  );

  it("rejects invalid proxy wildcards", () => {
    expect(() =>
      readRuntimePolicyRules({
        allowedActions: [],
        blockedActions: [],
        allowedProxies: ["git*"],
        blockedProxies: [],
        allowedRecipients: [],
      }),
    ).toThrow("contains an invalid proxy rule");
    expect(() =>
      readTokenPolicy({ allowedActions: [], blockedActions: [], allowedProxies: ["git*"], allowedRecipients: [] }),
    ).toThrow("contains an invalid proxy rule");
    expect(() =>
      readTokenPolicy({
        allowedActions: [],
        blockedActions: [],
        allowedProxies: [],
        blockedProxies: ["github"],
        allowedRecipients: [],
      }),
    ).toThrow("does not support proxy block rules");
  });

  it("enforces normalized item and UTF-8 byte limits", () => {
    const rules = Array.from({ length: policyRuleListMaxItems + 1 }, (_, index) => `github.action_${index}`);
    expect(() =>
      readTokenPolicy({ allowedActions: rules, blockedActions: [], allowedProxies: [], allowedRecipients: [] }),
    ).toThrow(`more than ${policyRuleListMaxItems}`);
    expect(() =>
      readTokenPolicy({
        allowedActions: [`github.${"界".repeat(policyRuleMaxBytes)}`],
        blockedActions: [],
        allowedProxies: [],
        allowedRecipients: [],
      }),
    ).toThrow(`${policyRuleMaxBytes} UTF-8 bytes`);
  });

  it("accepts recipient addresses and @domain rules, normalized to lowercase", () => {
    expect(
      readTokenPolicy({
        allowedActions: [],
        blockedActions: [],
        allowedProxies: [],
        allowedRecipients: [" @Company.test ", "Pat.Lee@partner.test", "@company.test"],
      }).allowedRecipients,
    ).toEqual(["@company.test", "pat.lee@partner.test"]);
    for (const rule of [
      "company.test",
      "@localhost",
      "a@b@example.com",
      "Name <a@example.com>",
      "@example.com.",
    ]) {
      expect(() =>
        readTokenPolicy({ allowedActions: [], blockedActions: [], allowedProxies: [], allowedRecipients: [rule] }),
      ).toThrow("contains an invalid recipient rule");
    }
  });
});
