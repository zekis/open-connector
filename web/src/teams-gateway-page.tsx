import type { AgentProvider, AppData, ConnectionRecord, TeamsGatewayAgent, TeamsGatewayThread } from "./model";
import type { FormEvent, ReactNode } from "react";

import { Bot, Loader2, MessageSquareMore, Play, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { Badge, FormStatus } from "./shared-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface TeamsGatewayPageProps {
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

export function TeamsGatewayPage(props: TeamsGatewayPageProps): ReactNode {
  const [agents, setAgents] = useState<TeamsGatewayAgent[]>([]);
  const [threads, setThreads] = useState<TeamsGatewayThread[]>([]);
  const [draft, setDraft] = useState<AgentDraft>(() => emptyDraft(props.data));
  const [busy, setBusy] = useState<"save" | "delete" | "poll" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const teamsConnections = usableConnections(props.data.connections).filter(
    (connection) => connection.service === "microsoft_teams",
  );
  const toolConnections = usableConnections(props.data.connections);
  const configuredAgentProviders = new Set(props.data.agentConnections?.map((connection) => connection.provider));

  const load = useCallback(async (): Promise<void> => {
    const [nextAgents, nextThreads] = await Promise.all([
      apiGet<TeamsGatewayAgent[]>("/api/teams-gateway/agents"),
      apiGet<TeamsGatewayThread[]>("/api/teams-gateway/threads"),
    ]);
    setAgents(nextAgents);
    setThreads(nextThreads);
  }, []);

  useEffect(() => {
    void load().catch((error) => setStatus(error instanceof Error ? error.message : "Could not load Teams gateway."));
  }, [load]);

  const actionsByService = useMemo(
    () => new Map(props.data.providers.map((provider) => [provider.service, provider.actions])),
    [props.data.providers],
  );

  function edit(agent: TeamsGatewayAgent): void {
    setDraft({
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
    });
    setStatus(null);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy("save");
    setStatus(null);
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
      await load();
      setDraft(emptyDraft(props.data));
      setStatus("Teams agent saved. New DMs will be picked up by the gateway worker.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the Teams agent.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    if (!draft.id || !window.confirm(`Delete ${draft.name} and its stored Teams threads?`)) return;
    setBusy("delete");
    try {
      await apiDelete(`/api/teams-gateway/agents/${encodeURIComponent(draft.id)}`);
      await load();
      setDraft(emptyDraft(props.data));
      setStatus("Teams agent and its local thread/contact state were removed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete the Teams agent.");
    } finally {
      setBusy(null);
    }
  }

  async function poll(): Promise<void> {
    setBusy("poll");
    try {
      const result = await apiPost<{ messages: number; errors: number }>("/api/teams-gateway/poll", {});
      await load();
      setStatus(`Poll complete: ${result.messages} new message(s), ${result.errors} error(s).`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not poll Microsoft Teams.");
    } finally {
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

  if (teamsConnections.length === 0) {
    return (
      <div className="teams-gateway-page">
        <Alert>
          <MessageSquareMore size={16} />
          <AlertTitle>Connect a Microsoft Teams account first</AlertTitle>
          <AlertDescription>
            Each gateway agent posts as a licensed M365 user. Connect that user under the Microsoft Teams provider, then
            return here to bind it to Claude or Codex.
          </AlertDescription>
        </Alert>
        <Button asChild>
          <Link to="/providers/microsoft_teams">Open Microsoft Teams provider</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="teams-gateway-page">
      <section className="teams-gateway-intro">
        <div>
          <span className="agents-eyebrow">
            <MessageSquareMore size={14} /> Teams identities
          </span>
          <h2>Run 1:1 agents through real Microsoft Teams accounts</h2>
          <p>
            Every agent gets an exact set of provider connections. Planning, approvals, domain checks, and DM initiation
            rules stay host-enforced.
          </p>
        </div>
        <div className="button-row">
          <Button variant="outline" onClick={() => void poll()} disabled={busy !== null}>
            {busy === "poll" ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Poll now
          </Button>
          <Button variant="outline" onClick={() => setDraft(emptyDraft(props.data))} disabled={busy !== null}>
            <Plus size={14} /> New agent
          </Button>
        </div>
      </section>

      <Alert>
        <ShieldCheck size={16} />
        <AlertTitle>Two independent DM gates</AlertTitle>
        <AlertDescription>
          An external recipient must be explicitly authorized, and every recipient must have DMed the agent first or be
          on the proactive-DM whitelist.
        </AlertDescription>
      </Alert>

      <div className="teams-gateway-layout">
        <aside className="teams-agent-list">
          {agents.length ? (
            agents.map((agent) => {
              const agentThreads = threads.filter((thread) => thread.agentId === agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  className={draft.id === agent.id ? "teams-agent-row active" : "teams-agent-row"}
                  onClick={() => edit(agent)}
                >
                  <span>
                    <Bot size={16} />
                    <strong>{agent.name}</strong>
                  </span>
                  <span>
                    {agentThreads.length} chats{" "}
                    <Badge tone={agent.enabled ? "success" : undefined}>{agent.enabled ? "Active" : "Paused"}</Badge>
                  </span>
                </button>
              );
            })
          ) : (
            <p className="teams-agent-empty">No Teams agents configured yet.</p>
          )}
        </aside>

        <form className="teams-agent-editor" onSubmit={(event) => void save(event)}>
          <div className="teams-editor-heading">
            <div>
              <span>{draft.id ? "Edit Teams agent" : "New Teams agent"}</span>
              <h3>{draft.name || "Unnamed agent"}</h3>
            </div>
            {draft.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Paused</Badge>}
          </div>
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
              The exact currently available actions are captured when you save. Chat sending is excluded so the DM guard
              cannot be bypassed.
            </p>
            <div>
              {toolConnections.map((connection) => (
                <label key={connection.id} className="teams-tool-option">
                  <input
                    type="checkbox"
                    checked={draft.toolConnectionIds.includes(connection.id!)}
                    onChange={() => toggleToolConnection(connection.id!)}
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
          <div className="button-row">
            <Button type="submit" disabled={busy !== null || !draft.name.trim() || !draft.teamsConnectionId}>
              {busy === "save" ? <Loader2 className="spin" size={14} /> : <Save size={14} />} Save agent
            </Button>
            {draft.id ? (
              <Button variant="ghost" type="button" disabled={busy !== null} onClick={() => void remove()}>
                {busy === "delete" ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />} Delete
              </Button>
            ) : null}
          </div>
          {status ? <FormStatus message={status} /> : null}
        </form>
      </div>
    </div>
  );
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
