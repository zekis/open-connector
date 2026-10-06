import type { ActionDefinition } from "./types.ts";

import { describe, expect, it } from "vitest";
import {
  ActionPolicyService,
  emptyPolicyRules,
  normalizeRecipientAddress,
  parseActionPolicyList,
} from "./action-policy.ts";

const trustedRecipients = ["@company.test", "pat.lee@partner.test"];

const sendEmail: ActionDefinition = {
  id: "outlook.send_email",
  service: "outlook",
  name: "send_email",
  description: "Send an email.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  sendsMail: true,
};

const action: ActionDefinition = {
  id: "github.create_issue",
  service: "github",
  name: "create_issue",
  description: "Create an issue.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

describe("ActionPolicyService", () => {
  it("limits scoped grants to the resolved connection while preserving provider-wide grants", () => {
    const policy = new ActionPolicyService().createSnapshot(undefined, {
      allowedActions: ["xero.*", "github.*@shared-id"],
      blockedActions: [],
      allowedProxies: [],
      allowedRecipients: [],
    });
    expect(policy.evaluate(action).allowed).toBe(true);
    expect(policy.evaluate(action, "shared-id").allowed).toBe(true);
    expect(policy.evaluate(action, "personal-id")).toMatchObject({ allowed: false, code: "action_not_allowed" });
    expect(policy.evaluate(action, null).allowed).toBe(false);
    expect(policy.evaluate({ ...action, id: "xero.list_contacts", service: "xero" }, "any-id").allowed).toBe(true);
    expect(policy.evaluateProxy("github").allowed).toBe(false);
  });

  it("applies connection-specific blocks only to that connection and keeps global blocks dominant", () => {
    const policy = new ActionPolicyService({
      allowedActions: ["github.*"],
      blockedActions: ["github.*@personal-id"],
    }).createSnapshot();
    expect(policy.evaluate(action).allowed).toBe(true);
    expect(policy.evaluate(action, "shared-id").allowed).toBe(true);
    expect(policy.evaluate(action, "personal-id")).toMatchObject({ allowed: false, code: "action_blocked" });
    const blocked = new ActionPolicyService({ blockedActions: ["github.*"] }).createSnapshot(undefined, {
      allowedActions: ["github.*@shared-id"],
      blockedActions: [],
      allowedProxies: [],
      allowedRecipients: [],
    });
    expect(blocked.evaluate(action, "shared-id").allowed).toBe(false);
  });

  it("allows actions by default", () => {
    expect(new ActionPolicyService().evaluate(action)).toEqual({ allowed: true, checks: [] });
  });

  it("enforces exact and provider-wide allowlists", () => {
    expect(new ActionPolicyService({ allowedActions: ["gmail.*"] }).evaluate(action)).toMatchObject({
      allowed: false,
      code: "action_not_allowed",
    });
    expect(new ActionPolicyService({ allowedActions: ["github.*"] }).evaluate(action)).toEqual({
      allowed: true,
      checks: [{ source: "deployment", outcome: "allow_match", rule: "github.*" }],
    });
    expect(new ActionPolicyService({ allowedActions: ["github.create_issue"] }).evaluate(action)).toEqual({
      allowed: true,
      checks: [{ source: "deployment", outcome: "allow_match", rule: "github.create_issue" }],
    });
  });

  it("supports bare wildcard to match all actions", () => {
    expect(new ActionPolicyService({ allowedActions: ["*"] }).evaluate(action)).toEqual({
      allowed: true,
      checks: [{ source: "deployment", outcome: "allow_match", rule: "*" }],
    });
    expect(new ActionPolicyService({ blockedActions: ["*"] }).evaluate(action)).toMatchObject({
      allowed: false,
      code: "action_blocked",
    });
  });

  it("blocks actions even when they are also allowed", () => {
    expect(
      new ActionPolicyService({
        allowedActions: ["github.*"],
        blockedActions: ["github.create_issue"],
      }).evaluate(action),
    ).toMatchObject({
      allowed: false,
      code: "action_blocked",
    });
  });

  it("allows proxies by default", () => {
    expect(new ActionPolicyService().evaluateProxy("github")).toEqual({ allowed: true, checks: [] });
  });

  it("ignores action policy when evaluating proxies", () => {
    expect(new ActionPolicyService({ allowedActions: ["github.get_current_user"] }).evaluateProxy("github")).toEqual({
      allowed: true,
      checks: [],
    });
    expect(new ActionPolicyService({ blockedActions: ["github.delete_repository"] }).evaluateProxy("github")).toEqual({
      allowed: true,
      checks: [],
    });
    expect(new ActionPolicyService({ allowedActions: ["*"] }).evaluateProxy("github")).toEqual({
      allowed: true,
      checks: [],
    });
    expect(new ActionPolicyService({ blockedActions: ["*"] }).evaluateProxy("github")).toEqual({
      allowed: true,
      checks: [],
    });
  });

  it("ignores proxy policy when evaluating actions", () => {
    expect(new ActionPolicyService({ blockedProxies: ["*"] }).evaluate(action)).toEqual({
      allowed: true,
      checks: [],
    });
    expect(new ActionPolicyService({ allowedProxies: ["slack"] }).evaluate(action)).toEqual({
      allowed: true,
      checks: [],
    });
  });

  it("disables every proxy with a blocked wildcard", () => {
    expect(new ActionPolicyService({ blockedProxies: ["*"] }).evaluateProxy("github")).toMatchObject({
      allowed: false,
      code: "proxy_blocked",
    });
  });

  it("enforces exact and wildcard proxy allowlists", () => {
    expect(new ActionPolicyService({ allowedProxies: ["slack"] }).evaluateProxy("github")).toMatchObject({
      allowed: false,
      code: "proxy_not_allowed",
    });
    expect(new ActionPolicyService({ allowedProxies: ["github"] }).evaluateProxy("github")).toEqual({
      allowed: true,
      checks: [{ source: "deployment", outcome: "allow_match", rule: "github" }],
    });
    expect(new ActionPolicyService({ allowedProxies: ["*"] }).evaluateProxy("github")).toEqual({
      allowed: true,
      checks: [{ source: "deployment", outcome: "allow_match", rule: "*" }],
    });
  });

  it("blocks proxies even when they are also allowed", () => {
    expect(
      new ActionPolicyService({
        allowedProxies: ["*"],
        blockedProxies: ["github"],
      }).evaluateProxy("github"),
    ).toMatchObject({
      allowed: false,
      code: "proxy_blocked",
    });
  });

  it("parses comma-separated environment lists", () => {
    expect(parseActionPolicyList(" github.* , gmail.send_email ,, ")).toEqual(["github.*", "gmail.send_email"]);
  });

  it("intersects deployment, runtime, and token action allowlists", () => {
    const snapshot = new ActionPolicyService({ allowedActions: ["github.*"] }).createSnapshot(
      {
        allowedActions: ["github.create_issue"],
        blockedActions: [],
        allowedProxies: [],
        blockedProxies: [],
        allowedRecipients: [],
      },
      { allowedActions: ["github.*"], blockedActions: [], allowedProxies: [], allowedRecipients: [] },
    );

    expect(snapshot.evaluate(action)).toEqual({
      allowed: true,
      checks: [
        { source: "deployment", outcome: "allow_match", rule: "github.*" },
        { source: "runtime", outcome: "allow_match", rule: "github.create_issue" },
        { source: "token", outcome: "allow_match", rule: "github.*" },
      ],
    });
  });

  it("reports the decisive layer when a lower allowlist rejects", () => {
    const snapshot = new ActionPolicyService({ allowedActions: ["github.*"] }).createSnapshot({
      allowedActions: ["gmail.*"],
      blockedActions: [],
      allowedProxies: [],
      blockedProxies: [],
      allowedRecipients: [],
    });

    expect(snapshot.evaluate(action)).toMatchObject({
      allowed: false,
      code: "action_not_allowed",
      checks: [
        { source: "deployment", outcome: "allow_match", rule: "github.*" },
        { source: "runtime", outcome: "allow_miss" },
      ],
    });
  });

  it("applies Runtime and token block rules before every allowlist", () => {
    const service = new ActionPolicyService({ allowedActions: ["*"] });
    const runtimeBlocked = service.createSnapshot({
      allowedActions: ["github.*"],
      blockedActions: ["github.create_issue"],
      allowedProxies: [],
      blockedProxies: [],
      allowedRecipients: [],
    });
    expect(runtimeBlocked.evaluate(action)).toMatchObject({
      allowed: false,
      code: "action_blocked",
      checks: [{ source: "runtime", outcome: "block_match", rule: "github.create_issue" }],
    });

    const tokenBlocked = service.createSnapshot(
      {
        allowedActions: ["github.*"],
        blockedActions: [],
        allowedProxies: [],
        blockedProxies: [],
        allowedRecipients: [],
      },
      {
        allowedActions: ["github.*"],
        blockedActions: ["github.create_issue"],
        allowedProxies: [],
        allowedRecipients: [],
      },
    );
    expect(tokenBlocked.evaluate(action)).toMatchObject({
      allowed: false,
      checks: [{ source: "token", outcome: "block_match", rule: "github.create_issue" }],
    });
  });

  it("records only the first matching rule from each layer", () => {
    const decision = new ActionPolicyService({ allowedActions: ["github.*", "*"] })
      .createSnapshot({
        allowedActions: ["github.create_issue", "github.*"],
        blockedActions: [],
        allowedProxies: [],
        blockedProxies: [],
        allowedRecipients: [],
      })
      .evaluate(action);

    expect(decision).toEqual({
      allowed: true,
      checks: [
        { source: "deployment", outcome: "allow_match", rule: "github.*" },
        { source: "runtime", outcome: "allow_match", rule: "github.create_issue" },
      ],
    });
  });

  it("requires runtime tokens to grant proxies independently of action rules", () => {
    const service = new ActionPolicyService({ allowedProxies: ["github"] });
    const runtime = {
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      blockedProxies: [],
      allowedRecipients: [],
    };

    expect(
      service
        .createSnapshot(runtime, {
          allowedActions: ["*"],
          blockedActions: [],
          allowedProxies: [],
          allowedRecipients: [],
        })
        .evaluateProxy("github"),
    ).toMatchObject({
      allowed: false,
      code: "proxy_not_allowed",
      checks: [
        { source: "deployment", outcome: "allow_match", rule: "github" },
        { source: "token", outcome: "allow_miss" },
      ],
    });

    expect(
      service
        .createSnapshot(runtime, {
          allowedActions: ["gmail.send_email"],
          blockedActions: ["github.create_issue"],
          allowedProxies: ["github"],
          allowedRecipients: [],
        })
        .evaluateProxy("github"),
    ).toEqual({
      allowed: true,
      checks: [
        { source: "deployment", outcome: "allow_match", rule: "github" },
        { source: "token", outcome: "allow_match", rule: "github" },
      ],
    });
  });
});

describe("recipient policy", () => {
  it("leaves mail unrestricted when no layer lists recipients", () => {
    const snapshot = new ActionPolicyService().createSnapshot();
    expect(snapshot.restrictsRecipients()).toBe(false);
    expect(snapshot.evaluateRecipients(sendEmail, ["anyone@example.com"])).toEqual({ allowed: true, checks: [] });
    expect(snapshot.evaluateRecipients(sendEmail, undefined)).toEqual({ allowed: true, checks: [] });
    expect(snapshot.evaluateProxy("outlook", true)).toEqual({ allowed: true, checks: [] });
  });

  it("matches whole domains and single addresses case-insensitively", () => {
    const snapshot = new ActionPolicyService({ allowedRecipients: trustedRecipients }).createSnapshot();
    expect(snapshot.restrictsRecipients()).toBe(true);
    expect(
      snapshot.evaluateRecipients(sendEmail, [
        "alice@company.test",
        "Bob Smith <Bob@Company.test>",
        "Pat.Lee@Partner.test",
      ]),
    ).toEqual({ allowed: true, checks: [{ source: "deployment", outcome: "allow_match" }] });
    for (const outsider of [
      "someone.else@partner.test",
      "alice@mail.company.test",
      "alice@company.test.example.com",
      "company.test",
    ]) {
      expect(snapshot.evaluateRecipients(sendEmail, [outsider])).toMatchObject({
        allowed: false,
        code: "recipient_not_allowed",
      });
    }
  });

  it("refuses the whole send when one recipient is outside the list, naming only the refused ones", () => {
    const decision = new ActionPolicyService({ allowedRecipients: trustedRecipients })
      .createSnapshot()
      .evaluateRecipients(sendEmail, ["alice@company.test", "Outsider <Outsider@Example.com>"]);
    expect(decision).toEqual({
      allowed: false,
      code: "recipient_not_allowed",
      message:
        "outlook.send_email would send mail to recipients outside the recipient allowlist: outsider@example.com.",
      checks: [{ source: "deployment", outcome: "allow_miss" }],
    });
  });

  it("refuses mail whose recipients could not be determined", () => {
    const snapshot = new ActionPolicyService().createSnapshot({
      ...emptyPolicyRules(),
      allowedRecipients: trustedRecipients,
    });
    expect(snapshot.evaluateRecipients(sendEmail, undefined)).toMatchObject({
      allowed: false,
      code: "recipient_not_allowed",
      checks: [{ source: "runtime", outcome: "allow_miss" }],
    });
  });

  it("requires every recipient to match each layer that lists recipients", () => {
    const snapshot = new ActionPolicyService({ allowedRecipients: trustedRecipients }).createSnapshot(
      { ...emptyPolicyRules(), allowedRecipients: ["@company.test"] },
      {
        allowedActions: [],
        blockedActions: [],
        allowedProxies: [],
        allowedRecipients: ["alice@company.test", "pat.lee@partner.test"],
      },
    );
    const prior = [{ source: "deployment" as const, outcome: "allow_match" as const, rule: "outlook.*" }];
    expect(snapshot.evaluateRecipients(sendEmail, ["alice@company.test"], prior)).toEqual({
      allowed: true,
      checks: [
        ...prior,
        { source: "deployment", outcome: "allow_match" },
        { source: "runtime", outcome: "allow_match" },
        { source: "token", outcome: "allow_match" },
      ],
    });
    expect(snapshot.evaluateRecipients(sendEmail, ["pat.lee@partner.test"])).toMatchObject({
      allowed: false,
      checks: [
        { source: "deployment", outcome: "allow_match" },
        { source: "runtime", outcome: "allow_miss" },
        { source: "token", outcome: "allow_match" },
      ],
    });
    expect(snapshot.evaluateRecipients(sendEmail, ["bob@company.test"])).toMatchObject({
      allowed: false,
      message: expect.stringContaining("bob@company.test"),
      checks: [
        { source: "deployment", outcome: "allow_match" },
        { source: "runtime", outcome: "allow_match" },
        { source: "token", outcome: "allow_miss" },
      ],
    });
  });

  it("refuses proxies of mail-sending providers while a recipient policy is active", () => {
    const snapshot = new ActionPolicyService({ allowedRecipients: trustedRecipients }).createSnapshot();
    expect(snapshot.evaluateProxy("outlook", true)).toMatchObject({
      allowed: false,
      code: "recipient_not_allowed",
      checks: [{ source: "deployment", outcome: "allow_miss" }],
    });
    expect(snapshot.evaluateProxy("github")).toEqual({ allowed: true, checks: [] });
  });

  it("reduces display-name recipients to their bare address", () => {
    expect(normalizeRecipientAddress('  "Lee, Pat" <Pat@Example.COM> ')).toBe("pat@example.com");
    expect(normalizeRecipientAddress(" Plain@Example.com ")).toBe("plain@example.com");
  });
});
