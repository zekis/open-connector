import type { AgentProvider, AppData, ConnectionRecord, TeamsGatewayAgent } from "./model";
import type { FormEvent, ReactNode } from "react";

import { ArrowLeft, Loader2, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { Badge, EmptyState, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface TeamsGatewayAgentPageProps {
  data: AppData;
}

interface AgentDraft {
  id?: string;
  name: string;
  enabled: boolean;
  teamsConnectionId: string;
  agentProvider: AgentProvider;
  instructions: string;
  allowedDomains: string;
  allowedExternalUsers: string;
  proactiveDmUsers: string;
  confirmBeforeTools: boolean;
  threadWindowHours: string;
  toolConnectionIds: string[];
}

export function TeamsGatewayAgentPage({ data }: TeamsGatewayAgentPageProps): ReactNode {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<AgentDraft>(() => emptyDraft(data));
  const [loading, setLoading] = useState(Boolean(agentId));
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const teamsConnections = usableConnections(data.connections).filter(
    (connection) => connection.service === "microsoft_teams",
  );
  const toolConnections = usableConnections(data.connections);
  const configuredAgentProviders = new Set(data.agentConnections?.map((connection) => connection.provider));
  const actionsByService = useMemo(
    () => new Map(data.providers.map((provider) => [provider.service, provider.actions])),
    [data.providers],
  );

  useEffect(() => {
    if (!agentId) return;
    let active = true;
    void apiGet<TeamsGatewayAgent[]>("/api/teams-gateway/agents")
      .then((agents) => {
        if (!active) return;
        const agent = agents.find((item) => item.id === agentId);
        if (!agent) {
          setNotFound(true);
          return;
        }
        setDraft(agentDraft(agent));
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load the Teams agent.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy("save");
    setError(null);
    const body = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      teamsConnectionId: draft.teamsConnectionId,
      agentProvider: draft.agentProvider,
      instructions: draft.instructions.trim(),
      allowedDomains: csv(draft.allowedDomains),
      allowedExternalUsers: csv(draft.allowedExternalUsers),
      proactiveDmUsers: csv(draft.proactiveDmUsers),
      confirmBeforeTools: draft.confirmBeforeTools,
      threadWindowHours: Number(draft.threadWindowHours),
      toolGrants: draft.toolConnectionIds.map((connectionId) => {
        const connection = toolConnections.find((item) => item.id === connectionId)!;
        const actionIds = (actionsByService.get(connection.service) ?? [])
          .filter((action) => action.execution.locallyExecutable && action.id !== "microsoft_teams.send_chat_message")
          .map((action) => action.id);
        return { connectionId, actionIds };
      }),
    };
    try {
      if (draft.id) await apiPut(`/api/teams-gateway/agents/${encodeURIComponent(draft.id)}`, body);
      else await apiPost("/api/teams-gateway/agents", body);
      navigate("/teams-gateway");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the Teams agent.");
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    if (!draft.id || !window.confirm(`Delete ${draft.name} and its stored Teams threads?`)) return;
    setBusy("delete");
    setError(null);
    try {
      await apiDelete(`/api/teams-gateway/agents/${encodeURIComponent(draft.id)}`);
      navigate("/teams-gateway");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the Teams agent.");
      setBusy(null);
    }
  }

  function toggleToolConnection(connectionId: string): void {
    setDraft((current) => ({
      ...current,
      toolConnectionIds: current.toolConnectionIds.includes(connectionId)
        ? current.toolConnectionIds.filter((id) => id !== connectionId)
        : [...current.toolConnectionIds, connectionId],
    }));
  }

  if (loading) {
    return (
      <div className="teams-agent-setup-page">
        <Loader2 className="spin" size={18} />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="teams-agent-setup-page">
        <BackButton />
        <EmptyState title="Teams agent not found" description="It may have been deleted from another session." />
      </div>
    );
  }

  return (
    <div className="teams-agent-setup-page">
      <BackButton />
      <section className="teams-agent-setup detail-panel">
        <div className="teams-agent-setup-heading">
          <div>
            <h2>{draft.id ? `Edit ${draft.name}` : "Create a Teams agent"}</h2>
            <p>Bind one M365 identity, choose its AI runtime, and control the provider connections it can use.</p>
          </div>
          <Badge tone={draft.enabled ? "success" : undefined}>{draft.enabled ? "Enabled" : "Paused"}</Badge>
        </div>

        {error ? <InlineError message={error} /> : null}
        {teamsConnections.length === 0 ? (
          <InlineError message="Connect a Microsoft Teams account before configuring a gateway agent." />
        ) : null}

        <form className="teams-agent-editor" onSubmit={(event) => void save(event)}>
          <div className="teams-form-grid">
            <Label className="field">
              <span>Agent name</span>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                required
              />
            </Label>
            <Label className="field">
              <span>M365 Teams identity</span>
              <select
                className="agent-model-select"
                value={draft.teamsConnectionId}
                onChange={(event) => setDraft({ ...draft, teamsConnectionId: event.target.value })}
                disabled={Boolean(draft.id)}
                required
              >
                {teamsConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connectionLabel(connection)}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="field">
              <span>Agent runtime</span>
              <select
                className="agent-model-select"
                value={draft.agentProvider}
                onChange={(event) => setDraft({ ...draft, agentProvider: event.target.value as AgentProvider })}
              >
                <option value="claude_code" disabled={!configuredAgentProviders.has("claude_code")}>
                  Claude Code{configuredAgentProviders.has("claude_code") ? "" : " — not connected"}
                </option>
                <option value="openai_codex" disabled={!configuredAgentProviders.has("openai_codex")}>
                  OpenAI Codex{configuredAgentProviders.has("openai_codex") ? "" : " — not connected"}
                </option>
              </select>
            </Label>
            <Label className="field">
              <span>Thread window (hours)</span>
              <Input
                type="number"
                min="1"
                max="168"
                value={draft.threadWindowHours}
                onChange={(event) => setDraft({ ...draft, threadWindowHours: event.target.value })}
                required
              />
            </Label>
          </div>
          <Label className="field">
            <span>Persona and instructions</span>
            <Textarea
              rows={4}
              value={draft.instructions}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              placeholder="How this agent should work and communicate"
            />
          </Label>
          <div className="teams-form-grid">
            <Label className="field">
              <span>Internal domains</span>
              <Input
                value={draft.allowedDomains}
                onChange={(event) => setDraft({ ...draft, allowedDomains: event.target.value })}
                placeholder="company.com, subsidiary.com"
                required
              />
            </Label>
            <Label className="field">
              <span>Authorized external users</span>
              <Input
                value={draft.allowedExternalUsers}
                onChange={(event) => setDraft({ ...draft, allowedExternalUsers: event.target.value })}
                placeholder="partner@example.com"
              />
            </Label>
            <Label className="field teams-form-wide">
              <span>Proactive-DM whitelist</span>
              <Input
                value={draft.proactiveDmUsers}
                onChange={(event) => setDraft({ ...draft, proactiveDmUsers: event.target.value })}
                placeholder="person@company.com"
              />
            </Label>
          </div>
          <fieldset className="teams-tool-picker">
            <legend>Enabled provider connections</legend>
            <p>
              The exact available actions are captured when saved. Chat sending is excluded so the DM guard stays
              intact.
            </p>
            <div>
              {toolConnections.map((connection) => (
                <label key={connection.id} className="teams-tool-option">
                  <input
                    type="checkbox"
                    checked={draft.toolConnectionIds.includes(connection.id)}
                    onChange={() => toggleToolConnection(connection.id)}
                  />
                  <span>
                    <strong>{connectionLabel(connection)}</strong>
                    <small>{connection.service}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="teams-switches">
            <label>
              <input
                type="checkbox"
                checked={draft.confirmBeforeTools}
                onChange={(event) => setDraft({ ...draft, confirmBeforeTools: event.target.checked })}
              />{" "}
              Confirm a plan before using providers
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />{" "}
              Agent enabled
            </label>
          </div>
          <div className="teams-agent-setup-actions">
            <div className="button-row">
              <Button
                type="submit"
                disabled={
                  busy !== null || !draft.name.trim() || !draft.teamsConnectionId || teamsConnections.length === 0
                }
              >
                {busy === "save" ? <Loader2 className="spin" size={14} /> : <Save size={14} />} Save agent
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={busy !== null}
                onClick={() => navigate("/teams-gateway")}
              >
                Cancel
              </Button>
            </div>
            {draft.id ? (
              <Button variant="ghost" type="button" disabled={busy !== null} onClick={() => void remove()}>
                {busy === "delete" ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />} Delete
              </Button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}

function BackButton(): ReactNode {
  return (
    <Button variant="ghost" asChild>
      <Link to="/teams-gateway">
        <ArrowLeft size={14} />
        Back to Teams gateway
      </Link>
    </Button>
  );
}

function agentDraft(agent: TeamsGatewayAgent): AgentDraft {
  return {
    id: agent.id,
    name: agent.name,
    enabled: agent.enabled,
    teamsConnectionId: agent.teamsConnectionId,
    agentProvider: agent.agentProvider,
    instructions: agent.instructions ?? "",
    allowedDomains: agent.allowedDomains.join(", "),
    allowedExternalUsers: agent.allowedExternalUsers.join(", "),
    proactiveDmUsers: agent.proactiveDmUsers.join(", "),
    confirmBeforeTools: agent.confirmBeforeTools,
    threadWindowHours: String(agent.threadWindowHours),
    toolConnectionIds: agent.toolGrants.map((grant) => grant.connectionId),
  };
}

function emptyDraft(data: AppData): AgentDraft {
  const teams = usableConnections(data.connections).find((connection) => connection.service === "microsoft_teams");
  const providers = new Set(data.agentConnections?.map((connection) => connection.provider));
  return {
    name: "",
    enabled: true,
    teamsConnectionId: teams?.id ?? "",
    agentProvider: providers.has("claude_code") ? "claude_code" : "openai_codex",
    instructions: "",
    allowedDomains: "",
    allowedExternalUsers: "",
    proactiveDmUsers: "",
    confirmBeforeTools: true,
    threadWindowHours: "12",
    toolConnectionIds: [],
  };
}

function usableConnections(connections: ConnectionRecord[]): Array<ConnectionRecord & { id: string }> {
  return connections.filter((connection): connection is ConnectionRecord & { id: string } =>
    Boolean(connection.id && connection.configured !== false && !connection.virtual),
  );
}

function connectionLabel(connection: ConnectionRecord): string {
  const displayName =
    connection.profile && typeof connection.profile.displayName === "string"
      ? connection.profile.displayName
      : undefined;
  return displayName ?? connection.connectionName ?? connection.service;
}

function csv(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
