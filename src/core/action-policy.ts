import type { ActionDefinition } from "./types.ts";

export type PolicySource = "deployment" | "runtime" | "token";

export type PolicyErrorCode =
  | "action_not_allowed"
  | "action_blocked"
  | "proxy_not_allowed"
  | "proxy_blocked"
  | "recipient_not_allowed";

export interface PolicyCheck {
  source: PolicySource;
  outcome: "allow_match" | "block_match" | "allow_miss";
  rule?: string;
}

export type ActionPolicyDecision =
  | { allowed: true; checks: PolicyCheck[] }
  | {
      allowed: false;
      code: PolicyErrorCode;
      message: string;
      checks: PolicyCheck[];
    };

export interface PolicyRules {
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  blockedProxies: string[];
  /** Email addresses or `@domain` rules that mail-sending actions may deliver to. Empty means unrestricted. */
  allowedRecipients: string[];
}

export interface TokenPolicy {
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  allowedRecipients: string[];
}

export interface RuntimePolicyState {
  deployment: PolicyRules;
  runtime: PolicyRules;
  updatedAt?: string;
}

export interface ActionPolicyConfig {
  allowedActions?: string[];
  blockedActions?: string[];
  allowedProxies?: string[];
  blockedProxies?: string[];
  allowedRecipients?: string[];
}

interface CompiledRule {
  pattern: string;
  connectionId?: string;
  matches(value: string): boolean;
}

interface CompiledLayer {
  source: PolicySource;
  allowedActions: CompiledRule[];
  blockedActions: CompiledRule[];
  allowedProxies: CompiledRule[];
  blockedProxies: CompiledRule[];
  allowedRecipients: CompiledRule[];
}

/**
 * Immutable policy view shared by every policy consumer in one request.
 */
export class ActionPolicySnapshot {
  readonly state: RuntimePolicyState;
  private readonly layers: CompiledLayer[];
  private readonly proxyLayers: CompiledLayer[];
  private readonly tokenProxyRules?: CompiledRule[];

  constructor(deployment: PolicyRules, runtime: PolicyRules, token?: TokenPolicy, updatedAt?: string) {
    const deploymentRules = immutablePolicyRules(deployment);
    const runtimeRules = immutablePolicyRules(runtime);
    this.state = Object.freeze({ deployment: deploymentRules, runtime: runtimeRules, updatedAt });
    this.proxyLayers = [compileLayer("deployment", deploymentRules), compileLayer("runtime", runtimeRules)];
    this.layers = [...this.proxyLayers];
    if (token) {
      const tokenRules = immutablePolicyRules({
        allowedActions: token.allowedActions,
        blockedActions: token.blockedActions,
        allowedProxies: token.allowedProxies,
        blockedProxies: [],
        allowedRecipients: token.allowedRecipients,
      });
      const tokenLayer = compileLayer("token", tokenRules);
      this.layers.push(tokenLayer);
      this.tokenProxyRules = tokenLayer.allowedProxies;
    }
  }

  /** Omit connectionId for discovery; execution must pass the resolved ID or null. */
  evaluate(action: ActionDefinition, connectionId?: string | null): ActionPolicyDecision {
    for (const layer of this.layers) {
      const blocked = layer.blockedActions.find(
        (rule) => rule.matches(action.id) && (!rule.connectionId || rule.connectionId === connectionId),
      );
      if (blocked) {
        return {
          allowed: false,
          code: "action_blocked",
          message: `${action.id} is blocked by the local action policy.`,
          checks: [{ source: layer.source, outcome: "block_match", rule: blocked.pattern }],
        };
      }
    }

    const checks: PolicyCheck[] = [];
    for (const layer of this.layers) {
      if (layer.allowedActions.length === 0) {
        continue;
      }
      const allowed = layer.allowedActions.find(
        (rule) =>
          rule.matches(action.id) &&
          (!rule.connectionId || connectionId === undefined || rule.connectionId === connectionId),
      );
      if (!allowed) {
        return {
          allowed: false,
          code: "action_not_allowed",
          message: `${action.id} is not included in the local action allowlist.`,
          checks: [...checks, { source: layer.source, outcome: "allow_miss" }],
        };
      }
      checks.push({ source: layer.source, outcome: "allow_match", rule: allowed.pattern });
    }

    return { allowed: true, checks };
  }

