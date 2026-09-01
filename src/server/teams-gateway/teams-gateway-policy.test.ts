import type { TeamsGatewayAgent } from "./teams-gateway-types.ts";

import { describe, expect, it } from "vitest";
import { approvalCode, evaluateTeamsOutboundRecipient, isTeamsRecipientAuthorized } from "./teams-gateway-policy.ts";

const agent: TeamsGatewayAgent = {
  id: "agent-1",
  name: "Operations agent",
  enabled: true,
  teamsConnectionId: "teams-1",
  agentProvider: "claude_code",
  allowedDomains: ["company.test"],
  allowedExternalUsers: ["partner@outside.test"],
  proactiveDmUsers: ["allowed@company.test", "partner@outside.test"],
  confirmBeforeTools: true,
  threadWindowHours: 12,
  toolGrants: [],
  watchStartedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("Teams gateway recipient policy", () => {
  it("authorizes internal domains and explicitly allowed external users", () => {
    expect(isTeamsRecipientAuthorized(agent, "Person@Company.Test")).toBe(true);
    expect(isTeamsRecipientAuthorized(agent, "PARTNER@outside.test")).toBe(true);
    expect(isTeamsRecipientAuthorized(agent, "stranger@outside.test")).toBe(false);
  });

  it("requires both recipient authorization and prior contact or proactive whitelisting", () => {
    expect(evaluateTeamsOutboundRecipient(agent, "known@company.test", true)).toMatchObject({ allowed: true });
    expect(evaluateTeamsOutboundRecipient(agent, "allowed@company.test", false)).toMatchObject({ allowed: true });
    expect(evaluateTeamsOutboundRecipient(agent, "new@company.test", false)).toMatchObject({
      allowed: false,
      reason: "no_prior_contact",
    });
    expect(evaluateTeamsOutboundRecipient(agent, "stranger@outside.test", true)).toMatchObject({
      allowed: false,
      reason: "external_not_authorized",
    });
  });

  it("creates short stable approval codes without punctuation", () => {
    expect(approvalCode("abc-12_34-xyz")).toBe("ABC123");
  });
});
