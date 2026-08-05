import type { AppData, ConnectionRecord, FlowDefinition, FlowRun, FlowRunDetail } from "./model";
import type { ReactNode } from "react";

import {
  AlarmClock,
  Braces,
  CirclePlay,
  FilePlus2,
  GitCompareArrows,
  Mail,
  MousePointerClick,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { apiDelete, apiPost, apiPut } from "./api";
import { Badge, EmptyState, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";

interface FlowsPageProps {
  data: AppData;
  onRefresh(): void;
}

export function FlowsPage(props: FlowsPageProps): ReactNode {
  const flows = props.data.flows ?? [];
  const flowRuns = props.data.flowRuns ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <strong>Two connections. One direction. One agent.</strong>
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
            description="Create a Flow to connect a source, a destination, and a Claude agent."
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
  const source = props.data.connections.find((connection) => connection.id === props.flow.sourceConnectionId);
  const destination = props.data.connections.find((connection) => connection.id === props.flow.destinationConnectionId);
  const latestRun = props.latestRun;
  const tone =
    latestRun?.status === "failed"
      ? "error"
      : latestRun?.status === "waiting_for_approval"
        ? "warning"
        : latestRun?.status === "completed"
          ? "success"
          : undefined;

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
        <span>{source ? connectionLabel(source) : "Missing source"}</span>
        <strong>→</strong>
        <span>{destination ? connectionLabel(destination) : "Missing destination"}</span>
      </div>
      <div className="flow-card-meta">
        <FlowTriggerBadge flow={props.flow} />
        <span>{props.flow.tools.length} tools</span>
        <span>Claude Code</span>
        {latestRun ? <Badge tone={tone}>{latestRun.status.replaceAll("_", " ")}</Badge> : <span>Never run</span>}
      </div>
      {latestRun?.finalOutput ? <p className="flow-run-output">{latestRun.finalOutput}</p> : null}
      {latestRun?.errorMessage ? <InlineError message={latestRun.errorMessage} /> : null}
      <div className="button-row">
        <Button size="sm" disabled={props.busy || props.flow.status !== "active"} onClick={props.onRun}>
          <CirclePlay size={14} />
          Run now
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/flows/${props.flow.id}/edit`}>
            <Pencil size={14} />
            Edit
          </Link>
        </Button>
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onToggle}>
          {props.flow.status === "active" ? "Pause" : "Activate"}
        </Button>
        <Button
          className="flow-delete-button"
          variant="ghost"
          size="icon-sm"
          disabled={props.busy}
          aria-label={`Delete ${props.flow.name}`}
          onClick={props.onDelete}
        >
          <Trash2 size={14} />
        </Button>
      </div>
    </article>
  );
}

function FlowTriggerBadge(props: { flow: FlowDefinition }): ReactNode {
  const trigger = props.flow.trigger;
  const detail =
    trigger.type === "schedule"
      ? `${trigger.cron} · ${trigger.timeZone}`
      : trigger.type === "new_email" || trigger.type === "file_created"
        ? `every ${trigger.pollIntervalSeconds}s`
        : undefined;
  const config =
    trigger.type === "api"
      ? { icon: Braces, label: "API call" }
      : trigger.type === "schedule"
        ? { icon: AlarmClock, label: "Schedule" }
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

function connectionLabel(connection: ConnectionRecord): string {
  const displayName =
    connection.profile && typeof connection.profile.displayName === "string" && connection.profile.displayName.trim()
      ? connection.profile.displayName
      : connection.connectionName;
  return displayName ? `${displayName} · ${connection.service}` : connection.service;
}
