import type { FlowToolPermissionChoice } from "./flow-tool-permission-group";
import type {
  AppData,
  AgentProvider,
  ConnectionRecord,
  FlowApprovalSetting,
  FlowDefinition,
  FlowTrigger,
  FlowToolGrant,
  ProviderDefinition,
  SynapseWorkspaceSummary,
} from "./model";
import type { FormEvent, ReactNode } from "react";

import { ArrowLeft, ArrowRight, BrainCircuit, Cable, Clock3, Workflow, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { apiGet, apiPost, apiPut } from "./api";
import { FlowConnectionPicker, flowConnectionDisplayName } from "./flow-connection-picker";
import { FlowToolPermissionGroup } from "./flow-tool-permission-group";
import { flowSourceConnectionIds } from "./model";
import { Badge, EmptyState, InlineError, ProviderIcon } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface FlowBuilderPageProps {
  data: AppData;
  onRefresh(): void;
}

const defaultFlowMaxSteps = 20;
const maximumFlowMaxSteps = 200;
const maximumFlowRunToolCalls = 200;
const maximumFlowSourceConnections = 16;

interface AgentChoice {
  id: string;
  label: string;
  provider: AgentProvider;
}

interface FlowDraft {
  name: string;
  status: "active" | "paused";
  sourceConnectionIds: string[];
  destinationConnectionId?: string;
  destinationSynapseId?: string;
  destinationSynapseName?: string;
  instructions: string;
  trigger: FlowTrigger;
  agent: {
    provider: AgentProvider;
    connectionId: string;
    reasoningEffort: "none" | "low" | "medium" | "high";
  };
  tools: FlowToolGrant[];
  maxSteps: number;
}

type FlowDestinationKind = "connection" | "existing_synapse" | "new_synapse";

export function FlowBuilderPage(props: FlowBuilderPageProps): ReactNode {
  const { flowId } = useParams();
  const flow = flowId ? props.data.flows?.find((item) => item.id === flowId) : undefined;

  if (flowId && !flow) {
    return (
      <div className="flow-builder-page">
        <Button variant="ghost" asChild>
          <Link to="/flows">
            <ArrowLeft size={14} />
            Back to Flows
          </Link>
        </Button>
        <EmptyState
          title="Flow not found"
          description="The Flow may have been deleted, or the runtime data has not refreshed yet."
        />
      </div>
    );
  }

  return <FlowBuilder data={props.data} flow={flow} onRefresh={props.onRefresh} />;
}

function FlowBuilder(props: { data: AppData; flow: FlowDefinition | undefined; onRefresh(): void }): ReactNode {
  const navigate = useNavigate();
  const connections = props.data.connections.filter((connection): connection is ConnectionRecord & { id: string } =>
    Boolean(connection.id),
  );
  const agentChoices: AgentChoice[] = [
    ...(props.data.agentConnections ?? []).map((connection) => ({
      id: connection.id,
      label: `${connection.displayName} · ${connection.provider === "openai_codex" ? "OpenAI Codex" : "Claude Code"}`,
      provider: connection.provider,
    })),
  ];
  const editing = props.flow !== undefined;
  const [name, setName] = useState(props.flow?.name ?? "");
  const [sourceIds, setSourceIds] = useState<string[]>(
    props.flow ? flowSourceConnectionIds(props.flow) : connections[0]?.id ? [connections[0].id] : [],
  );
  const [destinationId, setDestinationId] = useState(
    props.flow?.destinationConnectionId ?? connections[1]?.id ?? connections[0]?.id ?? "",
  );
  const [destinationKind, setDestinationKind] = useState<FlowDestinationKind>(
    props.flow?.destinationSynapseId ? "existing_synapse" : "connection",
  );
  const [destinationSynapseId, setDestinationSynapseId] = useState(props.flow?.destinationSynapseId ?? "");
  const [destinationSynapseName, setDestinationSynapseName] = useState("");
  const [synapses, setSynapses] = useState<SynapseWorkspaceSummary[]>([]);
  const [agentConnectionId, setAgentConnectionId] = useState(
    props.flow?.agent.connectionId ?? agentChoices[0]?.id ?? "",
  );
  const selectedAgent = agentChoices.find((choice) => choice.id === agentConnectionId);
  const [instructions, setInstructions] = useState(props.flow?.instructions ?? "");
  const [maxSteps, setMaxSteps] = useState(props.flow?.maxSteps ?? defaultFlowMaxSteps);
  const [toolSearch, setToolSearch] = useState("");
  const [selectedTools, setSelectedTools] = useState<Record<string, FlowApprovalSetting>>(() =>
    Object.fromEntries(
      props.flow?.tools.map((tool) => [
        flowToolSelectionKey(flowToolRole(props.flow!, tool), tool.connectionId, tool.actionId),
        tool.approval,
      ]) ?? [],
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const budgetSourceCount = Math.max(1, sourceIds.length);
  const runToolCallLimit = Math.min(maximumFlowRunToolCalls, maxSteps * budgetSourceCount);

  useEffect(() => {
    let active = true;
    void apiGet<SynapseWorkspaceSummary[]>("/api/synapses")
      .then((items) => {
        if (!active) return;
        setSynapses(items);
        setDestinationSynapseId((current) => current || items[0]?.id || "");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const choices = useMemo(
    () => createToolChoices(props.data, sourceIds, destinationKind === "connection" ? destinationId : undefined),
    [props.data, sourceIds, destinationId, destinationKind],
  );
  const visibleChoices = choices.filter((choice) => {
    const query = toolSearch.trim().toLowerCase();
    return (
      !query ||
      choice.actionName.toLowerCase().includes(query) ||
      choice.actionId.toLowerCase().includes(query) ||
      choice.actionDescription.toLowerCase().includes(query)
    );
  });
  const grants: FlowToolGrant[] = choices.flatMap((choice) => {
    const approval = selectedTools[choice.key];
    return approval
      ? [{ actionId: choice.actionId, connectionId: choice.connectionId, role: choice.role, approval }]
      : [];
  });
  const destinationConnection = connections.find((connection) => connection.id === destinationId);
  const destinationProvider = props.data.providers.find(
    (provider) => provider.service === destinationConnection?.service,
  );
  const sourceChoices = choices.filter((choice) => choice.role === "source");
  const destinationChoices = choices.filter((choice) => choice.role === "destination");
  const visibleSourceChoices = visibleChoices.filter((choice) => choice.role === "source");
  const visibleDestinationChoices = visibleChoices.filter((choice) => choice.role === "destination");
  const existingTrigger = props.flow?.trigger;
  const sourceChangedWithConnectorTrigger =
    props.flow !== undefined &&
    existingTrigger !== undefined &&
    (existingTrigger.type === "event" ||
      existingTrigger.type === "new_email" ||
      existingTrigger.type === "file_created") &&
    !sourceIds.includes(existingTrigger.connectionId);
  const trigger: FlowTrigger = sourceChangedWithConnectorTrigger
    ? { type: "manual" }
    : (props.flow?.trigger ?? { type: "manual" });
  const destinationReady =
    destinationKind === "connection"
      ? Boolean(destinationId)
      : destinationKind === "existing_synapse"
        ? Boolean(destinationSynapseId)
        : Boolean(destinationSynapseName.trim());

  function toggleTool(key: string, enabled: boolean): void {
    setSelectedTools((current) => {
      const next = { ...current };
      if (enabled) {
        next[key] = "inherit";
      } else {
        delete next[key];
      }
      return next;
    });
  }

  function changeApproval(key: string, approval: FlowApprovalSetting): void {
    setSelectedTools((current) => ({ ...current, [key]: approval }));
  }

  function addSource(connectionId: string): void {
    if (!connectionId) return;
    setSourceIds((current) =>
      current.includes(connectionId) || current.length >= maximumFlowSourceConnections
        ? current
        : [...current, connectionId],
    );
  }

  function removeSource(connectionId: string): void {
    setSourceIds((current) => current.filter((id) => id !== connectionId));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const draft: FlowDraft = {
      name,
      status: props.flow?.status ?? "active",
      sourceConnectionIds: sourceIds,
      ...(destinationKind === "connection" ? { destinationConnectionId: destinationId } : {}),
      ...(destinationKind === "existing_synapse" ? { destinationSynapseId } : {}),
      ...(destinationKind === "new_synapse" ? { destinationSynapseName: destinationSynapseName.trim() } : {}),
      instructions,
      trigger,
      agent: {
        provider: selectedAgent?.provider ?? props.flow?.agent.provider ?? "claude_code",
        connectionId: agentConnectionId,
        reasoningEffort: props.flow?.agent.reasoningEffort ?? "medium",
      },
      tools: grants,
      maxSteps,
    };

    try {
      if (props.flow) {
        await apiPut(`/api/flows/${props.flow.id}`, draft);
      } else {
        await apiPost("/api/flows", draft);
      }
      props.onRefresh();
      navigate("/flows");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the Flow.");
      setSaving(false);
    }
  }

  return (
    <div className="flow-builder-page">
      <Button variant="ghost" asChild>
        <Link to="/flows">
          <ArrowLeft size={14} />
          Back to Flows
        </Link>
      </Button>

      <section className="flow-builder detail-panel">
        <div className="flow-builder-heading">
          <div>
            <h2>{props.flow ? `Edit ${props.flow.name}` : "Create a Flow"}</h2>
            <p>
              Choose one or more sources and a connector or canvas destination, then expose only the tools this agent
              needs.
            </p>
          </div>
          <Badge>{grants.length} tools</Badge>
        </div>

        {error ? <InlineError message={error} /> : null}
        {connections.length < 1 ? (
          <InlineError message="Connect at least one endpoint connection before creating a Flow." />
        ) : null}
        {!agentConnectionId ? (
          <InlineError message="Connect a subscription agent from the Agents panel before saving this Flow." />
        ) : null}

        <form className="flow-builder-form" onSubmit={(event) => void submit(event)}>
          <Label className="field">
            <span>Name</span>
            <Input
              value={name}
              maxLength={120}
              placeholder="Today’s Outlook mail to SharePoint"
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Label>
          <div className="flow-composer">
            <SourceNode
              sourceIds={sourceIds}
              connections={connections}
              providers={props.data.providers}
              onAdd={addSource}
              onRemove={removeSource}
            />
            <FlowDirection label="Read" />
            <section className="flow-instruction-node">
              <div className="flow-instruction-heading">
                <span className="flow-instruction-icon">
                  <Workflow size={20} />
                </span>
                <div>
                  <span>Agent instructions</span>
                  <strong>Describe the synchronization</strong>
                  <small>Define what to select, transform, name, and write.</small>
                </div>
              </div>
              <Label className="field flow-instructions-field">
                <span className="sr-only">Agent instructions</span>
                <Textarea
                  className="flow-instructions"
                  value={instructions}
                  maxLength={20_000}
                  placeholder="Search Outlook for emails received today, then create an Excel spreadsheet in SharePoint with one row per message."
                  onChange={(event) => setInstructions(event.target.value)}
                  required
                />
              </Label>
            </section>
            <FlowDirection label="Write" />
            <DestinationNode
              kind={destinationKind}
              connectionId={destinationId}
              connection={destinationConnection}
              provider={destinationProvider}
              connections={connections}
              providers={props.data.providers}
              synapses={synapses}
              synapseId={destinationSynapseId}
              synapseName={destinationSynapseName}
              onKindChange={setDestinationKind}
              onConnectionChange={setDestinationId}
              onSynapseChange={setDestinationSynapseId}
              onSynapseNameChange={setDestinationSynapseName}
            />
          </div>
          <section className="flow-trigger-editor flow-trigger-handoff">
            <Clock3 size={20} />
            <div>
              <strong>Triggers are managed separately</strong>
              <p>
                {sourceChangedWithConnectorTrigger
                  ? "Changing the source removes its connector event. Save, then choose a new event on the Triggers page."
                  : "Save this Flow, then configure its schedule, API call, or connector event from the Triggers page."}
              </p>
            </div>
            <Button variant="outline" type="button" asChild>
              <Link to="/triggers">Open Triggers</Link>
            </Button>
          </section>
          <div className="flow-agent-fields">
            <AgentSelect
              value={agentConnectionId}
              choices={agentChoices}
              onChange={(choice) => setAgentConnectionId(choice.id)}
            />
            <Label className="field">
              <span>Tool calls per source</span>
              <Input
                type="number"
                min={1}
                max={maximumFlowMaxSteps}
                value={maxSteps}
                onChange={(event) => setMaxSteps(Number(event.target.value))}
                required
              />
              <small>
                Current run limit: {runToolCallLimit} calls across {budgetSourceCount} source
                {budgetSourceCount === 1 ? "" : "s"}. Runs are capped at {maximumFlowRunToolCalls} calls.
              </small>
            </Label>
          </div>
          <div className="flow-tools-heading">
            <div>
              <strong>Connector permissions</strong>
              <p>Choose what the agent can do through each side of the Flow.</p>
            </div>
            <Input
              value={toolSearch}
              placeholder="Filter endpoint actions"
              onChange={(event) => setToolSearch(event.target.value)}
            />
          </div>
          <div className="flow-permission-groups">
            {sourceIds.map((sourceId) => {
              const connection = connections.find((candidate) => candidate.id === sourceId);
              const provider = props.data.providers.find((candidate) => candidate.service === connection?.service);
              return (
                <FlowToolPermissionGroup
                  role="source"
                  connection={connection}
                  provider={provider}
                  choices={sourceChoices.filter((choice) => choice.connectionId === sourceId)}
                  visibleChoices={visibleSourceChoices.filter((choice) => choice.connectionId === sourceId)}
                  selectedTools={selectedTools}
                  onToggle={toggleTool}
                  onApprovalChange={changeApproval}
                  key={sourceId}
                />
              );
            })}
            {destinationKind === "connection" ? (
              <FlowToolPermissionGroup
                role="destination"
                connection={destinationConnection}
                provider={destinationProvider}
                choices={destinationChoices}
                visibleChoices={visibleDestinationChoices}
                selectedTools={selectedTools}
                onToggle={toggleTool}
                onApprovalChange={changeApproval}
              />
            ) : (
              <section className="flow-canvas-permission-summary">
                <BrainCircuit size={20} />
                <div>
                  <strong>Canvas destination</strong>
                  <p>The agent’s final result is added to the selected Synapse canvas as a new note card.</p>
                </div>
              </section>
            )}
          </div>
          <div className="button-row">
            <Button
              type="submit"
              disabled={
                saving ||
                connections.length < 1 ||
                !agentConnectionId ||
                sourceIds.length === 0 ||
                !destinationReady ||
                grants.length === 0
              }
            >
              {saving ? "Saving…" : editing ? "Save changes" : "Create Flow"}
            </Button>
            <Button variant="outline" type="button" disabled={saving} onClick={() => navigate("/flows")}>
              Cancel
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

function SourceNode(props: {
  sourceIds: string[];
  connections: Array<ConnectionRecord & { id: string }>;
  providers: ProviderDefinition[];
  onAdd(connectionId: string): void;
  onRemove(connectionId: string): void;
}): ReactNode {
  const selected = props.sourceIds.flatMap((id) => {
    const connection = props.connections.find((candidate) => candidate.id === id);
    return connection
      ? [{ connection, provider: props.providers.find((item) => item.service === connection.service) }]
      : [];
  });
  const available = props.connections.filter((connection) => !props.sourceIds.includes(connection.id));
  const sourceLimitReached = props.sourceIds.length >= maximumFlowSourceConnections;
  return (
    <section className="flow-connector-node source multi-source">
      <div className="flow-connector-heading">
        <span className="flow-connector-placeholder" aria-hidden="true">
          <Cable size={20} />
        </span>
        <div>
          <span>Source connectors</span>
          <strong>{selected.length > 0 ? `${selected.length} selected` : "Choose at least one source"}</strong>
          <small>The agent can read through every selected connection.</small>
        </div>
      </div>
      <div className="flow-source-list">
        {selected.map(({ connection, provider }) => (
          <div className="flow-source-item" key={connection.id}>
            {provider ? <ProviderIcon provider={provider} /> : <Cable size={16} />}
            <span>
              <strong>{flowConnectionDisplayName(connection)}</strong>
              <small>{provider?.displayName ?? connection.service}</small>
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={`Remove source ${flowConnectionDisplayName(connection)}`}
              onClick={() => props.onRemove(connection.id)}
            >
              <X size={13} />
            </Button>
          </div>
        ))}
        <Label className="field flow-source-add">
          <span>Add source</span>
          <select
            className="flow-native-select flow-connection-select"
            value=""
            disabled={available.length === 0 || sourceLimitReached}
            onChange={(event) => props.onAdd(event.target.value)}
          >
            <option value="">
              {sourceLimitReached
                ? `${maximumFlowSourceConnections} source limit reached`
                : available.length > 0
                  ? "Choose another connection"
                  : "All connections selected"}
            </option>
            {available.map((connection) => {
              const provider = props.providers.find((item) => item.service === connection.service);
              return (
                <option key={connection.id} value={connection.id}>
                  {provider?.displayName ?? connection.service} · {flowConnectionDisplayName(connection)}
                </option>
              );
            })}
          </select>
        </Label>
      </div>
    </section>
  );
}

function DestinationNode(props: {
  kind: FlowDestinationKind;
  connectionId: string;
  connection: (ConnectionRecord & { id: string }) | undefined;
  provider: ProviderDefinition | undefined;
  connections: Array<ConnectionRecord & { id: string }>;
  providers: ProviderDefinition[];
  synapses: SynapseWorkspaceSummary[];
  synapseId: string;
  synapseName: string;
  onKindChange(value: FlowDestinationKind): void;
  onConnectionChange(value: string): void;
  onSynapseChange(value: string): void;
  onSynapseNameChange(value: string): void;
}): ReactNode {
  const synapse = props.synapses.find((item) => item.id === props.synapseId);
  const title =
    props.kind === "connection"
      ? props.connection
        ? flowConnectionDisplayName(props.connection)
        : "Choose a connection"
      : props.kind === "existing_synapse"
        ? (synapse?.name ?? (props.synapseId ? "Existing canvas" : "Choose a canvas"))
        : props.synapseName.trim() || "Name a new canvas";

  return (
    <section className="flow-connector-node destination">
      <div className="flow-connector-heading">
        {props.kind === "connection" && props.provider ? (
          <ProviderIcon provider={props.provider} large />
        ) : (
          <span className="flow-connector-placeholder flow-canvas-placeholder" aria-hidden="true">
            {props.kind === "connection" ? <Cable size={20} /> : <BrainCircuit size={20} />}
          </span>
        )}
        <div>
          <span>{props.kind === "connection" ? "Destination connector" : "Destination canvas"}</span>
          <strong>{title}</strong>
          <small>
            {props.kind === "connection" ? (props.provider?.displayName ?? "Connected application") : "Synapse canvas"}
          </small>
        </div>
      </div>
      <div className="flow-destination-fields">
        <Label className="field">
          <span>Destination type</span>
          <select
            className="flow-native-select flow-connection-select"
            aria-label="Destination type"
            value={props.kind}
            onChange={(event) => props.onKindChange(event.target.value as FlowDestinationKind)}
          >
            <option value="connection">Connector</option>
            <option value="existing_synapse">Existing canvas</option>
            <option value="new_synapse">New canvas</option>
          </select>
        </Label>
        {props.kind === "connection" ? (
          <div className="field">
            <span>Connection</span>
            <FlowConnectionPicker
              role="destination"
              value={props.connectionId}
              connections={props.connections}
              providers={props.providers}
              onChange={props.onConnectionChange}
            />
          </div>
        ) : props.kind === "existing_synapse" ? (
          <Label className="field">
            <span>Canvas</span>
            <select
              className="flow-native-select flow-connection-select"
              value={props.synapseId}
              onChange={(event) => props.onSynapseChange(event.target.value)}
              required
            >
              <option value="">Choose a canvas</option>
              {props.synapseId && !synapse ? (
                <option value={props.synapseId}>Current canvas · {props.synapseId}</option>
              ) : null}
              {props.synapses.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.nodeCount} nodes
                </option>
              ))}
            </select>
          </Label>
        ) : (
          <Label className="field">
            <span>Canvas name</span>
            <Input
              value={props.synapseName}
              maxLength={120}
              placeholder="Daily operations digest"
              onChange={(event) => props.onSynapseNameChange(event.target.value)}
              required
            />
          </Label>
        )}
      </div>
    </section>
  );
}

function FlowDirection(props: { label: string }): ReactNode {
  return (
    <div className="flow-direction" aria-label={`${props.label} flow direction`}>
      <small>{props.label}</small>
      <span className="flow-direction-track" aria-hidden="true">
        <ArrowRight size={18} />
      </span>
    </div>
  );
}

function AgentSelect(props: { value: string; choices: AgentChoice[]; onChange(choice: AgentChoice): void }): ReactNode {
  return (
    <Label className="field">
      <span>Agent runtime</span>
      <select
        className="flow-native-select flow-connection-select"
        value={props.value}
        onChange={(event) => {
          const choice = props.choices.find((item) => item.id === event.target.value);
          if (choice) {
            props.onChange(choice);
          }
        }}
        required
      >
        <option value="">Choose an agent</option>
        {props.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </Label>
  );
}

function createToolChoices(
  data: AppData,
  sourceIds: string[],
  destinationId: string | undefined,
): FlowToolPermissionChoice[] {
  return [
    ...sourceIds.flatMap((sourceId) => choicesForConnection(data, sourceId, "source")),
    ...(destinationId ? choicesForConnection(data, destinationId, "destination") : []),
  ];
}

function choicesForConnection(
  data: AppData,
  connectionId: string,
  role: "source" | "destination",
): FlowToolPermissionChoice[] {
  const connection = data.connections.find((item) => item.id === connectionId);
  const provider = data.providers.find((item) => item.service === connection?.service);
  if (!connection || !provider) {
    return [];
  }
  return provider.actions
    .filter((action) => action.execution.locallyExecutable)
    .map((action) => ({
      key: flowToolSelectionKey(role, connectionId, action.id),
      connectionId,
      role,
      actionId: action.id,
      actionName: action.name,
      actionDescription: action.description,
      defaultApproval:
        data.connectionPermissions?.find(
          (permission) => permission.connectionId === connectionId && permission.actionId === action.id,
        )?.approval ?? "always_allow",
    }));
}

export function flowToolSelectionKey(role: "source" | "destination", connectionId: string, actionId: string): string {
  return `${role}\0${connectionId}\0${actionId}`;
}

function flowToolRole(flow: FlowDefinition, tool: FlowToolGrant): "source" | "destination" {
  return tool.role ?? (flowSourceConnectionIds(flow).includes(tool.connectionId) ? "source" : "destination");
}
