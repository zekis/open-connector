import type { TeamsGatewayAgent } from "./teams-gateway-types.ts";

export interface TeamsGatewayRecipientDecision {
  allowed: boolean;
  domainAllowed: boolean;
  contactAllowed: boolean;
  reason?: "external_not_authorized" | "no_prior_contact";
}

export function isTeamsRecipientAuthorized(agent: TeamsGatewayAgent, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1] ?? "";
  return agent.allowedDomains.includes(domain) || agent.allowedExternalUsers.includes(normalized);
}

export function evaluateTeamsOutboundRecipient(
  agent: TeamsGatewayAgent,
  email: string,
  hasPriorContact: boolean,
): TeamsGatewayRecipientDecision {
  const normalized = email.trim().toLowerCase();
  const domainAllowed = isTeamsRecipientAuthorized(agent, normalized);
  const contactAllowed = hasPriorContact || agent.proactiveDmUsers.includes(normalized);
  if (!domainAllowed) {
    return { allowed: false, domainAllowed, contactAllowed, reason: "external_not_authorized" };
  }
  if (!contactAllowed) {
    return { allowed: false, domainAllowed, contactAllowed, reason: "no_prior_contact" };
  }
  return { allowed: true, domainAllowed, contactAllowed };
}

export function approvalCode(id: string): string {
  return id
    .replace(/[^a-z0-9]/giu, "")
    .slice(0, 6)
    .toUpperCase();
}
