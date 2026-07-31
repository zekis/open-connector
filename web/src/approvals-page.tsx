import type { AppData, ConnectionRecord, FlowApproval, FlowDefinition, FlowRunDetail, FlowRunStatus } from "./model";
import type { ReactNode } from "react";

import {
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Inbox,
  Loader2,
  Pencil,
  ShieldCheck,
  X,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { apiPost } from "./api";
import { Badge, EmptyState, FormStatus, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";

interface ApprovalsPageProps {
  data: AppData;
  onRefresh(): void;
}

type ApprovalView = "pending" | "history";
type ApprovalDecision = "approve" | "deny";

export function ApprovalsPage(props: ApprovalsPageProps): ReactNode {
  const [view, setView] = useState<ApprovalView>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const approvals = props.data.flowApprovals ?? [];
  const pending = approvals.filter((approval) => approval.status === "pending" && !resolvedIds.has(approval.id));
  const history = approvals.filter((approval) => approval.status !== "pending");
  const visible = view === "pending" ? pending : history;
  const selected = visible.find((approval) => approval.id === selectedId) ?? visible[0];

  async function decide(approval: FlowApproval, decision: ApprovalDecision): Promise<void> {
    if (decision === "deny" && !window.confirm("Deny this request and cancel the current Flow run?")) {
      return;
    }

    setBusy(`${decision}:${approval.id}`);
    setError(null);
    setStatus(null);
    try {
      const detail = await apiPost<FlowRunDetail>(`/api/flow-approvals/${approval.id}/${decision}`, {});
      setResolvedIds((current) => new Set(current).add(approval.id));
      setStatus(decisionMessage(decision, detail.run.status));
      props.onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The approval decision could not be recorded.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="approvals-page">
      <section className="approvals-toolbar">
        <div>
          <strong>Requests waiting for a decision</strong>
          <p>Review the exact connector action and payload before allowing a Flow to continue.</p>
        </div>
        <Badge tone={pending.length > 0 ? "warning" : "success"}>
          {pending.length === 0 ? "Inbox clear" : `${pending.length} pending`}
        </Badge>
      </section>

      {error ? <InlineError message={error} /> : null}
      {status ? <FormStatus message={status} /> : null}

      <div className="approval-view-switch" aria-label="Approval views">
        <button
          type="button"
          className={view === "pending" ? "active" : undefined}
          aria-pressed={view === "pending"}
          onClick={() => setView("pending")}
        >
          <Inbox size={14} />
          Pending
          <span>{pending.length}</span>
        </button>
        <button
          type="button"
          className={view === "history" ? "active" : undefined}
          aria-pressed={view === "history"}
          onClick={() => setView("history")}
        >
          <Clock3 size={14} />
          History
          <span>{history.length}</span>
        </button>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={view === "pending" ? <CheckCircle2 size={21} /> : <Clock3 size={21} />}
          tone={view === "pending" ? "success" : "neutral"}
          title={view === "pending" ? "Approval inbox is clear" : "No approval history yet"}
          description={
            view === "pending"
              ? "Flows with approval-gated tools will pause here before the connector action runs."
              : "Approved and denied requests will appear here for review."
          }
        />
      ) : (
        <section className="approval-mailbox">
          <div className="approval-mail-list list-panel" aria-label={`${view} approvals`}>
            {visible.map((approval) => (
              <ApprovalMailItem
                key={approval.id}
                approval={approval}
                data={props.data}
                selected={approval.id === selected?.id}
                busy={busy?.endsWith(approval.id) ?? false}
                onSelect={() => setSelectedId(approval.id)}
              />
            ))}
          </div>
          {selected ? (
            <ApprovalDetail
              approval={selected}
              data={props.data}
              busy={busy}
              onApprove={() => void decide(selected, "approve")}
              onDeny={() => void decide(selected, "deny")}
            />
          ) : null}
        </section>
      )}
    </div>
  );
}

function ApprovalMailItem(props: {
  approval: FlowApproval;
  data: AppData;
  selected: boolean;
  busy: boolean;
  onSelect(): void;
}): ReactNode {
  const flow = findFlow(props.data, props.approval);
  const action = findAction(props.data, props.approval.actionId);
  const StatusIcon =
    props.approval.status === "approved" ? CheckCircle2 : props.approval.status === "denied" ? Ban : CircleAlert;

  return (
    <button
      type="button"
      className={props.selected ? "approval-mail-item active" : "approval-mail-item"}
      aria-current={props.selected}
      onClick={props.onSelect}
    >
      <span className={`approval-mail-icon ${props.approval.status}`}>
        {props.busy ? <Loader2 className="spin" size={15} /> : <StatusIcon size={15} />}
      </span>
      <span className="approval-mail-main">
        <strong>{flow?.name ?? "Deleted Flow"}</strong>
        <small>{action?.name ?? props.approval.actionId}</small>
        <time dateTime={props.approval.requestedAt}>{formatApprovalDate(props.approval.requestedAt)}</time>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}

function ApprovalDetail(props: {
  approval: FlowApproval;
  data: AppData;
  busy: string | null;
  onApprove(): void;
  onDeny(): void;
}): ReactNode {
  const flow = findFlow(props.data, props.approval);
  const action = findAction(props.data, props.approval.actionId);
  const connection = props.data.connections.find((item) => item.id === props.approval.connectionId);
  const pending = props.approval.status === "pending";
  const approving = props.busy === `approve:${props.approval.id}`;
  const denying = props.busy === `deny:${props.approval.id}`;
  const statusTone =
    props.approval.status === "approved" ? "success" : props.approval.status === "denied" ? "error" : "warning";

  return (
    <article className="approval-detail detail-panel">
      <header className="approval-detail-heading">
        <div className="approval-detail-title">
          <span className={`approval-detail-icon ${props.approval.status}`}>
            {props.approval.status === "approved" ? (
              <Check size={18} />
            ) : props.approval.status === "denied" ? (
              <X size={18} />
            ) : (
              <ShieldCheck size={18} />
            )}
          </span>
          <div>
            <span>Approval request</span>
            <h2>{flow?.name ?? "Deleted Flow"}</h2>
          </div>
        </div>
        <Badge tone={statusTone}>{props.approval.status}</Badge>
      </header>

      <dl className="approval-facts">
        <div>
          <dt>Action</dt>
          <dd>{action ? `${action.providerName} · ${action.name}` : props.approval.actionId}</dd>
        </div>
        <div>
          <dt>Connection</dt>
          <dd>{connection ? connectionLabel(connection) : "Connection unavailable"}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{formatApprovalDate(props.approval.requestedAt)}</dd>
        </div>
        <div>
          <dt>Flow run</dt>
          <dd>{shortId(props.approval.runId)}</dd>
        </div>
      </dl>

      {action?.description ? <p className="approval-action-description">{action.description}</p> : null}

      <section className="approval-impact">
        <CircleAlert size={16} />
        <div>
          <strong>{pending ? "Review before execution" : "Recorded decision"}</strong>
          <p>
            {pending
              ? "Approving sends this exact payload to the selected connection and resumes the waiting Flow. Denying cancels this run."
              : `This request was ${props.approval.status}${props.approval.resolvedAt ? ` on ${formatApprovalDate(props.approval.resolvedAt)}` : ""}.`}
          </p>
        </div>
      </section>

      <section className="approval-payload">
        <div>
          <strong>Request payload</strong>
          <span>{props.approval.actionId}</span>
        </div>
        <pre>{JSON.stringify(props.approval.input, null, 2)}</pre>
      </section>

      {pending ? (
        <div className="approval-actions">
          <Button disabled={props.busy !== null} onClick={props.onApprove}>
            {approving ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
            {approving ? "Approving…" : "Approve and continue"}
          </Button>
          <Button variant="destructive" disabled={props.busy !== null} onClick={props.onDeny}>
            {denying ? <Loader2 className="spin" size={15} /> : <X size={15} />}
            {denying ? "Denying…" : "Deny request"}
          </Button>
          {flow ? (
            <Button variant="outline" asChild>
              <Link to={`/flows/${flow.id}/edit`}>
                <Pencil size={14} />
                Review Flow
              </Link>
            </Button>
          ) : null}
        </div>
      ) : flow ? (
        <Button className="approval-flow-link" variant="outline" asChild>
          <Link to={`/flows/${flow.id}/edit`}>
            <Pencil size={14} />
            Review Flow
          </Link>
        </Button>
      ) : null}
    </article>
  );
}

function findFlow(data: AppData, approval: FlowApproval): FlowDefinition | undefined {
  return data.flows?.find((flow) => flow.id === approval.flowId);
}

function findAction(
  data: AppData,
  actionId: string,
): { name: string; description: string; providerName: string } | undefined {
  for (const provider of data.providers) {
    const action = provider.actions.find((item) => item.id === actionId);
    if (action) {
      return {
        name: action.name,
        description: action.description,
        providerName: provider.displayName,
      };
    }
  }
  return undefined;
}

function connectionLabel(connection: ConnectionRecord): string {
  const displayName =
    connection.profile && typeof connection.profile.displayName === "string" && connection.profile.displayName.trim()
      ? connection.profile.displayName
      : connection.connectionName;
  return displayName ? `${displayName} · ${connection.service}` : connection.service;
}

function formatApprovalDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function decisionMessage(decision: ApprovalDecision, status: FlowRunStatus): string {
  if (decision === "deny") {
    return "Request denied. The Flow run was cancelled.";
  }
  if (status === "waiting_for_approval") {
    return "Request approved. The Flow continued and is waiting for another approval.";
  }
  if (status === "failed") {
    return "Request approved, but the Flow encountered an error after continuing.";
  }
  return status === "completed" ? "Request approved. The Flow completed." : "Request approved. The Flow continued.";
}