  /**
   * Pass `sendsMail` for services with mail-sending actions: a recipient policy refuses their proxy,
   * because a raw provider request can deliver mail to any address.
   */
  evaluateProxy(service: string, sendsMail = false): ActionPolicyDecision {
    for (const layer of this.proxyLayers) {
      const blocked = layer.blockedProxies.find((rule) => rule.matches(service));
      if (blocked) {
        return {
          allowed: false,
          code: "proxy_blocked",
          message: `${service} proxy is blocked by the local proxy policy.`,
          checks: [{ source: layer.source, outcome: "block_match", rule: blocked.pattern }],
        };
      }
    }

    const checks: PolicyCheck[] = [];
    for (const layer of this.proxyLayers) {
      if (layer.allowedProxies.length === 0) {
        continue;
      }
      const allowed = layer.allowedProxies.find((rule) => rule.matches(service));
      if (!allowed) {
        return {
          allowed: false,
          code: "proxy_not_allowed",
          message: `${service} proxy is not included in the local proxy allowlist.`,
          checks: [...checks, { source: layer.source, outcome: "allow_miss" }],
        };
      }
      checks.push({ source: layer.source, outcome: "allow_match", rule: allowed.pattern });
    }

    if (this.tokenProxyRules) {
      const allowed = this.tokenProxyRules.find((rule) => rule.matches(service));
      if (!allowed) {
        return {
          allowed: false,
          code: "proxy_not_allowed",
          message: `${service} proxy is not granted to this runtime token.`,
          checks: [...checks, { source: "token", outcome: "allow_miss" }],
        };
      }
      checks.push({ source: "token", outcome: "allow_match", rule: allowed.pattern });
    }

    const recipientLayer = sendsMail ? this.layers.find((layer) => layer.allowedRecipients.length > 0) : undefined;
    if (recipientLayer) {
      return {
        allowed: false,
        code: "recipient_not_allowed",
        message: `${service} proxy is unavailable while a recipient policy is active, because proxied requests could send mail to any address.`,
        checks: [...checks, { source: recipientLayer.source, outcome: "allow_miss" }],
      };
    }

    return { allowed: true, checks };
  }

  /** Whether any layer limits who mail-sending actions may deliver to. */
  restrictsRecipients(): boolean {
    return this.layers.some((layer) => layer.allowedRecipients.length > 0);
  }

  /**
   * Check every address a mail-sending action would deliver to against each layer's recipient
   * allowlist. Pass `undefined` when the recipients could not be determined; that is refused while a
   * recipient policy is active. `checks` carries the earlier action checks into the decision.
   */
  evaluateRecipients(
    action: ActionDefinition,
    recipients: readonly string[] | undefined,
    checks: PolicyCheck[] = [],
  ): ActionPolicyDecision {
    const layers = this.layers.filter((layer) => layer.allowedRecipients.length > 0);
    if (layers.length === 0) {
      return { allowed: true, checks };
    }
    if (!recipients) {
      return {
        allowed: false,
        code: "recipient_not_allowed",
        message: `${action.id} was refused because its recipients could not be determined while a recipient policy is active.`,
        checks: [...checks, { source: layers[0].source, outcome: "allow_miss" }],
      };
    }

    const addresses = [...new Set(recipients.map(normalizeRecipientAddress))];
    const nextChecks = [...checks];
    const refused = new Set<string>();
    for (const layer of layers) {
      const missed = addresses.filter((address) => !layer.allowedRecipients.some((rule) => rule.matches(address)));
      for (const address of missed) {
        refused.add(address);
      }
      nextChecks.push({ source: layer.source, outcome: missed.length > 0 ? "allow_miss" : "allow_match" });
    }
    if (refused.size > 0) {
      return {
        allowed: false,
        code: "recipient_not_allowed",
        message: `${action.id} would send mail to recipients outside the recipient allowlist: ${[...refused].join(", ")}.`,
        checks: nextChecks,
      };
    }
    return { allowed: true, checks: nextChecks };
  }
}

/**
 * Deployment execution policy used to construct request-scoped policy snapshots.
 */
