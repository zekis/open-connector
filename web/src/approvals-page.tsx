import type {
  ActionApproval,
  AppData,
  ConnectionRecord,
  FlowApproval,
  FlowDefinition,
  FlowRunDetail,
  FlowRunStatus,
} from "./model";
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
import { useEffect, useState } from "react";
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
type ApprovalItem = { kind: "flow"; approval: FlowApproval } | { kind: "action"; approval: ActionApproval };

export function ApprovalsPage(props: ApprovalsPageProps): ReactNode {
  const [view, setView] = useState<ApprovalView>("pending");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    props.onRefresh();
  }, [props.onRefresh]);

  const approvals: ApprovalItem[] = [
    ...(props.data.flowApprovals ?? []).map((approval): ApprovalItem => ({ kind: "flow", approval })),
    ...(props.data.actionApprovals ?? []).map((approval): ApprovalItem => ({ kind: "action", approval })),
  ].sort((left, right) => Date.parse(right.approval.requestedAt) - Date.parse(left.approval.requestedAt));
  const pending = approvals.filter(
    (item) => item.approval.status === "pending" && !resolvedKeys.has(approvalKey(item)),
  );
  const history = approvals.filter((item) => item.approval.status !== "pending");
  const visible = view === "pending" ? pending : history;
  const selected = visible.find((item) => approvalKey(item) === selectedKey) ?? visible[0];

  async function decide(item: ApprovalItem, decision: ApprovalDecision): Promise<void> {
    if (decision === "deny" && !window.confirm(denialPrompt(item))) {
      return;
    }

    const key = approvalKey(item);
    setBusy(`${decision}:${key}`);
    setError(null);
    setStatus(null);
    try {
      if (item.kind === "flow") {
        const detail = await apiPost<FlowRunDetail>(`/api/flow-approvals/${item.approval.id}/${decision}`, {});
        setStatus(flowDecisionMessage(decision, detail.run.status));
      } else {
        const resolved = await apiPost<ActionApproval>(`/api/action-approvals/${item.approval.id}/${decision}`, {});
        setStatus(actionDecisionMessage(decision, resolved));
      }
      setResolvedKeys((current) => new Set(current).add(key));
      props.onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The approval decision could not be recorded.");
      props.onRefresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="approvals-page">
      <section className="approvals-toolbar">
        <div>
          <strong>Requests waiting for a decision</strong>
          <p>Review the exact connector action and payload before allowing it to run.</p>
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
              ? "Approval-gated connector requests and Flow tools will pause here before execution."
              : "Approved, denied, consumed, and expired requests will appear here for review."
          }
        />
      ) : (
        <section className="approval-mailbox">
          <div className="approval-mail-list list-panel" aria-label={`${view} approvals`}>
            {visible.map((item) => (
              <ApprovalMailItem
                key={approvalKey(item)}
                item={item}
                data={props.data}
                selected={approvalKey(item) === (selected ? approvalKey(selected) : undefined)}
                busy={busy?.endsWith(approvalKey(item)) ?? false}
                onSelect={() => setSelectedKey(approvalKey(item))}
              />
            ))}
          </div>
          {selected ? (
            <ApprovalDetail
              item={selected}
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
  item: ApprovalItem;
  data: AppData;
  selected: boolean;
  busy: boolean;
  onSelect(): void;
}): ReactNode {
  const flow = props.item.kind === "flow" ? findFlow(props.data, props.item.approval) : undefined;
  const action = findAction(props.data, props.item.approval.actionId);
  const status = props.item.approval.status;
  const StatusIcon =
    status === "approved" || status === "consumed" ? CheckCircle2 : status === "pending" ? CircleAlert : Ban;

  return (
    <button
      type="button"
      className={props.selected ? "approval-mail-item active" : "approval-mail-item"}
      aria-current={props.selected}
      onClick={props.onSelect}
    >
      <span className={`approval-mail-icon ${status}`}>
        {props.busy ? <Loader2 className="spin" size={15} /> : <StatusIcon size={15} />}
      </span>
      <span className="approval-mail-main">
        <strong>{flow?.name ?? approvalSourceLabel(props.item)}</strong>
        <small>{action?.name ?? props.item.approval.actionId}</small>
        <time dateTime={props.item.approval.requestedAt}>{formatApprovalDate(props.item.approval.requestedAt)}</time>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}

function ApprovalDetail(props: {
  item: ApprovalItem;
  data: AppData;
  busy: string | null;
  onApprove(): void;
  onDeny(): void;
}): ReactNode {
  const approval = props.item.approval;
  const actionApproval = props.item.kind === "action" ? props.item.approval : undefined;
  const flow = props.item.kind === "flow" ? findFlow(props.data, props.item.approval) : undefined;
  const action = findAction(props.data, approval.actionId);
  const connection = props.data.connections.find((item) => item.id === approval.connectionId);
  const pending = approval.status === "pending";
  const key = approvalKey(props.item);
  const approving = props.busy === `approve:${key}`;
  const denying = props.busy === `deny:${key}`;
  const statusTone =
    approval.status === "approved" || approval.status === "consumed"
      ? "success"
      : approval.status === "denied"
        ? "error"
        : "warning";

  return (
    <article className="approval-detail detail-panel">
      <header className="approval-detail-heading">
        <div className="approval-detail-title">
          <span className={`approval-detail-icon ${approval.status}`}>
            {approval.status === "approved" || approval.status === "consumed" ? (
              <Check size={18} />
            ) : approval.status === "denied" || approval.status === "expired" ? (
              <X size={18} />
            ) : (
              <ShieldCheck size={18} />
            )}
          </span>
          <div>
            <span>{props.item.kind === "flow" ? "Flow approval request" : "Connector approval request"}</span>
            <h2>{flow?.name ?? approvalSourceLabel(props.item)}</h2>
          </div>
        </div>
        <Badge tone={statusTone}>{approval.status}</Badge>
      </header>

      <dl className="approval-facts">
        <div>
          <dt>Action</dt>
          <dd>{action ? `${action.providerName} · ${action.name}` : approval.actionId}</dd>
        </div>
        <div>
          <dt>Connection</dt>
          <dd>{connection ? connectionLabel(connection) : "Connection unavailable"}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{formatApprovalDate(approval.requestedAt)}</dd>
        </div>
        <div>
          <dt>{props.item.kind === "flow" ? "Flow run" : "Caller"}</dt>
          <dd>
            {props.item.kind === "flow" ? shortId(props.item.approval.runId) : callerLabel(props.item.approval.caller)}
          </dd>
        </div>
      </dl>

      {action?.description ? <p className="approval-action-description">{action.description}</p> : null}

      <section className="approval-impact">
        <CircleAlert size={16} />
        <div>
          <strong>{pending ? "Review before execution" : "Recorded decision"}</strong>
          <p>{approvalImpact(props.item)}</p>
        </div>
      </section>

      <section className="approval-payload">
        <div>
          <strong>Request payload</strong>
          <span>{approval.actionId}</span>
        </div>
        <pre>{JSON.stringify(approval.input, null, 2)}</pre>
      </section>

      {actionApproval?.execution ? (
        <section className="approval-payload">
          <div>
            <strong>Execution result</strong>
            <span>{shortId(actionApproval.execution.executionId)}</span>
          </div>
          <pre>
            {JSON.stringify(
              actionApproval.execution.result.ok
                ? actionApproval.execution.result.output
                : actionApproval.execution.result.error,
              null,
              2,
            )}
          </pre>
        </section>
      ) : null}

      {pending ? (
        <div className="approval-actions">
          <Button disabled={props.busy !== null} onClick={props.onApprove}>
            {approving ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
            {approving ? "Approving…" : approvalButtonLabel(props.item)}
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

function approvalKey(item: ApprovalItem): string {
  return `${item.kind}:${item.approval.id}`;
}

function approvalSourceLabel(item: ApprovalItem): string {
  return item.kind === "flow" ? "Deleted Flow" : `${callerLabel(item.approval.caller)} request`;
}

function callerLabel(caller: ActionApproval["caller"]): string {
  const labels: Record<ActionApproval["caller"], string> = {
    chat: "Agent chat",
    flow: "Flow",
    http: "Runtime API",
    mcp: "MCP",
    trigger: "Trigger detector",
    web: "Console",
  };
  return labels[caller];
}

function approvalImpact(item: ApprovalItem): string {
  const approval = item.approval;
  if (approval.status === "pending") {
    if (item.kind === "flow") {
      return "Approving sends this exact payload to the selected connection and resumes the waiting Flow. Denying cancels this run.";
    }
    return item.approval.caller === "chat"
      ? "Approving executes this exact connector action and resumes the waiting Chat automatically. Denying stops the pending Chat request."
      : "Approving executes this exact connector action once using the connection and payload shown here. No retry is authorized.";
  }
  const resolvedAt = approval.resolvedAt ? ` on ${formatApprovalDate(approval.resolvedAt)}` : "";
  if (approval.status === "consumed") {
    if (item.kind === "action" && approval.execution) {
      return approval.execution.result.ok
        ? `Approved${resolvedAt} and executed exactly once.`
        : `Approved${resolvedAt}, but execution failed: ${approval.execution.result.error?.message ?? "Unknown error"}`;
    }
    return `Approved${resolvedAt} and executed exactly once.`;
  }
  if (approval.status === "expired") {
    return `This request expired before it could execute${resolvedAt}.`;
  }
  return `This request was ${approval.status}${resolvedAt}.`;
}

function denialPrompt(item: ApprovalItem): string {
  if (item.kind === "flow") return "Deny this request and cancel the current Flow run?";
  return item.approval.caller === "chat"
    ? "Deny this connector request and stop the waiting Chat?"
    : "Deny this exact connector request without executing it?";
}

function approvalButtonLabel(item: ApprovalItem): string {
  if (item.kind === "flow") return "Approve and continue";
  return item.approval.caller === "chat" ? "Approve and resume Chat" : "Approve and run";
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

function flowDecisionMessage(decision: ApprovalDecision, status: FlowRunStatus): string {
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

function actionDecisionMessage(decision: ApprovalDecision, approval: ActionApproval): string {
  if (decision === "deny") return "Request denied. The connector action was not executed.";
  if (approval.caller === "chat") return "Request approved. Chat resumed automatically.";
  return approval.execution?.result.ok
    ? "Request approved and executed exactly once."
    : `Request approved, but execution failed: ${approval.execution?.result.error?.message ?? "Unknown error"}`;
}
