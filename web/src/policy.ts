import type { PolicyRules, ProviderDefinition, RuntimePolicyState, RuntimeTokenSummary } from "./model";

export type PolicySource = "deployment" | "runtime" | "token";
export type PolicyResource = "action" | "proxy";
/** Every kind of rule the editor accepts; recipient rules only allow, and are checked when mail is sent. */
export type PolicyRuleResource = PolicyResource | "recipient";
export type AllowMode = "unrestricted" | "restricted";

export interface PolicyLayer {
  source: PolicySource;
  rules: PolicyRules;
}

export interface PolicyTrace {
  source: PolicySource;
  outcome: "unrestricted" | "allow_match" | "allow_miss" | "block_match";
  rule?: string;
}

export interface PolicyEvaluation {
  allowed: boolean;
  code?: "action_not_allowed" | "action_blocked" | "proxy_not_allowed" | "proxy_blocked";
  trace: PolicyTrace[];
}

export interface PolicyCount {
  allowed: number;
  total: number;
}

export interface PolicyEditorDraft {
  rules: PolicyRules;
  actionAllowMode: AllowMode;
  proxyAllowMode: AllowMode;
}

export interface PolicyDraftIssue {
  field: keyof PolicyRules;
  code: "required" | "invalid" | "too_long" | "too_many";
  rule?: string;
}

export function createPolicyEditorDraft(rules: PolicyRules): PolicyEditorDraft {
  return {
    rules: clonePolicyRules(rules),
    actionAllowMode: rules.allowedActions.length > 0 ? "restricted" : "unrestricted",
    proxyAllowMode: rules.allowedProxies.length > 0 ? "restricted" : "unrestricted",
  };
}

export function policyRulesFromEditorDraft(draft: PolicyEditorDraft): PolicyRules {
  return {
    allowedActions: draft.actionAllowMode === "restricted" ? [...draft.rules.allowedActions] : [],
    blockedActions: [...draft.rules.blockedActions],
    allowedProxies: draft.proxyAllowMode === "restricted" ? [...draft.rules.allowedProxies] : [],
    blockedProxies: [...draft.rules.blockedProxies],
    allowedRecipients: [...draft.rules.allowedRecipients],
  };
}

export function policyEditorDraftEquals(left: PolicyEditorDraft, right: PolicyEditorDraft): boolean {
  return (
    left.actionAllowMode === right.actionAllowMode &&
    left.proxyAllowMode === right.proxyAllowMode &&
    policyRulesEqual(left.rules, right.rules)
  );
}

export function validatePolicyEditorDraft(draft: PolicyEditorDraft, includeProxies: boolean): PolicyDraftIssue[] {
  const rules = policyRulesFromEditorDraft(draft);
  const issues: PolicyDraftIssue[] = [];
  if (draft.actionAllowMode === "restricted" && rules.allowedActions.length === 0) {
    issues.push({ field: "allowedActions", code: "required" });
  }
  if (includeProxies && draft.proxyAllowMode === "restricted" && rules.allowedProxies.length === 0) {
    issues.push({ field: "allowedProxies", code: "required" });
  }

  const fields: Array<[keyof PolicyRules, PolicyRuleResource]> = [
    ["allowedActions", "action"],
    ["blockedActions", "action"],
    ...(includeProxies
      ? ([
          ["allowedProxies", "proxy"],
          ["blockedProxies", "proxy"],
        ] as Array<[keyof PolicyRules, PolicyRuleResource]>)
      : []),
    ["allowedRecipients", "recipient"],
  ];
  for (const [field, resource] of fields) {
    if (rules[field].length > 128) {
      issues.push({ field, code: "too_many" });
    }
    for (const rule of rules[field]) {
      const code = policyRuleIssue(rule, resource);
      if (code) {
        issues.push({ field, code, rule });
      }
    }
  }
  return issues;
}

export function policyLayers(policy: RuntimePolicyState, token?: RuntimeTokenSummary): PolicyLayer[] {
  const layers: PolicyLayer[] = [
    { source: "deployment", rules: policy.deployment },
    { source: "runtime", rules: policy.runtime },
  ];
  if (token) {
    layers.push({
      source: "token",
      rules: {
        allowedActions: token.allowedActions,
        blockedActions: token.blockedActions,
        allowedProxies: token.allowedProxies,
        blockedProxies: [],
        allowedRecipients: token.allowedRecipients,
      },
    });
  }
  return layers;
}

export function evaluatePolicy(
  value: string,
  resource: PolicyResource,
  layers: PolicyLayer[],
  connectionId?: string | null,
): PolicyEvaluation {
  const allowedField = resource === "action" ? "allowedActions" : "allowedProxies";
  const blockedField = resource === "action" ? "blockedActions" : "blockedProxies";
  const matches = resource === "action" ? matchesActionRule : matchesProxyRule;
  const trace = layers.map((layer): PolicyTrace => {
    const blocked = layer.rules[blockedField].find(
      (rule) =>
        matches(rule, value) && (resource !== "action" || !rule.includes("@") || rule.split("@")[1] === connectionId),
    );
    if (blocked) {
      return { source: layer.source, outcome: "block_match", rule: blocked };
    }
    if (layer.rules[allowedField].length === 0) {
      return resource === "proxy" && layer.source === "token"
        ? { source: layer.source, outcome: "allow_miss" }
        : { source: layer.source, outcome: "unrestricted" };
    }
    const allowed = layer.rules[allowedField].find(
      (rule) =>
        matches(rule, value) &&
        (resource !== "action" ||
          !rule.includes("@") ||
          connectionId === undefined ||
          rule.split("@")[1] === connectionId),
    );
    return allowed
      ? { source: layer.source, outcome: "allow_match", rule: allowed }
      : { source: layer.source, outcome: "allow_miss" };
  });
  if (trace.some((check) => check.outcome === "block_match")) {
    return { allowed: false, code: resource === "action" ? "action_blocked" : "proxy_blocked", trace };
  }
  if (trace.some((check) => check.outcome === "allow_miss")) {
    return { allowed: false, code: resource === "action" ? "action_not_allowed" : "proxy_not_allowed", trace };
  }
  return { allowed: true, trace };
}

