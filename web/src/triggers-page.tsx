import type {
  AppData,
  ConnectionRecord,
  FlowDefinition,
  FlowTrigger,
  ProviderDefinition,
  ProviderEventDefinition,
} from "./model";
import type { FormEvent, ReactNode } from "react";

import { AlarmClock, Braces, CalendarClock, Copy, Pencil, Plus, Radio, Trash2, Workflow, Zap } from "lucide-react";
import { useState } from "react";
import { apiDelete, apiPut } from "./api";
import { flowConnectionDisplayName } from "./flow-connection-picker";
import { Badge, EmptyState, InlineError, ProviderIcon } from "./shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface TriggersPageProps {
  data: AppData;
  onRefresh(): void;
}

type TriggerMode = "api" | "schedule" | "event";

interface TriggerEditorState {
  intent: "create" | "edit";
  flowId: string;
  mode: TriggerMode;
  cron: string;
  timeZone: string;
  eventId: string;
  pollIntervalSeconds: number;
}

const defaultSchedule = "0 9 * * *";
const defaultPollIntervalSeconds = 60;

export function TriggersPage(props: TriggersPageProps): ReactNode {
  const flows = props.data.flows ?? [];
  const configuredFlows = flows.filter((flow) => flow.trigger.type !== "manual");
  const availableFlows = flows.filter((flow) => flow.trigger.type === "manual");
  const [editor, setEditor] = useState<TriggerEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingFlowId, setDeletingFlowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targetFlow = flows.find((flow) => flow.id === editor?.flowId);
  const sourceConnection = findConnection(props.data, targetFlow?.sourceConnectionId);
  const sourceProvider = props.data.providers.find((provider) => provider.service === sourceConnection?.service);
  const providerEvents = executableProviderEvents(sourceProvider);
  const selectedEventId =
    editor?.eventId && providerEvents.some((event) => event.id === editor.eventId)
      ? editor.eventId
      : (providerEvents[0]?.id ?? "");

  function openEditor(flow?: FlowDefinition): void {
    const target = flow ?? availableFlows[0];
    if (!target) {
      return;
    }
    setError(null);
    setEditor(createEditorState(target, props.data.providers, props.data.connections, flow ? "edit" : "create"));
  }

  function selectFlow(flowId: string): void {
    const flow = flows.find((candidate) => candidate.id === flowId);
    if (flow) {
      setEditor(createEditorState(flow, props.data.providers, props.data.connections, editor?.intent ?? "create"));
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!editor || !targetFlow) {
      return;
    }
    setSaving(true);
    setError(null);
    const trigger = buildTrigger(editor, targetFlow, selectedEventId);
    try {
      await apiPut(`/api/flow-triggers/${targetFlow.id}`, trigger);
      props.onRefresh();
      setEditor(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the trigger.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(flow: FlowDefinition): Promise<void> {
    if (!window.confirm(`Remove the trigger from “${flow.name}”? Manual runs will remain available.`)) {
      return;
    }
    setDeletingFlowId(flow.id);
    setError(null);
    try {
      await apiDelete(`/api/flow-triggers/${flow.id}`);
      props.onRefresh();
      if (editor?.flowId === flow.id) {
        setEditor(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the trigger.");
    } finally {
      setDeletingFlowId(null);
    }
  }

  return (
    <div className="triggers-page">
      <div className="triggers-toolbar">
        <div>
          <h2>Triggers</h2>
          <p>
            Start an existing Flow on a schedule, through the API, or from an event declared by its source connector.
          </p>
        </div>
        <Button
          onClick={() => openEditor()}
          disabled={availableFlows.length === 0}
          title={availableFlows.length === 0 ? "Every Flow already has an automatic trigger" : undefined}
        >
          <Plus size={16} />
          New trigger
        </Button>
      </div>

      {!editor && error ? <InlineError message={error} /> : null}

      <Dialog
        open={Boolean(editor && targetFlow)}
        onOpenChange={(open) => {
          if (!open && !saving) setEditor(null);
        }}
      >
        {editor && targetFlow ? (
          <DialogContent className="trigger-dialog">
            <TriggerEditor
              state={editor}
              flows={editor.intent === "create" ? availableFlows : [targetFlow]}
              targetFlow={targetFlow}
              sourceConnection={sourceConnection}
              sourceProvider={sourceProvider}
              providerEvents={providerEvents}
              selectedEventId={selectedEventId}
              saving={saving}
              error={error}
              onChange={setEditor}
              onFlowChange={selectFlow}
              onSubmit={save}
              onCancel={() => setEditor(null)}
            />
          </DialogContent>
        ) : null}
      </Dialog>

      {configuredFlows.length === 0 ? (
        <EmptyState
          title="No automatic triggers"
          description="Create a trigger and point it at an existing Flow. Run now remains available without one."
        />
      ) : (
        <div className="trigger-list">
          {configuredFlows.map((flow) => (
            <TriggerCard
              key={flow.id}
              flow={flow}
              data={props.data}
              deleting={deletingFlowId === flow.id}
              onEdit={() => openEditor(flow)}
              onDelete={() => void remove(flow)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TriggerEditor(props: {
  state: TriggerEditorState;
  flows: FlowDefinition[];
  targetFlow: FlowDefinition;
  sourceConnection: (ConnectionRecord & { id: string }) | undefined;
  sourceProvider: ProviderDefinition | undefined;
  providerEvents: ProviderEventDefinition[];
  selectedEventId: string;
  saving: boolean;
  error: string | null;
  onChange(state: TriggerEditorState): void;
  onFlowChange(flowId: string): void;
  onSubmit(event: FormEvent): Promise<void>;
  onCancel(): void;
}): ReactNode {
  const apiUrl = `${window.location.origin}/v1/flows/${props.targetFlow.id}/trigger`;
  const selectedEvent = props.providerEvents.find((event) => event.id === props.selectedEventId);
  const ConfigurationIcon =
    props.state.mode === "event" ? Radio : props.state.mode === "schedule" ? CalendarClock : Braces;
  return (
    <form className="trigger-editor" onSubmit={(event) => void props.onSubmit(event)}>
      <DialogHeader className="trigger-dialog-header">
        <span className="trigger-heading-icon">
          <Zap size={19} />
        </span>
        <div>
          <DialogTitle>{props.state.intent === "create" ? "Create trigger" : "Edit trigger"}</DialogTitle>
          <DialogDescription>
            {props.state.intent === "create"
              ? "Choose a Flow and one clear condition that starts it."
              : `Update when “${props.targetFlow.name}” starts automatically.`}
          </DialogDescription>
        </div>
      </DialogHeader>

      {props.error ? <InlineError message={props.error} /> : null}

      <div className="trigger-dialog-body">
        <section className="trigger-form-section">
          <div className="trigger-section-heading">
            <span>1</span>
            <div>
              <strong>Choose the Flow</strong>
              <small>The trigger watches the Flow’s source connection and starts its existing instructions.</small>
            </div>
          </div>
          <div className="trigger-context-grid">
            <div className="field">
              <span>Target Flow</span>
              {props.state.intent === "create" ? (
                <Select value={props.state.flowId} onValueChange={props.onFlowChange}>
                  <SelectTrigger className="trigger-select" aria-label="Target Flow">
                    <SelectValue placeholder="Choose a Flow" />
                  </SelectTrigger>
                  <SelectContent className="trigger-select-content" position="popper" align="start" sideOffset={6}>
                    {props.flows.map((flow) => (
                      <SelectItem key={flow.id} value={flow.id}>
                        {flow.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="trigger-flow-summary">
                  <Workflow size={18} />
                  <div>
                    <strong>{props.targetFlow.name}</strong>
                    <small>{props.targetFlow.status}</small>
                  </div>
                </div>
              )}
            </div>
            <div className="field">
              <span>Source connector</span>
              <div className="trigger-source-summary">
                {props.sourceProvider ? <ProviderIcon provider={props.sourceProvider} /> : <Radio size={18} />}
                <div>
                  <strong>{props.sourceProvider?.displayName ?? "Unavailable"}</strong>
                  <small>
                    {props.sourceConnection ? flowConnectionDisplayName(props.sourceConnection) : "Missing connection"}
                  </small>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="trigger-form-section">
          <div className="trigger-section-heading">
            <span>2</span>
            <div>
              <strong>Choose how it starts</strong>
              <small>Select one trigger type; only its relevant settings appear below.</small>
            </div>
          </div>
          <div className="trigger-mode-grid">
            <TriggerModeButton
              mode="event"
              current={props.state.mode}
              icon={Radio}
              title="Connector event"
              description="Something happens in the source app"
              onSelect={(mode) => props.onChange({ ...props.state, mode })}
            />
            <TriggerModeButton
              mode="schedule"
              current={props.state.mode}
              icon={CalendarClock}
              title="Schedule"
              description="A scheduled date and time occurs"
              onSelect={(mode) => props.onChange({ ...props.state, mode })}
            />
            <TriggerModeButton
              mode="api"
              current={props.state.mode}
              icon={Braces}
              title="API call"
              description="An authenticated request is received"
              onSelect={(mode) => props.onChange({ ...props.state, mode })}
            />
          </div>
        </section>

        <section className="trigger-configuration">
          <div className="trigger-configuration-heading">
            <span>
              <ConfigurationIcon size={18} />
            </span>
            <div>
              <strong>
                {props.state.mode === "event"
                  ? "Event details"
                  : props.state.mode === "schedule"
                    ? "Schedule details"
                    : "API endpoint"}
              </strong>
              <small>
                {props.state.mode === "event"
                  ? `Choose an event built into ${props.sourceProvider?.displayName ?? "the source connector"}.`
                  : props.state.mode === "schedule"
                    ? "Set when this Flow should run in its local time zone."
                    : "Call this endpoint with a runtime token and JSON payload."}
              </small>
            </div>
          </div>

          {props.state.mode === "event" ? (
            props.providerEvents.length > 0 ? (
              <div className="trigger-config-fields">
                <div className="field">
                  <span>Event</span>
                  <Select
                    value={props.selectedEventId}
                    onValueChange={(eventId) => props.onChange({ ...props.state, eventId })}
                  >
                    <SelectTrigger className="trigger-select" aria-label="Connector event">
                      <SelectValue placeholder="Choose an event" />
                    </SelectTrigger>
                    <SelectContent className="trigger-select-content" position="popper" align="start" sideOffset={6}>
                      {props.providerEvents.map((event) => (
                        <SelectItem key={event.id} value={event.id}>
                          {event.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <small>{selectedEvent?.description}</small>
                </div>
                <PollIntervalField
                  value={props.state.pollIntervalSeconds}
                  onChange={(pollIntervalSeconds) => props.onChange({ ...props.state, pollIntervalSeconds })}
                />
                <p className="trigger-baseline-note">
                  First check records a baseline; existing items do not start the Flow.
                </p>
              </div>
            ) : (
              <InlineError
                message={`${props.sourceProvider?.displayName ?? "This connector"} does not declare events yet.`}
              />
            )
          ) : null}

          {props.state.mode === "schedule" ? (
            <div className="trigger-config-fields">
              <Label className="field">
                <span>Cron schedule</span>
                <Input
                  value={props.state.cron}
                  placeholder={defaultSchedule}
                  maxLength={120}
                  onChange={(event) => props.onChange({ ...props.state, cron: event.target.value })}
                  required
                />
                <small>Minute, hour, day, month, weekday.</small>
              </Label>
              <Label className="field">
                <span>Time zone</span>
                <Input
                  value={props.state.timeZone}
                  placeholder="Australia/Perth"
                  maxLength={100}
                  onChange={(event) => props.onChange({ ...props.state, timeZone: event.target.value })}
                  required
                />
                <small>Use an IANA time zone name.</small>
              </Label>
            </div>
          ) : null}

          {props.state.mode === "api" ? (
            <div className="trigger-api-detail">
              <Braces size={18} />
              <div>
                <strong>Authenticated runtime endpoint</strong>
                <code>{apiUrl}</code>
                <small>POST a JSON object. Its payload becomes trigger context for the Flow agent.</small>
              </div>
              <Button
                variant="outline"
                size="icon-sm"
                type="button"
                aria-label="Copy trigger endpoint"
                onClick={() => void navigator.clipboard.writeText(apiUrl)}
              >
                <Copy size={15} />
              </Button>
            </div>
          ) : null}
        </section>
      </div>

      <DialogFooter className="trigger-dialog-footer">
        <Button variant="outline" type="button" disabled={props.saving} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={props.saving || (props.state.mode === "event" && !props.selectedEventId)}>
          {props.saving ? "Saving…" : props.state.intent === "create" ? "Create trigger" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TriggerModeButton(props: {
  mode: TriggerMode;
  current: TriggerMode;
  icon: typeof Radio;
  title: string;
  description: string;
  onSelect(mode: TriggerMode): void;
}): ReactNode {
  const Icon = props.icon;
  return (
    <button
      className={props.mode === props.current ? "trigger-mode selected" : "trigger-mode"}
      type="button"
      aria-pressed={props.mode === props.current}
      onClick={() => props.onSelect(props.mode)}
    >
      <Icon size={19} />
      <span>
        <strong>{props.title}</strong>
        <small>{props.description}</small>
      </span>
    </button>
  );
}

function TriggerCard(props: {
  flow: FlowDefinition;
  data: AppData;
  deleting: boolean;
  onEdit(): void;
  onDelete(): void;
}): ReactNode {
  const connection = findConnection(props.data, props.flow.sourceConnectionId);
  const provider = props.data.providers.find((candidate) => candidate.service === connection?.service);
  const eventId = props.flow.trigger.type === "event" ? props.flow.trigger.eventId : undefined;
  const event = eventId === undefined ? undefined : provider?.events?.find((candidate) => candidate.id === eventId);
  const Icon = triggerIcon(props.flow.trigger);
  return (
    <article className="trigger-card">
      <span className="trigger-card-icon">
        <Icon size={20} />
      </span>
      <div className="trigger-card-main">
        <div className="trigger-card-title">
          <strong>{triggerName(props.flow.trigger, event)}</strong>
          <Badge>{props.flow.status}</Badge>
        </div>
        <p>{triggerDescription(props.flow.trigger)}</p>
        <div className="trigger-target">
          <span>Runs</span>
          <strong>{props.flow.name}</strong>
          {provider && connection ? (
            <span className="trigger-provider">
              <ProviderIcon provider={provider} />
              {flowConnectionDisplayName(connection)}
            </span>
          ) : null}
        </div>
      </div>
      <div className="trigger-card-actions">
        <Button variant="outline" size="icon" aria-label={`Edit trigger for ${props.flow.name}`} onClick={props.onEdit}>
          <Pencil size={17} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="danger-icon-button"
          aria-label={`Delete trigger for ${props.flow.name}`}
          disabled={props.deleting}
          onClick={props.onDelete}
        >
          <Trash2 size={17} />
        </Button>
      </div>
    </article>
  );
}

function PollIntervalField(props: { value: number; onChange(value: number): void }): ReactNode {
  return (
    <div className="field trigger-poll-field">
      <span>Check every</span>
      <Select value={String(props.value)} onValueChange={(value) => props.onChange(Number(value))}>
        <SelectTrigger className="trigger-select" aria-label="Polling interval">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="trigger-select-content" position="popper" align="start" sideOffset={6}>
          <SelectItem value="30">30 seconds</SelectItem>
          <SelectItem value="60">1 minute</SelectItem>
          <SelectItem value="300">5 minutes</SelectItem>
          <SelectItem value="900">15 minutes</SelectItem>
        </SelectContent>
      </Select>
      <small>Shorter checks react faster but make more connector requests.</small>
    </div>
  );
}

function createEditorState(
  flow: FlowDefinition,
  providers: ProviderDefinition[],
  connections: ConnectionRecord[],
  intent: TriggerEditorState["intent"],
): TriggerEditorState {
  const source = connections.find((connection) => connection.id === flow.sourceConnectionId);
  const provider = providers.find((candidate) => candidate.service === source?.service);
  const providerEvents = executableProviderEvents(provider);
  const trigger = flow.trigger;
  const legacyEventId =
    trigger.type === "new_email"
      ? providerEvents.find((event) => event.id.endsWith(".new_received_email"))?.id
      : trigger.type === "file_created"
        ? providerEvents.find((event) => event.id.endsWith(".file_created"))?.id
        : undefined;
  const eventId = trigger.type === "event" ? trigger.eventId : (legacyEventId ?? providerEvents[0]?.id ?? "");
  return {
    intent,
    flowId: flow.id,
    mode:
      trigger.type === "api" || trigger.type === "schedule" || trigger.type === "event"
        ? trigger.type
        : eventId
          ? "event"
          : "schedule",
    cron: trigger.type === "schedule" ? trigger.cron : defaultSchedule,
    timeZone:
      trigger.type === "schedule"
        ? trigger.timeZone
        : Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Perth",
    eventId,
    pollIntervalSeconds:
      trigger.type === "event" || trigger.type === "new_email" || trigger.type === "file_created"
        ? trigger.pollIntervalSeconds
        : defaultPollIntervalSeconds,
  };
}

function buildTrigger(state: TriggerEditorState, flow: FlowDefinition, eventId: string): FlowTrigger {
  if (state.mode === "api") {
    return { type: "api" };
  }
  if (state.mode === "schedule") {
    return { type: "schedule", cron: state.cron, timeZone: state.timeZone };
  }
  return {
    type: "event",
    connectionId: flow.sourceConnectionId,
    eventId,
    pollIntervalSeconds: state.pollIntervalSeconds,
  };
}

function triggerIcon(trigger: FlowTrigger): typeof Radio {
  return trigger.type === "api" ? Braces : trigger.type === "schedule" ? AlarmClock : Radio;
}

function triggerName(trigger: FlowTrigger, event: ProviderEventDefinition | undefined): string {
  if (trigger.type === "api") return "API call";
  if (trigger.type === "schedule") return "Scheduled time";
  if (trigger.type === "event") return event?.displayName ?? trigger.eventId;
  if (trigger.type === "new_email") return "New email (legacy)";
  if (trigger.type === "file_created") return "File created (legacy)";
  return "Manual";
}

function triggerDescription(trigger: FlowTrigger): string {
  if (trigger.type === "api") return "Starts when its authenticated endpoint receives a JSON payload.";
  if (trigger.type === "schedule") return `${trigger.cron} · ${trigger.timeZone}`;
  if (trigger.type === "event" || trigger.type === "new_email" || trigger.type === "file_created") {
    return `Checks the source connection every ${trigger.pollIntervalSeconds} seconds.`;
  }
  return "Manual only";
}

function findConnection(data: AppData, id: string | undefined): (ConnectionRecord & { id: string }) | undefined {
  return data.connections.find(
    (connection): connection is ConnectionRecord & { id: string } => Boolean(connection.id) && connection.id === id,
  );
}

function executableProviderEvents(provider: ProviderDefinition | undefined): ProviderEventDefinition[] {
  return (provider?.events ?? []).filter((event) =>
    provider?.actions.some((action) => action.id === event.polling.actionId && action.execution.locallyExecutable),
  );
}
