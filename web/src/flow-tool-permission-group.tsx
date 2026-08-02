import type { ConnectionRecord, FlowApprovalMode, ProviderDefinition } from "./model";
import type { ReactNode } from "react";

import { Cable } from "lucide-react";
import { flowConnectionDisplayName } from "./flow-connection-picker";
import { ProviderIcon } from "./shared-ui";

export interface FlowToolPermissionChoice {
  key: string;
  connectionId: string;
  role: "source" | "destination";
  actionId: string;
  actionName: string;
  actionDescription: string;
}

interface FlowToolPermissionGroupProps {
  role: "source" | "destination";
  connection: (ConnectionRecord & { id: string }) | undefined;
  provider: ProviderDefinition | undefined;
  choices: FlowToolPermissionChoice[];
  visibleChoices: FlowToolPermissionChoice[];
  selectedTools: Record<string, FlowApprovalMode>;
  onToggle(key: string, enabled: boolean): void;
  onApprovalChange(key: string, approval: FlowApprovalMode): void;
}

export function FlowToolPermissionGroup(props: FlowToolPermissionGroupProps): ReactNode {
  const roleLabel = props.role === "source" ? "Source" : "Destination";
  const selectedCount = props.choices.filter((choice) => props.selectedTools[choice.key]).length;
  return (
    <section className={`flow-permission-group ${props.role}`}>
      <header className="flow-permission-group-header">
        {props.provider ? (
          <ProviderIcon provider={props.provider} large />
        ) : (
          <span className="flow-connector-placeholder" aria-hidden="true">
            <Cable size={20} />
          </span>
        )}
        <div>
          <span>{roleLabel} permissions</span>
          <strong>{props.connection ? flowConnectionDisplayName(props.connection) : `Choose a ${props.role}`}</strong>
          <small>{props.provider?.displayName ?? "No connector selected"}</small>
        </div>
        <span className="flow-permission-count">
          {selectedCount}/{props.choices.length} allowed
        </span>
      </header>
      <div className="flow-tool-list">
        {props.visibleChoices.length === 0 ? (
          <div className="flow-permission-empty">
            <strong>No matching actions</strong>
            <span>
              {props.choices.length === 0
                ? "This connector has no executable actions."
                : "Adjust the permission search to see this connector’s actions."}
            </span>
          </div>
        ) : (
          props.visibleChoices.map((choice) => {
            const approval = props.selectedTools[choice.key];
            return (
              <label className="flow-tool-row" key={choice.key}>
                <input
                  type="checkbox"
                  checked={Boolean(approval)}
                  onChange={(event) => props.onToggle(choice.key, event.target.checked)}
                />
                <span className="flow-tool-main">
                  <strong>{choice.actionName}</strong>
                  <small>{choice.actionId}</small>
                </span>
                <select
                  className="flow-native-select"
                  aria-label={`Approval policy for ${choice.actionName}`}
                  value={approval ?? "require_approval"}
                  disabled={!approval}
                  onChange={(event) => props.onApprovalChange(choice.key, event.target.value as FlowApprovalMode)}
                >
                  <option value="require_approval">Require approval</option>
                  <option value="always_allow">Always allow</option>
                </select>
              </label>
            );
          })
        )}
      </div>
    </section>
  );
}