export function countAllowedActions(providers: ProviderDefinition[], layers: PolicyLayer[]): PolicyCount {
  const actions = providers.flatMap((provider) => provider.actions);
  return {
    allowed: actions.filter((action) => evaluatePolicy(action.id, "action", layers).allowed).length,
    total: actions.length,
  };
}

export function countAllowedProxies(providers: ProviderDefinition[], layers: PolicyLayer[]): PolicyCount {
  return {
    allowed: providers.filter((provider) => evaluatePolicy(provider.service, "proxy", layers).allowed).length,
    total: providers.length,
  };
}

export function policyRuleCandidates(providers: ProviderDefinition[], resource: PolicyRuleResource): string[] {
  if (resource === "recipient") {
    return [];
  }
  if (resource === "proxy") {
    return ["*", ...providers.map((provider) => provider.service)];
  }
  return [
    "*",
    ...providers.map((provider) => `${provider.service}.*`),
    ...providers.flatMap((provider) => provider.actions.map((action) => action.id)),
  ];
}

export function filterPolicyRuleCandidates(candidates: string[], query: string, limit = 12): string[] {
  const normalized = query.trim().toLowerCase();
  const matches: string[][] = [[], [], [], [], []];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const value = candidate.toLowerCase();
    if (normalized && !value.includes(normalized)) {
      continue;
    }
    const action = value.slice(value.indexOf(".") + 1);
    let rank = 4;
    if (!normalized || value === normalized) {
      rank = 0;
    } else if (value.startsWith(`${normalized}.`)) {
      rank = 1;
    } else if (value.startsWith(normalized)) {
      rank = 2;
    } else if (action.startsWith(normalized)) {
      rank = 3;
    }
    if (matches[rank].length < limit) {
      matches[rank].push(candidate);
    }
  }
  return matches.flat().slice(0, limit);
}

export function isKnownPolicyRule(
  rule: string,
  resource: PolicyRuleResource,
  providers: ProviderDefinition[],
): boolean {
  if (resource === "recipient") {
    return true;
  }
  if (resource === "action") rule = rule.split("@")[0];
  if (rule === "*") {
    return true;
  }
  if (resource === "proxy") {
    return providers.some((provider) => provider.service === rule);
  }
  if (rule.endsWith(".*")) {
    const service = rule.slice(0, -2);
    return providers.some((provider) => provider.service === service);
  }
  return providers.some((provider) => provider.actions.some((action) => action.id === rule));
}

export function parsePolicyLines(value: string): string[] {
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const line of value.split("\n")) {
    const rule = line.trim();
    if (rule && !seen.has(rule)) {
      seen.add(rule);
      rules.push(rule);
    }
  }
  return rules;
}

export function policyRuleIssue(rule: string, resource: PolicyRuleResource): "invalid" | "too_long" | undefined {
  if (new TextEncoder().encode(rule).byteLength > 256) {
    return "too_long";
  }
  if (resource === "recipient") {
    return /^[^\s@<>,]*@[^\s@<>,]+\.[^\s@<>,]+$/.test(rule) && !rule.endsWith(".") ? undefined : "invalid";
  }
  if (resource === "action" && rule.includes("@")) {
    const parts = rule.split("@");
    if (parts.length !== 2 || !/^[a-zA-Z0-9:_-]+$/.test(parts[1])) return "invalid";
    return policyRuleIssue(parts[0], resource);
  }
  if (rule === "*") {
    return undefined;
  }
  if (resource === "proxy") {
    return rule.includes("*") || /\s/.test(rule) ? "invalid" : undefined;
  }
  if (/^[^\s.*]+\.\*$/.test(rule)) {
    return undefined;
  }
  const separator = rule.indexOf(".");
  return rule.includes("*") || /\s/.test(rule) || separator <= 0 || separator === rule.length - 1
    ? "invalid"
    : undefined;
}

function matchesActionRule(pattern: string, actionId: string): boolean {
  pattern = pattern.split("@")[0];
  if (pattern === "*") {
    return true;
  }
  return pattern.endsWith(".*") ? actionId.startsWith(pattern.slice(0, -1)) : actionId === pattern;
}

function matchesProxyRule(pattern: string, service: string): boolean {
  return pattern === "*" || pattern === service;
}

function clonePolicyRules(rules: PolicyRules): PolicyRules {
  return {
    allowedActions: [...rules.allowedActions],
    blockedActions: [...rules.blockedActions],
    allowedProxies: [...rules.allowedProxies],
    blockedProxies: [...rules.blockedProxies],
    allowedRecipients: [...rules.allowedRecipients],
  };
}

function policyRulesEqual(left: PolicyRules, right: PolicyRules): boolean {
  return (Object.keys(left) as Array<keyof PolicyRules>).every(
    (field) =>
      left[field].length === right[field].length && left[field].every((rule, index) => rule === right[field][index]),
  );
}
