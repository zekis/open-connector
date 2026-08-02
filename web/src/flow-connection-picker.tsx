import type { ConnectionRecord, ProviderDefinition } from "./model";
import type { ReactNode } from "react";

import { Cable, Check, ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ProviderIcon } from "./shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type ConnectionWithId = ConnectionRecord & { id: string };

interface FlowConnectionPickerProps {
  role: "source" | "destination";
  value: string;
  connections: ConnectionWithId[];
  providers: ProviderDefinition[];
  onChange(value: string): void;
}

interface FlowConnectionOption {
  connection: ConnectionWithId;
  provider?: ProviderDefinition;
  displayName: string;
}

export function FlowConnectionPicker(props: FlowConnectionPickerProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = useMemo(
    () => createConnectionOptions(props.connections, props.providers),
    [props.connections, props.providers],
  );
  const visibleOptions = filterFlowConnectionOptions(options, query);
  const selected = options.find((option) => option.connection.id === props.value);
  const roleLabel = props.role === "source" ? "source" : "destination";

  function changeOpen(next: boolean): void {
    setOpen(next);
    if (!next) {
      setQuery("");
    }
  }

  function choose(connectionId: string): void {
    props.onChange(connectionId);
    changeOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          className="flow-connection-picker-trigger"
          variant="outline"
          type="button"
          aria-label={`Choose ${roleLabel} connector`}
        >
          <span>
            <strong>{selected?.displayName ?? "Choose a connection"}</strong>
            <small>{selected?.provider?.displayName ?? selected?.connection.service ?? "Connected application"}</small>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="flow-connection-dialog max-w-[min(640px,calc(100vw-2rem))] gap-0 overflow-hidden p-0 sm:max-w-[min(640px,calc(100vw-2rem))]">
        <DialogHeader className="flow-connection-dialog-header">
          <DialogTitle>Choose {roleLabel} connector</DialogTitle>
          <DialogDescription>
            Select the connection the agent will use as the Flow&apos;s {roleLabel} endpoint.
          </DialogDescription>
        </DialogHeader>
        <div className="flow-connection-search">
          <Search size={16} aria-hidden="true" />
          <Input
            value={query}
            placeholder="Search connections or providers"
            aria-label="Search connections"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flow-connection-results" role="group" aria-label={`${roleLabel} connections`}>
          {visibleOptions.length === 0 ? (
            <div className="flow-connection-empty">
              <Search size={20} aria-hidden="true" />
              <strong>No connections found</strong>
              <span>Try a connection name, provider, or service.</span>
            </div>
          ) : (
            visibleOptions.map((option) => {
              const selectedOption = option.connection.id === props.value;
              return (
                <button
                  className={selectedOption ? "flow-connection-option selected" : "flow-connection-option"}
                  type="button"
                  aria-pressed={selectedOption}
                  key={option.connection.id}
                  onClick={() => choose(option.connection.id)}
                >
                  {option.provider ? (
                    <ProviderIcon provider={option.provider} large />
                  ) : (
                    <span className="flow-connector-placeholder" aria-hidden="true">
                      <Cable size={20} />
                    </span>
                  )}
                  <span className="flow-connection-option-main">
                    <strong>{option.displayName}</strong>
                    <small>
                      {option.provider?.displayName ?? option.connection.service} · {option.connection.service}
                    </small>
                  </span>
                  {selectedOption ? (
                    <span className="flow-connection-selected-mark" aria-label="Selected">
                      <Check size={16} />
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
        <footer className="flow-connection-dialog-footer">
          <span>
            {visibleOptions.length} of {options.length} connections
          </span>
          <span>Provider icons identify each connected application.</span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function createConnectionOptions(
  connections: ConnectionWithId[],
  providers: ProviderDefinition[],
): FlowConnectionOption[] {
  const providersByService = new Map(providers.map((provider) => [provider.service, provider]));
  return connections
    .map((connection) => ({
      connection,
      provider: providersByService.get(connection.service),
      displayName: flowConnectionDisplayName(connection),
    }))
    .sort((left, right) =>
      `${left.provider?.displayName ?? left.connection.service}\0${left.displayName}`.localeCompare(
        `${right.provider?.displayName ?? right.connection.service}\0${right.displayName}`,
      ),
    );
}

function filterFlowConnectionOptions(options: FlowConnectionOption[], query: string): FlowConnectionOption[] {
  return options.filter((option) => flowConnectionMatchesQuery(option.connection, option.provider, query));
}

export function flowConnectionMatchesQuery(
  connection: ConnectionRecord,
  provider: ProviderDefinition | undefined,
  query: string,
): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const searchable = [
    flowConnectionDisplayName(connection),
    connection.connectionName,
    connection.service,
    provider?.displayName,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

export function flowConnectionDisplayName(connection: ConnectionRecord): string {
  return connection.profile &&
    typeof connection.profile.displayName === "string" &&
    connection.profile.displayName.trim()
    ? connection.profile.displayName
    : connection.connectionName || connection.service;
}
