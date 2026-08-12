import type { FlowToolPermissionChoice } from "./flow-tool-permission-group";
import type {
  AppData,
  ConnectionRecord,
  FlowApprovalSetting,
  FlowDefinition,
  FlowTrigger,
  FlowToolGrant,
  ProviderDefinition,
} from "./model";
import type { FormEvent, ReactNode } from "react";

import { ArrowLeft, ArrowRight, Cable, Clock3, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { apiPost, apiPut } from "./api";
import { FlowConnectionPicker, flowConnectionDisplayName } from "./flow-connection-picker";
import { FlowToolPermissionGroup } from "./flow-tool-permission-group";
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
const maximumFlowMaxSteps = 50;

interface AgentChoice {
  id: string;
  label: string;
}

interface FlowDraft {
  name: string;
  status: "active" | "paused";
  sourceConnectionId: string;
  destinationConnectionId: string;
  instructions: string;
  trigger: FlowTrigger;
  agent: {
    provider: "claude_code";
    connectionId: string;
    reasoningEffort: "none" | "low" | "medium" | "high";
  };
  tools: FlowToolGrant[];
  maxSteps: number;
}

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
    ...(props.data.agentConnections ?? [])
      .filter((connection) => connection.provider === "claude_code")
      .map((connection) => ({
        id: connection.id,
        label: `${connection.displayName} · Claude Code`,
      })),
  ];
  const editing = props.flow !== undefined;
  const [name, setName] = useState(props.flow?.name ?? "");
  const [sourceId, setSourceId] = useState(props.flow?.sourceConnectionId ?? connections[0]?.id ?? "");
  const [destinationId, setDestinationId] = useState(
    props.flow?.destinationConnectionId ?? connections[1]?.id ?? connections[0]?.id ?? "",
  );
  const [agentConnectionId, setAgentConnectionId] = useState(
    props.flow?.agent.connectionId ?? agentChoices[0]?.id ?? "",
  );
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

  const choices = useMemo(
    () => createToolChoices(props.data, sourceId, destinationId),
    [props.data, sourceId, destinationId],
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
  const sourceConnection = connections.find((connection) => connection.id === sourceId);
  const destinationConnection = connections.find((connection) => connection.id === destinationId);
  const sourceProvider = props.data.providers.find((provider) => provider.service === sourceConnection?.service);
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
    props.flow.sourceConnectionId !== sourceId &&
    existingTrigger !== undefined &&
    (existingTrigger.type === "event" ||
      existingTrigger.type === "new_email" ||
      existingTrigger.type === "file_created");
  const trigger: FlowTrigger = sourceChangedWithConnectorTrigger
    ? { type: "manual" }
    : (props.flow?.trigger ?? { type: "manual" });

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

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const draft: FlowDraft = {
      name,
      status: props.flow?.status ?? "active",
      sourceConnectionId: sourceId,
      destinationConnectionId: destinationId,
      instructions,
      trigger,
      agent: {
        provider: "claude_code",
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
            <p>Choose exactly two endpoints, then expose only the tools this agent needs.</p>
          </div>
          <Badge>{grants.length} tools</Badge>
        </div>

        {error ? <InlineError message={error} /> : null}
        {connections.length < 1 ? (
          <InlineError message="Connect at least one endpoint connection before creating a Flow." />
        ) : null}
        {!agentConnectionId ? (
          <InlineError message="Connect a Claude subscription from the Agents panel before saving this Flow." />
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
            <ConnectionNode
              role="source"
              value={sourceId}
              connection={sourceConnection}
              provider={sourceProvider}
              connections={connections}
              providers={props.data.providers}
              onChange={setSourceId}
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
            <ConnectionNode
              role="destination"
              value={destinationId}
              connection={destinationConnection}
              provider={destinationProvider}
              connections={connections}
              providers={props.data.providers}
              onChange={setDestinationId}
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
              <span>Maximum tool calls</span>
              <Input
                type="number"
                min={1}
                max={maximumFlowMaxSteps}
                value={maxSteps}
                onChange={(event) => setMaxSteps(Number(event.target.value))}
                required
              />
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
            <FlowToolPermissionGroup
              role="source"
              connection={sourceConnection}
              provider={sourceProvider}
              choices={sourceChoices}
              visibleChoices={visibleSourceChoices}
              selectedTools={selectedTools}
              onToggle={toggleTool}
              onApprovalChange={changeApproval}
            />
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
          </div>
          <div className="button-row">
            <Button
              type="submit"
              disabled={
                saving ||
                connections.length < 1 ||
                !agentConnectionId ||
                !sourceId ||
                !destinationId ||
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

function ConnectionNode(props: {
  role: "source" | "destination";
  value: string;
  connection: (ConnectionRecord & { id: string }) | undefined;
  provider: ProviderDefinition | undefined;
  connections: Array<ConnectionRecord & { id: string }>;
  providers: ProviderDefinition[];
  onChange(value: string): void;
}): ReactNode {
  const title = props.role === "source" ? "Source connector" : "Destination connector";
  return (
    <section className={`flow-connector-node ${props.role}`}>
      <div className="flow-connector-heading">
        {props.provider ? (
          <ProviderIcon provider={props.provider} large />
        ) : (
          <span className="flow-connector-placeholder" aria-hidden="true">
            <Cable size={20} />
          </span>
        )}
        <div>
          <span>{title}</span>
          <strong>{props.connection ? flowConnectionDisplayName(props.connection) : "Choose a connection"}</strong>
          <small>{props.provider?.displayName ?? "Connected application"}</small>
        </div>
      </div>
      <div className="field">
        <span>Connection</span>
        <FlowConnectionPicker
          role={props.role}
          value={props.value}
          connections={props.connections}
          providers={props.providers}
          onChange={props.onChange}
        />
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

function createToolChoices(data: AppData, sourceId: string, destinationId: string): FlowToolPermissionChoice[] {
  return [
    ...choicesForConnection(data, sourceId, "source"),
    ...choicesForConnection(data, destinationId, "destination"),
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
  return tool.role ?? (tool.connectionId === flow.sourceConnectionId ? "source" : "destination");
}
