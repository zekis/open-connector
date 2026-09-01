import type {
  AgentProvider,
  AppData,
  ConnectionRecord,
  TeamsGatewayAgent,
  TeamsGatewayAgentMetrics,
  TeamsGatewayGroup,
} from "./model";
import type { FormEvent, ReactNode } from "react";

import {
  Activity,
  Bot,
  Hash,
  Loader2,
  MessageSquareMore,
  MessagesSquare,
  Play,
  Plus,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { Badge, FormStatus } from "./shared-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  const [groups, setGroups] = useState<TeamsGatewayGroup[]>([]);
  const [metrics, setMetrics] = useState<TeamsGatewayAgentMetrics[]>([]);
  const [draft, setDraft] = useState<AgentDraft>(() => emptyDraft(props.data));
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | "poll" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const teamsConnections = usableConnections(props.data.connections).filter(
    (connection) => connection.service === "microsoft_teams",
  );
  const toolConnections = usableConnections(props.data.connections);
  const configuredAgentProviders = new Set(props.data.agentConnections?.map((connection) => connection.provider));

  const load = useCallback(async (): Promise<void> => {
    const [nextAgents, nextGroups, nextMetrics] = await Promise.all([
      apiGet<TeamsGatewayAgent[]>("/api/teams-gateway/agents"),
      apiGet<TeamsGatewayGroup[]>("/api/teams-gateway/groups"),
      apiGet<TeamsGatewayAgentMetrics[]>("/api/teams-gateway/metrics"),
    ]);
    setAgents(nextAgents);
    setGroups(nextGroups);
    setMetrics(nextMetrics);
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
    setSetupOpen(true);
  }

  function createAgent(): void {
    setDraft(emptyDraft(props.data));
    setStatus(null);
    setSetupOpen(true);
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
      setSetupOpen(false);
      setDraft(emptyDraft(props.data));
      setStatus("Teams agent saved and presence refreshed.");
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
      setSetupOpen(false);
      setDraft(emptyDraft(props.data));
      setStatus("Teams agent and its local thread, contact, and group state were removed.");
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

  const onlineAgents = metrics.filter((item) => item.presence === "online").length;
  const totalConversations = metrics.reduce((total, item) => total + item.activeThreadCount, 0);

  return (
    <div className="teams-gateway-page">
      <section className="teams-gateway-intro">
        <div>
          <span className="agents-eyebrow">
            <MessageSquareMore size={14} /> Teams gateway
          </span>
          <h2>Agents across Teams chats and channels</h2>
          <p>See where each agent is present, what it has handled, and which Teams groups it can respond in.</p>
        </div>
        <div className="button-row">
          <Button variant="outline" onClick={() => void poll()} disabled={busy !== null}>
            {busy === "poll" ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Poll now
          </Button>
          <Button onClick={createAgent} disabled={busy !== null}>
            <Plus size={14} /> New agent
          </Button>
        </div>
      </section>

      <div className="teams-summary-grid">
        <SummaryStat icon={<Activity size={16} />} value={`${onlineAgents}/${agents.length}`} label="Agents online" />
        <SummaryStat icon={<Users size={16} />} value={String(groups.length)} label="Detected groups" />
        <SummaryStat icon={<MessagesSquare size={16} />} value={String(totalConversations)} label="Active threads" />
      </div>

      <Alert>
        <ShieldCheck size={16} />
        <AlertTitle>Group replies keep the same safety policy</AlertTitle>
        <AlertDescription>
          Agents use channel posts and group chat history as context, while domain authorization, plans, approvals, and
          proactive-DM rules remain host-enforced.
        </AlertDescription>
      </Alert>

      {status ? <FormStatus message={status} /> : null}

      <section className="teams-agent-dashboard">
        {agents.length ? (
          agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              groups={groups.filter((group) => group.agentId === agent.id)}
              metrics={metrics.find((item) => item.agentId === agent.id)}
              onEdit={() => edit(agent)}
            />
          ))
        ) : (
          <div className="teams-agent-empty">
            <Bot size={22} />
            <strong>No Teams agents configured</strong>
            <span>Create an agent to start detecting its chats, Teams, and channels.</span>
            <Button onClick={createAgent}>
              <Plus size={14} /> New agent
            </Button>
          </div>
        )}
      </section>

      <Dialog open={setupOpen} onOpenChange={(open) => busy === null && setSetupOpen(open)}>
        <DialogContent className="teams-agent-panel">
          <DialogHeader>
            <DialogTitle>{draft.id ? `Configure ${draft.name}` : "Configure a Teams agent"}</DialogTitle>
            <DialogDescription>
              Bind one M365 identity, choose its AI runtime, and control exactly which provider connections it can use.
            </DialogDescription>
          </DialogHeader>
          <AgentSetupForm
            draft={draft}
            setDraft={setDraft}
            teamsConnections={teamsConnections}
            toolConnections={toolConnections}
            configuredAgentProviders={configuredAgentProviders}
            busy={busy}
            status={status}
            onSave={save}
            onRemove={remove}
            onToggleToolConnection={toggleToolConnection}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface AgentCardProps {
  agent: TeamsGatewayAgent;
  groups: TeamsGatewayGroup[];
  metrics?: TeamsGatewayAgentMetrics;
  onEdit(): void;
}

function AgentCard({ agent, groups, metrics, onEdit }: AgentCardProps): ReactNode {
  const presence = metrics?.presence ?? agent.presence?.status ?? (agent.enabled ? "pending" : "offline");
  const teams = groups.filter((group) => group.kind === "team");
  const groupChats = groups.filter((group) => group.kind === "group_chat");
  return (
    <article className="teams-agent-card">
      <header>
        <div className="teams-agent-identity">
          <span className="teams-agent-avatar">
            <Bot size={20} />
            <i className={`teams-presence-dot ${presence}`} />
          </span>
          <div>
            <h3>{agent.name}</h3>
            <span className={`teams-presence-label ${presence}`}>{presenceLabel(presence)}</span>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Settings2 size={14} /> Setup
        </Button>
      </header>

      {agent.presence?.error ? <p className="teams-presence-error">{agent.presence.error}</p> : null}

      <div className="teams-metric-grid">
        <Metric value={metrics?.handledMessageCount ?? 0} label="Messages" />
        <Metric value={metrics?.replyCount ?? 0} label="Replies" />
        <Metric value={metrics?.activeThreadCount ?? 0} label="Threads" />
        <Metric value={(metrics?.pendingPlanCount ?? 0) + (metrics?.pendingApprovalCount ?? 0)} label="Waiting" />
      </div>

      <div className="teams-group-area">
        <div className="teams-group-heading">
          <span>Detected groups</span>
          <Badge>{teams.length + groupChats.length}</Badge>
        </div>
        {groups.length ? (
          <div className="teams-group-list">
            {teams.map((team) => (
              <div className="teams-group-row" key={team.id}>
                <span className="teams-group-icon">
                  <Users size={15} />
                </span>
                <div>
                  <strong>{team.displayName}</strong>
                  <span>
                    {team.channels.length ? (
                      team.channels.map((channel) => (
                        <span className="teams-channel-chip" key={channel.id}>
                          <Hash size={11} /> {channel.displayName}
                        </span>
                      ))
                    ) : (
                      <small>No visible channels</small>
                    )}
                  </span>
                </div>
              </div>
            ))}
            {groupChats.map((group) => (
              <div className="teams-group-row" key={group.id}>
                <span className="teams-group-icon">
                  <MessagesSquare size={15} />
                </span>
                <div>
                  <strong>{group.displayName}</strong>
                  <small>{group.members.length} participants</small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="teams-groups-empty">No groups detected yet. Poll to discover memberships.</p>
        )}
      </div>
    </article>
  );
}

interface AgentSetupFormProps {
  draft: AgentDraft;
  setDraft(value: AgentDraft): void;
  teamsConnections: Array<ConnectionRecord & { id: string }>;
  toolConnections: Array<ConnectionRecord & { id: string }>;
  configuredAgentProviders: Set<AgentProvider>;
  busy: "save" | "delete" | "poll" | null;
  status: string | null;
  onSave(event: FormEvent): Promise<void>;
  onRemove(): Promise<void>;
  onToggleToolConnection(connectionId: string): void;
}

function AgentSetupForm(props: AgentSetupFormProps): ReactNode {
  const { draft, setDraft } = props;
  return (
    <form className="teams-agent-editor" onSubmit={(event) => void props.onSave(event)}>
      <div className="teams-form-grid">
        <Label className="field">
          <span>Agent name</span>
          <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required />
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
            {props.teamsConnections.map((connection) => (
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
            <option value="claude_code" disabled={!props.configuredAgentProviders.has("claude_code")}>
              Claude Code{props.configuredAgentProviders.has("claude_code") ? "" : " — not connected"}
            </option>
            <option value="openai_codex" disabled={!props.configuredAgentProviders.has("openai_codex")}>
              OpenAI Codex{props.configuredAgentProviders.has("openai_codex") ? "" : " — not connected"}
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
          The exact available actions are captured when saved. Chat sending is excluded so the DM guard stays intact.
        </p>
        <div>
          {props.toolConnections.map((connection) => (
            <label key={connection.id} className="teams-tool-option">
              <input
                type="checkbox"
                checked={draft.toolConnectionIds.includes(connection.id)}
                onChange={() => props.onToggleToolConnection(connection.id)}
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
        <Button type="submit" disabled={props.busy !== null || !draft.name.trim() || !draft.teamsConnectionId}>
          {props.busy === "save" ? <Loader2 className="spin" size={14} /> : <Save size={14} />} Save agent
        </Button>
        {draft.id ? (
          <Button variant="ghost" type="button" disabled={props.busy !== null} onClick={() => void props.onRemove()}>
            {props.busy === "delete" ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />} Delete
          </Button>
        ) : null}
      </div>
      {props.status ? <FormStatus message={props.status} /> : null}
    </form>
  );
}

function SummaryStat({ icon, value, label }: { icon: ReactNode; value: string; label: string }): ReactNode {
  return (
    <div className="teams-summary-stat">
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }): ReactNode {
  return (
    <span>
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  );
}

function presenceLabel(value: TeamsGatewayAgentMetrics["presence"]): string {
  if (value === "online") return "Online in Teams";
  if (value === "error") return "Presence error";
  if (value === "pending") return "Connecting";
  return "Offline";
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
