import type { AppData, ConnectionRecord, FlowDefinition, FlowRun, FlowRunDetail, ProviderDefinition } from "./model";
import type { ReactNode } from "react";

import {
  AlarmClock,
  ArrowRight,
  Braces,
  BrainCircuit,
  Cable,
  CirclePlay,
  FilePlus2,
  GitCompareArrows,
  Info,
  Mail,
  MousePointerClick,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { apiDelete, apiPost, apiPut } from "./api";
import { ChatMarkdown } from "./chat-markdown";
import { flowSourceConnectionIds } from "./model";
import { Badge, EmptyState, InlineError, ProviderIcon } from "./shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface FlowsPageProps {
  data: AppData;
  onRefresh(): void;
}

export function FlowsPage(props: FlowsPageProps): ReactNode {
  const flows = props.data.flows ?? [];
  const flowRuns = props.data.flowRuns ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasRunningFlow = flowRuns.some((run) => run.status === "running");

  useEffect(() => {
    if (!hasRunningFlow) return;
    const timer = window.setInterval(props.onRefresh, 2_000);
    return () => window.clearInterval(timer);
  }, [hasRunningFlow, props.onRefresh]);

  async function mutate(key: string, operation: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      await operation();
      props.onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The Flow operation failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flows-page">
      <div className="flows-toolbar">
        <div>
          <strong>Many sources. One destination. One agent.</strong>
          <p>Select a Flow to run it or open its dedicated builder to make changes.</p>
        </div>
        <Button asChild>
          <Link to="/flows/new">
            <Plus size={15} />
            New Flow
          </Link>
        </Button>
      </div>

      {error ? <InlineError message={error} /> : null}

      <section className="flow-section">
        <div className="flow-section-heading">
          <GitCompareArrows size={17} />
          <h2>Flows</h2>
          <Badge>{flows.length}</Badge>
        </div>
        {flows.length === 0 ? (
          <EmptyState
            title="No Flows yet"
            description="Create a Flow to connect one or more sources, a destination, and a subscription agent."
          />
        ) : (
          <div className="flow-card-grid">
            {flows.map((flow) => {
              const latestRun = flowRuns.find((run) => run.flowId === flow.id);
              return (
                <FlowCard
                  key={flow.id}
                  flow={flow}
                  latestRun={latestRun}
                  data={props.data}
                  busy={busy !== null}
                  onRun={() => mutate(`run:${flow.id}`, () => apiPost<FlowRunDetail>(`/api/flows/${flow.id}/runs`, {}))}
                  onToggle={() =>
                    mutate(`toggle:${flow.id}`, () =>
                      apiPut(`/api/flows/${flow.id}`, {
                        ...flow,
                        status: flow.status === "active" ? "paused" : "active",
                      }),
                    )
                  }
                  onDelete={() => {
                    if (window.confirm(`Delete "${flow.name}"? Existing run history is retained.`)) {
                      void mutate(`delete:${flow.id}`, () => apiDelete(`/api/flows/${flow.id}`));
                    }
                  }}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function FlowCard(props: {
  flow: FlowDefinition;
  latestRun: FlowRun | undefined;
  data: AppData;
  busy: boolean;
  onRun(): void;
  onToggle(): void;
  onDelete(): void;
}): ReactNode {
  const sources = flowSourceConnectionIds(props.flow).flatMap((id) => {
    const connection = props.data.connections.find((candidate) => candidate.id === id);
    return connection
      ? [{ connection, provider: props.data.providers.find((provider) => provider.service === connection.service) }]
      : [];
  });
  const destination = props.data.connections.find((connection) => connection.id === props.flow.destinationConnectionId);
  const triggerConnectionId =
    props.flow.trigger.type === "event" ||
    props.flow.trigger.type === "new_email" ||
    props.flow.trigger.type === "file_created"
      ? props.flow.trigger.connectionId
      : undefined;
  const triggerSource = sources.find(({ connection }) => connection.id === triggerConnectionId) ?? sources[0];
  const destinationProvider = props.data.providers.find((provider) => provider.service === destination?.service);
  const latestRun = props.latestRun;
  const tone = latestRun ? flowRunTone(latestRun.status) : undefined;

  return (
    <article className="flow-card">
      <div className="flow-card-heading">
        <div>
          <h3>{props.flow.name}</h3>
          <p>{props.flow.instructions}</p>
        </div>
        <Badge tone={props.flow.status === "active" ? "success" : "warning"}>{props.flow.status}</Badge>
      </div>
      <div className="flow-path">
        <div className="flow-source-endpoints">
          {sources.map(({ connection, provider }) => (
            <FlowEndpoint role="source" connection={connection} provider={provider} key={connection.id} />
          ))}
        </div>
        <div className="flow-path-direction" aria-label="Flows from source to destination">
          <span />
          <ArrowRight size={16} />
          <span />
        </div>
        <FlowEndpoint
          role="destination"
          connection={destination}
          provider={destinationProvider}
          synapseId={props.flow.destinationSynapseId}
        />
      </div>
      <div className="flow-card-meta">
        <FlowTriggerBadge flow={props.flow} sourceProvider={triggerSource?.provider} />
        <span>{props.flow.tools.length} tools</span>
        <span>{props.flow.agent.provider === "openai_codex" ? "OpenAI Codex" : "Claude Code"}</span>
        {latestRun ? (
          <span className="flow-last-run">
            <Badge tone={tone}>{latestRun.status.replaceAll("_", " ")}</Badge>
            <FlowRunDetails flowName={props.flow.name} run={latestRun} />
          </span>
        ) : (
          <span>Never run</span>
        )}
      </div>
      <div className="button-row">
        <Button
          size="icon-sm"
          disabled={props.busy || props.flow.status !== "active"}
          aria-label={`Run ${props.flow.name}`}
          title="Run now"
          onClick={props.onRun}
        >
          <CirclePlay size={14} />
        </Button>
        <Button variant="outline" size="icon-sm" asChild>
          <Link to={`/flows/${props.flow.id}/edit`} aria-label={`Edit ${props.flow.name}`} title="Edit Flow">
            <Pencil size={14} />
          </Link>
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={props.busy}
          aria-label={`${props.flow.status === "active" ? "Pause" : "Activate"} ${props.flow.name}`}
          title={props.flow.status === "active" ? "Pause Flow" : "Activate Flow"}
          onClick={props.onToggle}
        >
          {props.flow.status === "active" ? <Pause size={14} /> : <Play size={14} />}
        </Button>
        <Button
          className="flow-delete-button"
          variant="ghost"
          size="icon-sm"
          disabled={props.busy}
          aria-label={`Delete ${props.flow.name}`}
          title="Delete Flow"
          onClick={props.onDelete}
        >
          <Trash2 size={14} />
        </Button>
      </div>
    </article>
  );
}

function FlowRunDetails(props: { flowName: string; run: FlowRun }): ReactNode {
  const run = props.run;
  const hasResult = Boolean(run.finalOutput || run.errorMessage);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          className="flow-run-info-button"
          variant="ghost"
          size="icon-xs"
          aria-label={`View last run details for ${props.flowName}`}
          title="View last run details"
        >
          <Info size={14} />
        </Button>
      </DialogTrigger>
      <DialogContent className="flow-run-dialog">
        <DialogHeader>
          <DialogTitle>Last run · {props.flowName}</DialogTitle>
          <DialogDescription>
            Started {formatFlowRunTime(run.startedAt)}
            {run.completedAt ? ` · Finished ${formatFlowRunTime(run.completedAt)}` : ""} · {run.stepCount} steps
          </DialogDescription>
        </DialogHeader>
        <div className="flow-run-dialog-summary">
          <span>Status</span>
          <Badge tone={flowRunTone(run.status)}>{run.status.replaceAll("_", " ")}</Badge>
        </div>
        <div className="flow-run-dialog-content">
          {run.errorMessage ? <InlineError message={run.errorMessage} /> : null}
          {run.finalOutput ? <ChatMarkdown>{run.finalOutput}</ChatMarkdown> : null}
          {!hasResult ? (
            <p className="flow-run-dialog-empty">
              {run.status === "running" || run.status === "waiting_for_approval"
                ? "This run is still in progress."
                : "No output was recorded for this run."}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function flowRunTone(status: FlowRun["status"]): "success" | "warning" | "error" | undefined {
  if (status === "failed") return "error";
  if (status === "waiting_for_approval") return "warning";
  if (status === "completed") return "success";
  return undefined;
}

function formatFlowRunTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function FlowEndpoint(props: {
  role: "source" | "destination";
  connection: ConnectionRecord | undefined;
  provider: ProviderDefinition | undefined;
  synapseId?: string;
}): ReactNode {
  const roleLabel = props.role === "source" ? "Source" : "Destination";
  const providerName = props.synapseId
    ? "Synapse canvas"
    : (props.provider?.displayName ?? props.connection?.service ?? `Missing ${props.role}`);
  const connectionName = props.synapseId
    ? props.synapseId
    : props.connection
      ? connectionDisplayName(props.connection)
      : "Choose a connection to repair";

  return (
    <div className={`flow-endpoint ${props.role}`} title={`${providerName} · ${connectionName}`}>
      <div className="flow-endpoint-icon">
        {props.synapseId ? (
          <span className="flow-endpoint-icon-fallback">
            <BrainCircuit size={20} />
          </span>
        ) : props.provider ? (
          <ProviderIcon provider={props.provider} large />
        ) : (
          <span className="flow-endpoint-icon-fallback">
            <Cable size={20} />
          </span>
        )}
      </div>
      <div className="flow-endpoint-copy">
        <small>{roleLabel}</small>
        <strong>{providerName}</strong>
        <span>{connectionName}</span>
      </div>
    </div>
  );
}

function FlowTriggerBadge(props: { flow: FlowDefinition; sourceProvider: ProviderDefinition | undefined }): ReactNode {
  const trigger = props.flow.trigger;
  const providerEvent =
    trigger.type === "event" ? props.sourceProvider?.events?.find((event) => event.id === trigger.eventId) : undefined;
  const detail =
    trigger.type === "schedule"
      ? `${trigger.cron} · ${trigger.timeZone}`
      : trigger.type === "event" || trigger.type === "new_email" || trigger.type === "file_created"
        ? `every ${trigger.pollIntervalSeconds}s`
        : undefined;
  const config =
    trigger.type === "api"
      ? { icon: Braces, label: "API call" }
      : trigger.type === "schedule"
        ? { icon: AlarmClock, label: "Schedule" }
        : trigger.type === "event"
          ? { icon: Radio, label: providerEvent?.displayName ?? "Connector event" }
          : trigger.type === "new_email"
            ? { icon: Mail, label: "New email" }
            : trigger.type === "file_created"
              ? { icon: FilePlus2, label: "File created" }
              : { icon: MousePointerClick, label: "Manual" };
  const Icon = config.icon;
  return (
    <span className="flow-trigger-badge" title={detail}>
      <Icon size={13} />
      {config.label}
      {detail ? <small>{detail}</small> : null}
    </span>
  );
}

function connectionDisplayName(connection: ConnectionRecord): string {
  const displayName =
    connection.profile && typeof connection.profile.displayName === "string" && connection.profile.displayName.trim()
      ? connection.profile.displayName
      : connection.connectionName;
  return displayName || connection.connectionName || "Default connection";
}