export class ActionPolicyService {
  readonly rules: PolicyRules;

  constructor(config: ActionPolicyConfig = {}) {
    this.rules = policyRules(config);
  }

  createSnapshot(
    runtime: PolicyRules = emptyPolicyRules(),
    token?: TokenPolicy,
    updatedAt?: string,
  ): ActionPolicySnapshot {
    return new ActionPolicySnapshot(this.rules, runtime, token, updatedAt);
  }

  evaluate(action: ActionDefinition): ActionPolicyDecision {
    return this.createSnapshot().evaluate(action);
  }

  evaluateProxy(service: string, sendsMail = false): ActionPolicyDecision {
    return this.createSnapshot().evaluateProxy(service, sendsMail);
  }
}

export function emptyPolicyRules(): PolicyRules {
  return {
    allowedActions: [],
    blockedActions: [],
    allowedProxies: [],
    blockedProxies: [],
    allowedRecipients: [],
  };
}

/**
 * Reduce a recipient such as `Name <user@example.com>` to its lowercase bare address.
 */
export function normalizeRecipientAddress(value: string): string {
  const trimmed = value.trim();
  const open = trimmed.lastIndexOf("<");
  const close = trimmed.lastIndexOf(">");
  const address = open >= 0 && close > open ? trimmed.slice(open + 1, close) : trimmed;
  return address.trim().toLowerCase();
}

export function parseActionPolicyList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function policyRules(config: ActionPolicyConfig): PolicyRules {
  return immutablePolicyRules({
    allowedActions: config.allowedActions ?? [],
    blockedActions: config.blockedActions ?? [],
    allowedProxies: config.allowedProxies ?? [],
    blockedProxies: config.blockedProxies ?? [],
    allowedRecipients: config.allowedRecipients ?? [],
  });
}

function immutablePolicyRules(rules: PolicyRules): PolicyRules {
  const immutable = {
    allowedActions: [...rules.allowedActions],
    blockedActions: [...rules.blockedActions],
    allowedProxies: [...rules.allowedProxies],
    blockedProxies: [...rules.blockedProxies],
    allowedRecipients: [...rules.allowedRecipients],
  };
  Object.freeze(immutable.allowedActions);
  Object.freeze(immutable.blockedActions);
  Object.freeze(immutable.allowedProxies);
  Object.freeze(immutable.blockedProxies);
  Object.freeze(immutable.allowedRecipients);
  return Object.freeze(immutable);
}

function compileLayer(source: PolicySource, rules: PolicyRules): CompiledLayer {
  return {
    source,
    allowedActions: rules.allowedActions.map(compileActionRule),
    blockedActions: rules.blockedActions.map(compileActionRule),
    allowedProxies: rules.allowedProxies.map(compileProxyRule),
    blockedProxies: rules.blockedProxies.map(compileProxyRule),
    allowedRecipients: rules.allowedRecipients.map(compileRecipientRule),
  };
}

function compileActionRule(pattern: string): CompiledRule {
  const parts = pattern.split("@");
  const [actionPattern, connectionId] = parts;
  if (parts.length > 2 || (parts.length === 2 && !/^[a-zA-Z0-9:_-]+$/.test(connectionId ?? ""))) {
    return { pattern, matches: () => false };
  }
  if (actionPattern === "*") {
    return { pattern, connectionId, matches: () => true };
  }
  if (actionPattern.endsWith(".*")) {
    const prefix = actionPattern.slice(0, -1);
    return { pattern, connectionId, matches: (actionId) => actionId.startsWith(prefix) };
  }
  return { pattern, connectionId, matches: (actionId) => actionId === actionPattern };
}

function compileProxyRule(pattern: string): CompiledRule {
  return { pattern, matches: pattern === "*" ? () => true : (service) => service === pattern };
}

/** `@example.com` matches every address at exactly that domain; any other rule matches one address. */
function compileRecipientRule(pattern: string): CompiledRule {
  const rule = pattern.trim().toLowerCase();
  if (rule.startsWith("@")) {
    return {
      pattern,
      matches: (address) => {
        const separator = address.lastIndexOf("@");
        return separator > 0 && address.slice(separator) === rule;
      },
    };
  }
  return { pattern, matches: (address) => address === rule };
}
