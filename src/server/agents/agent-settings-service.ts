import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";

export type AgentRuntimeProvider = "claude_code";

export interface AgentRuntimeSettings {
  provider: AgentRuntimeProvider;
  model: string;
}

export interface AgentModelOption {
  id: string;
  displayName: string;
}

export interface AgentModelSource {
  listModels(): Promise<AgentModelOption[]>;
}

interface StoredAgentSettings {
  authType: "custom_credential";
  values: {
    model: string;
  };
  profile: {
    accountId: string;
    displayName: string;
    grantedScopes: string[];
  };
  metadata: {
    agentProvider: AgentRuntimeProvider;
    configType: "agent_runtime_settings";
  };
}

const connectionName = "default";
const provider: AgentRuntimeProvider = "claude_code";
const defaultModel = "opus";

export function defaultAgentModel(): string {
  return defaultModel;
}

/**
 * Owns runtime settings shared by every Flow that selects an agent provider.
 */
export class AgentSettingsService {
  private readonly store: Pick<IConnectionStore, "get" | "set">;
  private readonly models: AgentModelSource;

  constructor(store: Pick<IConnectionStore, "get" | "set">, models: AgentModelSource) {
    this.store = store;
    this.models = models;
  }

  async list(): Promise<AgentRuntimeSettings[]> {
    return [await this.get(provider)];
  }

  async get(provider: AgentRuntimeProvider): Promise<AgentRuntimeSettings> {
    const stored = await this.store.get(internalService(provider), connectionName);
    if (!stored) {
      return {
        provider,
        model: defaultAgentModel(),
      };
    }
    if (!isAgentSettings(stored, provider)) {
      throw new AgentSettingsError("invalid_agent_settings", `Stored ${provider} agent settings are invalid.`, 503);
    }
    return {
      provider,
      model: stored.credential.values.model,
    };
  }

  async update(providerInput: string, input: unknown): Promise<AgentRuntimeSettings> {
    const provider = readProvider(providerInput);
    const model = readModel(input);
    const models = await this.readAvailableModels();
    if (!models.some((option) => option.id === model)) {
      throw new AgentSettingsError("invalid_model", `Anthropic model is not available: ${model}.`);
    }
    await this.store.set(internalService(provider), connectionName, {
      authType: "custom_credential",
      values: { model },
      profile: {
        accountId: provider,
        displayName: "Claude Code settings",
        grantedScopes: [],
      },
      metadata: {
        agentProvider: provider,
        configType: "agent_runtime_settings",
      },
    });
    return { provider, model };
  }

  async listModels(providerInput: string): Promise<AgentModelOption[]> {
    readProvider(providerInput);
    return await this.readAvailableModels();
  }

  private async readAvailableModels(): Promise<AgentModelOption[]> {
    try {
      const models = await this.models.listModels();
      if (models.length === 0) {
        throw new AgentSettingsError("agent_models_unavailable", "Anthropic returned no Claude models.", 503);
      }
      return [...models].sort((left, right) => {
        if (left.id === defaultModel) {
          return -1;
        }
        if (right.id === defaultModel) {
          return 1;
        }
        return left.displayName.localeCompare(right.displayName);
      });
    } catch (error) {
      if (error instanceof AgentSettingsError) {
        throw error;
      }
      throw new AgentSettingsError(
        "agent_models_unavailable",
        error instanceof Error ? error.message : "Anthropic models are unavailable.",
        503,
      );
    }
  }
}

export class AgentSettingsError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 503;

  constructor(code: string, message: string, status: 400 | 404 | 503 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function internalService(provider: AgentRuntimeProvider): string {
  return `agent_settings_${provider}`;
}

function readProvider(value: string): AgentRuntimeProvider {
  if (value === "claude_code") {
    return value;
  }
  throw new AgentSettingsError("agent_provider_not_found", `Agent provider not found: ${value}.`, 404);
}

function readModel(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentSettingsError("invalid_input", "Agent settings body must be a JSON object.");
  }
  const model = (input as { model?: unknown }).model;
  if (typeof model !== "string" || !model.trim()) {
    throw new AgentSettingsError("invalid_input", "model is required.");
  }
  const normalized = model.trim();
  if (normalized.length > 200 || /\s/.test(normalized)) {
    throw new AgentSettingsError("invalid_input", "model must be a single identifier of at most 200 characters.");
  }
  return normalized;
}

function isAgentSettings(
  stored: StoredConnection,
  provider: AgentRuntimeProvider,
): stored is StoredConnection & { credential: StoredAgentSettings } {
  return (
    stored.credential.authType === "custom_credential" &&
    stored.credential.metadata.agentProvider === provider &&
    stored.credential.metadata.configType === "agent_runtime_settings" &&
    typeof stored.credential.values.model === "string" &&
    Boolean(stored.credential.values.model)
  );
}
