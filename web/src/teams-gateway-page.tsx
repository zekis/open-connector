import type {
  AppData,
  ConnectionRecord,
  TeamsGatewayAgent,
  TeamsGatewayAgentMetrics,
  TeamsGatewayGroup,
} from "./model";
import type { ReactNode } from "react";

import {
  Activity,
  Bot,
  Hash,
  Loader2,
  MessageSquareMore,
  MessagesSquare,
  Play,
  Plus,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { apiGet, apiPost, apiPut } from "./api";
import { Badge, FormStatus } from "./shared-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface TeamsGatewayPageProps {
  data: AppData;
}

export function TeamsGatewayPage(props: TeamsGatewayPageProps): ReactNode {
  const [agents, setAgents] = useState<TeamsGatewayAgent[]>([]);
  const [groups, setGroups] = useState<TeamsGatewayGroup[]>([]);
  const [metrics, setMetrics] = useState<TeamsGatewayAgentMetrics[]>([]);
  const [polling, setPolling] = useState(false);
  const [updatingGroupId, setUpdatingGroupId] = useState<string>();
  const [status, setStatus] = useState<string | null>(null);
  const teamsConnections = usableConnections(props.data.connections).filter(
    (connection) => connection.service === "microsoft_teams",
  );

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

  async function poll(): Promise<void> {
    setPolling(true);
    try {
      const result = await apiPost<{ messages: number; errors: number }>("/api/teams-gateway/poll", {});
      await load();
      setStatus(`Poll complete: ${result.messages} new message(s), ${result.errors} error(s).`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not poll Microsoft Teams.");
    } finally {
      setPolling(false);
    }
  }

  async function setGroupEnabled(group: TeamsGatewayGroup, enabled: boolean): Promise<void> {
    setUpdatingGroupId(group.id);
    try {
      const updated = await apiPut<TeamsGatewayGroup>(`/api/teams-gateway/groups/${encodeURIComponent(group.id)}`, {
        enabled,
      });
      setGroups((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setStatus(
        enabled
          ? `${updated.displayName} is enabled. New messages will be handled from now on.`
          : `${updated.displayName} is disabled. The agent will not read or reply there.`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update the Teams group.");
    } finally {
      setUpdatingGroupId(undefined);
    }
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
          <Button variant="outline" onClick={() => void poll()} disabled={polling}>
            {polling ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Poll now
          </Button>
          <Button asChild>
            <Link to="/teams-gateway/new">
              <Plus size={14} /> New agent
            </Link>
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
          proactive-DM rules remain host-enforced. Disable any detected group where the agent should stay silent.
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
              updatingGroupId={updatingGroupId}
              onSetGroupEnabled={setGroupEnabled}
            />
          ))
        ) : (
          <div className="teams-agent-empty">
            <Bot size={22} />
            <strong>No Teams agents configured</strong>
            <span>Create an agent to start detecting its chats, Teams, and channels.</span>
            <Button asChild>
              <Link to="/teams-gateway/new">
                <Plus size={14} /> New agent
              </Link>
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

interface AgentCardProps {
  agent: TeamsGatewayAgent;
  groups: TeamsGatewayGroup[];
  metrics?: TeamsGatewayAgentMetrics;
  updatingGroupId?: string;
  onSetGroupEnabled(group: TeamsGatewayGroup, enabled: boolean): Promise<void>;
}

function AgentCard({ agent, groups, metrics, updatingGroupId, onSetGroupEnabled }: AgentCardProps): ReactNode {
  const presence = metrics?.presence ?? (agent.enabled ? "online" : "offline");
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
        <Button size="sm" variant="outline" asChild>
          <Link to={`/teams-gateway/${encodeURIComponent(agent.id)}/edit`}>
            <Settings2 size={14} /> Setup
          </Link>
        </Button>
      </header>

      <div className="teams-metric-grid">
        <Metric value={metrics?.handledMessageCount ?? 0} label="Messages" />
        <Metric value={metrics?.replyCount ?? 0} label="Replies" />
        <Metric value={metrics?.activeThreadCount ?? 0} label="Threads" />
        <Metric value={(metrics?.pendingPlanCount ?? 0) + (metrics?.pendingApprovalCount ?? 0)} label="Waiting" />
      </div>

      <div className="teams-group-area">
        <div className="teams-group-heading">
          <span>Detected groups</span>
          <Badge>
            {groups.filter((group) => group.enabled !== false).length}/{groups.length} enabled
          </Badge>
        </div>
        {groups.length ? (
          <div className="teams-group-list">
            {teams.map((team) => (
              <div className={`teams-group-row${team.enabled === false ? " disabled" : ""}`} key={team.id}>
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
                  {team.enabled === false ? <small>Agent communication disabled</small> : null}
                </div>
                <GroupToggle
                  group={team}
                  updating={updatingGroupId === team.id}
                  onSetGroupEnabled={onSetGroupEnabled}
                />
              </div>
            ))}
            {groupChats.map((group) => (
              <div className={`teams-group-row${group.enabled === false ? " disabled" : ""}`} key={group.id}>
                <span className="teams-group-icon">
                  <MessagesSquare size={15} />
                </span>
                <div>
                  <strong>{group.displayName}</strong>
                  <small>
                    {group.members.length} participants
                    {group.enabled === false ? " · Agent communication disabled" : ""}
                  </small>
                </div>
                <GroupToggle
                  group={group}
                  updating={updatingGroupId === group.id}
                  onSetGroupEnabled={onSetGroupEnabled}
                />
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

interface GroupToggleProps {
  group: TeamsGatewayGroup;
  updating: boolean;
  onSetGroupEnabled(group: TeamsGatewayGroup, enabled: boolean): Promise<void>;
}

function GroupToggle({ group, updating, onSetGroupEnabled }: GroupToggleProps): ReactNode {
  const enabled = group.enabled !== false;
  return (
    <Button
      className="teams-group-toggle"
      size="sm"
      variant="outline"
      disabled={updating}
      onClick={() => void onSetGroupEnabled(group, !enabled)}
      aria-label={`${enabled ? "Disable" : "Enable"} ${group.displayName}`}
    >
      {updating ? <Loader2 className="spin" size={12} /> : enabled ? "Disable" : "Enable"}
    </Button>
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
  if (value === "online") return "Online";
  if (value === "pending") return "Connecting";
  return "Offline";
}

function usableConnections(connections: ConnectionRecord[]): Array<ConnectionRecord & { id: string }> {
  return connections.filter((connection): connection is ConnectionRecord & { id: string } =>
    Boolean(connection.id && connection.configured !== false && !connection.virtual),
  );
}
