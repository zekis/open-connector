import type {
  ActionDefinition,
  AppData,
  ConnectionRecord,
  FullActionDefinition,
  JsonSchema,
  KanbanBoardDefinition,
  KanbanBoardDefinitionInput,
  KanbanBoardSnapshot,
  KanbanBoardSummary,
  KanbanCard,
  KanbanColumn,
  KanbanMoveResult,
  KanbanPreset,
  ProviderDefinition,
} from "./model";
import type { DragEvent, FormEvent, ReactNode } from "react";

import {
  AlertTriangle,
  Check,
  Columns3,
  ExternalLink,
  GripVertical,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "./api";
import { EmptyState, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";

export function KanbanPage(props: { data: AppData; onRefresh(): void }): ReactNode {
  const [boards, setBoards] = useState<KanbanBoardSummary[]>([]);
  const [presets, setPresets] = useState<KanbanPreset[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string>();
  const [snapshot, setSnapshot] = useState<KanbanBoardSnapshot>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [movingCardKey, setMovingCardKey] = useState<string>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [error, setError] = useState<string>();

  const loadBoards = useCallback(async (): Promise<KanbanBoardSummary[]> => {
    const next = await apiGet<KanbanBoardSummary[]>("/api/kanban-boards");
    setBoards(next);
    setSelectedBoardId((current) => (current && next.some((board) => board.id === current) ? current : next[0]?.id));
    return next;
  }, []);

  const refreshBoard = useCallback(async (boardId: string): Promise<void> => {
    setRefreshing(true);
    setError(undefined);
    try {
      setSnapshot(await apiPost<KanbanBoardSnapshot>(`/api/kanban-boards/${encodeURIComponent(boardId)}/refresh`, {}));
    } catch (caught) {
      setError(errorMessage(caught));
      setSnapshot(undefined);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([apiGet<KanbanBoardSummary[]>("/api/kanban-boards"), apiGet<KanbanPreset[]>("/api/kanban-presets")])
      .then(([nextBoards, nextPresets]) => {
        if (cancelled) return;
        setBoards(nextBoards);
        setPresets(nextPresets);
        setSelectedBoardId(nextBoards[0]?.id);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedBoardId) {
      setSnapshot(undefined);
      return;
    }
    void refreshBoard(selectedBoardId);
  }, [refreshBoard, selectedBoardId]);

  async function moveCard(card: KanbanCard, column: KanbanColumn): Promise<void> {
    if (!selectedBoardId || !card.editable || movingCardKey) return;
    setMovingCardKey(card.key);
    setError(undefined);
    try {
      const result = await apiPost<KanbanMoveResult>(
        `/api/kanban-boards/${encodeURIComponent(selectedBoardId)}/cards/${encodeURIComponent(card.key)}/move`,
        { columnId: column.id },
      );
      setSnapshot(result.snapshot);
      if (result.status === "waiting_for_approval") props.onRefresh();
      await loadBoards();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setMovingCardKey(undefined);
    }
  }

  async function saveBoard(definition: KanbanBoardDefinitionInput): Promise<void> {
    const saved =
      snapshot?.board && editorOpen
        ? await apiPut<KanbanBoardDefinition>(`/api/kanban-boards/${encodeURIComponent(snapshot.board.id)}`, definition)
        : await apiPost<KanbanBoardDefinition>("/api/kanban-boards", definition);
    await loadBoards();
    setSelectedBoardId(saved.id);
    setEditorOpen(false);
    await refreshBoard(saved.id);
  }

  async function deleteBoard(): Promise<void> {
    if (
      !selectedBoardId ||
      !window.confirm("Delete this Connected Kanban board? Provider items will not be deleted.")
    ) {
      return;
    }
    setError(undefined);
    try {
      await apiDelete(`/api/kanban-boards/${encodeURIComponent(selectedBoardId)}`);
      setSnapshot(undefined);
      setSelectedBoardId(undefined);
      await loadBoards();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const configuredConnections = props.data.connections.filter((connection) => connection.configured && connection.id);

  return (
    <div className="kanban-page">
      <header className="kanban-toolbar">
        <div className="kanban-board-picker">
          <Columns3 size={20} />
          <select
            value={selectedBoardId ?? ""}
            onChange={(event) => setSelectedBoardId(event.target.value || undefined)}
            aria-label="Connected Kanban board"
          >
            {boards.length === 0 ? <option value="">No boards yet</option> : null}
            {boards.map((board) => (
              <option value={board.id} key={board.id}>
                {board.name}
              </option>
            ))}
          </select>
          {snapshot ? (
            <span className="kanban-board-summary">
              {snapshot.cards.length}/{snapshot.board.cardLimit ?? 50} cards · {snapshot.board.sources.length} source
              {snapshot.board.sources.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <div className="kanban-toolbar-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={!selectedBoardId || refreshing}
            onClick={() => selectedBoardId && void refreshBoard(selectedBoardId)}
          >
            <RefreshCw className={refreshing ? "spin" : undefined} size={15} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" disabled={!snapshot} onClick={() => setEditorOpen(true)}>
            <Settings2 size={15} />
            Configure
          </Button>
          <Button variant="outline" size="sm" disabled={!selectedBoardId} onClick={() => void deleteBoard()}>
            <Trash2 size={15} />
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setSnapshot(undefined);
              setEditorOpen(true);
            }}
          >
            <Plus size={15} />
            New board
          </Button>
        </div>
      </header>

      {error ? <InlineError message={error} /> : null}

      {editorOpen ? (
        <KanbanEditor
          current={snapshot?.board}
          connections={configuredConnections}
          providers={props.data.providers}
          presets={presets}
          onCancel={() => setEditorOpen(false)}
          onSave={saveBoard}
        />
      ) : loading || refreshing ? (
        <div className="kanban-loading">
          <Loader2 className="spin" size={18} />
          Loading Connected Kanban…
        </div>
      ) : snapshot ? (
        <KanbanBoardView
          snapshot={snapshot}
          providers={props.data.providers}
          movingCardKey={movingCardKey}
          onMove={moveCard}
        />
      ) : (
        <EmptyState
          icon={<Columns3 size={22} />}
          title="Turn connector data into a board"
          description="Start from a connector preset or map any JSON collection into deterministic Kanban cards."
          action={
            <Button onClick={() => setEditorOpen(true)}>
              <Plus size={15} />
              Create Connected Kanban
            </Button>
          }
        />
      )}
    </div>
  );
}

function KanbanBoardView(props: {
  snapshot: KanbanBoardSnapshot;
  providers: ProviderDefinition[];
  movingCardKey?: string;
  onMove(card: KanbanCard, column: KanbanColumn): Promise<void>;
}): ReactNode {
  const hasUnmapped = props.snapshot.cards.some((card) => displayedColumnId(card) === "__unmapped");
  const columns = hasUnmapped
    ? [...props.snapshot.board.columns, { id: "__unmapped", label: "Unmapped", value: null }]
    : props.snapshot.board.columns;
  const issues = props.snapshot.sources.filter((source) => source.status !== "completed" || source.skippedCount > 0);
  const limited = props.snapshot.sources.some((source) => source.limited);

  return (
    <section className="kanban-board-region">
      <div className="kanban-board-notices">
        {issues.length > 0 ? (
          <div className="kanban-source-issues">
            {issues.map((source) => (
              <span key={source.sourceId}>
                <AlertTriangle size={14} />
                {source.sourceId}: {source.errorMessage ?? `${source.skippedCount} items could not be mapped`}
                {source.approvalId ? <a href="/approvals">Approve source access</a> : null}
              </span>
            ))}
          </div>
        ) : null}
        {limited ? (
          <div className="kanban-limit-notice">
            Showing the first {props.snapshot.cards.length} cards within this board’s{" "}
            {props.snapshot.board.cardLimit ?? 50}-card limit. Refine the connector filters to choose which items
            appear.
          </div>
        ) : null}
      </div>
      <div className="kanban-columns" aria-label={`${props.snapshot.board.name} Kanban board`}>
        {columns.map((column) => {
          const cards = props.snapshot.cards.filter((card) => displayedColumnId(card) === column.id);
          return (
            <KanbanColumnView
              column={column}
              cards={cards}
              providers={props.providers}
              movingCardKey={props.movingCardKey}
              onMove={props.onMove}
              key={column.id}
            />
          );
        })}
      </div>
    </section>
  );
}

function KanbanColumnView(props: {
  column: KanbanColumn;
  cards: KanbanCard[];
  providers: ProviderDefinition[];
  movingCardKey?: string;
  onMove(card: KanbanCard, column: KanbanColumn): Promise<void>;
}): ReactNode {
  const [dragOver, setDragOver] = useState(false);

  function drop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setDragOver(false);
    const key = event.dataTransfer.getData("application/x-oomol-kanban-card");
    const card = props.cards.find((candidate) => candidate.key === key);
    const transferred = card ?? kanbanDraggedCard;
    if (transferred && displayedColumnId(transferred) !== props.column.id) void props.onMove(transferred, props.column);
    kanbanDraggedCard = undefined;
  }

  return (
    <section
      className={dragOver ? "kanban-column drag-over" : "kanban-column"}
      onDragOver={(event) => {
        if (!kanbanDraggedCard?.editable || props.column.id === "__unmapped") return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={drop}
    >
      <header>
        <span className="kanban-column-color" style={{ background: props.column.color }} />
        <strong>{props.column.label}</strong>
        <span>{props.cards.length}</span>
      </header>
      <div className="kanban-card-list">
        {props.cards.map((card) => (
          <KanbanCardView
            card={card}
            provider={props.providers.find((provider) => provider.service === card.providerService)}
            moving={props.movingCardKey === card.key}
            key={card.key}
          />
        ))}
        {props.cards.length === 0 ? <div className="kanban-column-empty">Drop cards here</div> : null}
      </div>
    </section>
  );
}

let kanbanDraggedCard: KanbanCard | undefined;

function KanbanCardView(props: { card: KanbanCard; provider?: ProviderDefinition; moving: boolean }): ReactNode {
  const card = props.card;
  return (
    <article
      className={`kanban-card${card.pending ? " pending" : ""}${props.moving ? " moving" : ""}`}
      draggable={card.editable && !card.pending && !props.moving}
      onDragStart={(event) => {
        kanbanDraggedCard = card;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-oomol-kanban-card", card.key);
      }}
      onDragEnd={() => {
        kanbanDraggedCard = undefined;
      }}
    >
      <div className="kanban-card-topline">
        {props.provider?.iconUrl ? (
          <img className="kanban-provider-icon" src={props.provider.iconUrl} alt={props.provider.displayName} />
        ) : (
          <span className="kanban-provider-mark">{card.providerService.slice(0, 2).toUpperCase()}</span>
        )}
        <span>{card.externalId}</span>
        {card.editable ? <GripVertical size={14} /> : null}
      </div>
      <strong>{card.title}</strong>
      {card.description ? <p>{plainText(card.description)}</p> : null}
      <div className="kanban-card-meta">
        {card.priority !== undefined && card.priority !== null ? <span>Priority {String(card.priority)}</span> : null}
        {card.assignee ? <span>{card.assignee}</span> : null}
        {card.dueDate ? <span>{formatDueDate(card.dueDate)}</span> : null}
      </div>
      {card.labels?.length ? (
        <div className="kanban-card-labels">
          {card.labels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      ) : null}
      {card.pending ? (
        <a className="kanban-card-pending" href="/approvals">
          <AlertTriangle size={13} /> Waiting for approval
        </a>
      ) : card.url ? (
        <a className="kanban-card-link" href={card.url} target="_blank" rel="noreferrer">
          Open item <ExternalLink size={12} />
        </a>
      ) : null}
    </article>
  );
}

function KanbanEditor(props: {
  current?: KanbanBoardDefinition;
  connections: ConnectionRecord[];
  providers: ProviderDefinition[];
  presets: KanbanPreset[];
  onCancel(): void;
  onSave(definition: KanbanBoardDefinitionInput): Promise<void>;
}): ReactNode {
  const initialConnectionId = props.current?.sources[0]?.connectionId ?? props.connections[0]?.id ?? "";
  const [connectionId, setConnectionId] = useState(initialConnectionId);
  const [presetId, setPresetId] = useState("");
  const [actionId, setActionId] = useState(props.current?.sources[0]?.actionId ?? "");
  const [definitionText, setDefinitionText] = useState(() =>
    JSON.stringify(props.current ? boardInput(props.current) : genericBoard(props.connections[0]), null, 2),
  );
  const [preview, setPreview] = useState<KanbanBoardSnapshot>();
  const [busy, setBusy] = useState<"map" | "preview" | "save">();
  const [error, setError] = useState<string>();
  const selectedConnection = props.connections.find((connection) => connection.id === connectionId);
  const availablePresets = props.presets.filter(
    (preset) => !selectedConnection || preset.service === selectedConnection.service,
  );
  const availableActions = useMemo(
    () => readableActions(props.providers.find((provider) => provider.service === selectedConnection?.service)),
    [props.providers, selectedConnection?.service],
  );

  const parsed = useMemo(() => {
    try {
      return JSON.parse(definitionText) as KanbanBoardDefinitionInput;
    } catch {
      return undefined;
    }
  }, [definitionText]);

  function applyPreset(): void {
    const preset = props.presets.find((candidate) => candidate.id === presetId);
    if (!preset || !connectionId) return;
    setDefinitionText(
      JSON.stringify(
        {
          name: preset.boardName,
          cardLimit: 50,
          columns: preset.columns,
          sources: [{ ...preset.source, connectionId }],
        } satisfies KanbanBoardDefinitionInput,
        null,
        2,
      ),
    );
    setPreview(undefined);
  }

  async function applyGenericAction(): Promise<void> {
    const action = availableActions.find((candidate) => candidate.id === actionId);
    if (!selectedConnection || !action) return;
    setBusy("map");
    setError(undefined);
    try {
      const fullAction = await apiGet<FullActionDefinition>(`/api/actions/${encodeURIComponent(action.id)}`);
      setDefinitionText(JSON.stringify(genericBoard(selectedConnection, fullAction), null, 2));
      setPreview(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function previewDefinition(): Promise<void> {
    if (!parsed) return setError("Definition must be valid JSON.");
    setBusy("preview");
    setError(undefined);
    try {
      setPreview(await apiPost<KanbanBoardSnapshot>("/api/kanban-boards/preview", parsed));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!parsed) return setError("Definition must be valid JSON.");
    setBusy("save");
    setError(undefined);
    try {
      await props.onSave(parsed);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(undefined);
    }
  }

  return (
    <form className="kanban-editor" onSubmit={(event) => void submit(event)}>
      <header>
        <div>
          <h2>{props.current ? "Configure Connected Kanban" : "Create Connected Kanban"}</h2>
          <p>Start with a reliable connector preset or map any JSON collection using deterministic paths.</p>
        </div>
        <Button variant="ghost" size="icon-sm" type="button" onClick={props.onCancel} aria-label="Close editor">
          <X size={16} />
        </Button>
      </header>
      <div className="kanban-editor-presets">
        <label>
          <span>Connection</span>
          <select
            value={connectionId}
            onChange={(event) => {
              const nextConnectionId = event.target.value;
              const nextConnection = props.connections.find((connection) => connection.id === nextConnectionId);
              const nextActions = readableActions(
                props.providers.find((provider) => provider.service === nextConnection?.service),
              );
              setConnectionId(nextConnectionId);
              setPresetId("");
              setActionId(nextActions[0]?.id ?? "");
            }}
          >
            {props.connections.map((connection) => (
              <option value={connection.id} key={connection.id}>
                {connectionLabel(connection)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Preset</span>
          <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
            <option value="">Generic JSON mapping</option>
            {availablePresets.map((preset) => (
              <option value={preset.id} key={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <label className="kanban-limit-field">
          <span>Maximum cards</span>
          <input
            type="number"
            min={Math.max(1, parsed?.sources.length ?? 1)}
            max={100}
            value={parsed?.cardLimit ?? 50}
            disabled={!parsed}
            onChange={(event) => {
              if (!parsed) return;
              setDefinitionText(JSON.stringify({ ...parsed, cardLimit: Number(event.target.value) }, null, 2));
              setPreview(undefined);
            }}
          />
        </label>
        {presetId ? (
          <Button type="button" variant="outline" disabled={!connectionId} onClick={applyPreset}>
            <Check size={15} /> Use preset
          </Button>
        ) : (
          <>
            <label>
              <span>Read action</span>
              <select value={actionId} onChange={(event) => setActionId(event.target.value)}>
                <option value="">Choose an action</option>
                {availableActions.map((action) => (
                  <option value={action.id} key={action.id}>
                    {action.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={!connectionId || !actionId || Boolean(busy)}
              onClick={() => void applyGenericAction()}
            >
              {busy === "map" ? <Loader2 className="spin" size={15} /> : <Check size={15} />} Use action
            </Button>
          </>
        )}
      </div>
      {props.connections.length === 0 ? (
        <InlineError message="Connect at least one provider before creating a Connected Kanban board." />
      ) : null}
      <label className="kanban-definition-field">
        <span>Board definition</span>
        <textarea
          value={definitionText}
          onChange={(event) => setDefinitionText(event.target.value)}
          spellCheck={false}
        />
      </label>
      <p className="kanban-template-help">
        Paths support keys, quoted keys, indexes, and <code>[*]</code>. Write templates support typed references such as{" "}
        <code>$raw.id</code>, <code>$card.id</code>, <code>$source.input.project</code>, and <code>$target.value</code>.
      </p>
      {error ? <InlineError message={error} /> : null}
      {preview ? (
        <div className="kanban-preview-result">
          <strong>{preview.cards.length} cards mapped</strong>
          <span>
            {preview.sources.reduce((total, source) => total + source.skippedCount, 0)} skipped ·{" "}
            {preview.sources.length} source{preview.sources.length === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}
      <footer>
        <Button
          type="button"
          variant="outline"
          disabled={!parsed || Boolean(busy)}
          onClick={() => void previewDefinition()}
        >
          {busy === "preview" ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          Preview mapping
        </Button>
        <Button type="submit" disabled={!parsed || Boolean(busy) || props.connections.length === 0}>
          {busy === "save" ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
          {props.current ? "Save board" : "Create board"}
        </Button>
      </footer>
    </form>
  );
}

function genericBoard(
  connection: ConnectionRecord | undefined,
  action?: Pick<ActionDefinition, "id" | "name" | "outputSchema">,
): KanbanBoardDefinitionInput {
  const service = connection?.service ?? "connector";
  const shape = inferKanbanActionShape(action);
  return {
    name: `${service.replaceAll("_", " ")} board`,
    cardLimit: 50,
    columns: shape.columns,
    sources: [
      {
        id: `${service}-items`,
        name: `${service.replaceAll("_", " ")} items`,
        connectionId: connection?.id ?? "REPLACE_WITH_CONNECTION_ID",
        actionId: action?.id ?? `${service}.REPLACE_WITH_LIST_ACTION`,
        input: {},
        itemsPath: `$[${JSON.stringify(shape.collection)}][*]`,
        mapping: {
          id: jsonPathProperty(shape.id),
          title: jsonPathProperty(shape.title),
          column: jsonPathProperty(shape.column),
        },
      },
    ],
  };
}

function readableActions(provider: ProviderDefinition | undefined): ActionDefinition[] {
  if (!provider) return [];
  const executable = provider.actions.filter((action) => action.execution.locallyExecutable);
  return executable
    .filter((action) => /(?:^|[._])(get|list|query|search|find|read|fetch)(?:[._]|$)/i.test(action.id))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export interface GenericKanbanActionShape {
  collection: string;
  id: string;
  title: string;
  column: string;
  columns: KanbanColumn[];
}

/** Infers a safe starting mapping from the selected connector action's output schema. */
export function inferKanbanActionShape(
  action: Pick<ActionDefinition, "id" | "name" | "outputSchema"> | undefined,
): GenericKanbanActionShape {
  const outputProperties = schemaProperties(action?.outputSchema);
  const collectionEntry = Object.entries(outputProperties).find(([, schema]) => readRecord(schema)?.type === "array");
  const collection = collectionEntry?.[0] ?? inferredCollectionName(action);
  const collectionSchema = readRecord(collectionEntry?.[1]);
  const itemProperties = schemaProperties(readRecord(collectionSchema?.items));
  const id = firstProperty(itemProperties, ["id", "key", "number", "uid"]) ?? "id";
  const title =
    firstProperty(itemProperties, ["title", "name", "subject", "content", "summary", "displayName"]) ?? "title";
  const column = firstProperty(itemProperties, ["status", "state", "priority", "category", "stage"]) ?? "status";
  return { collection, id, title, column, columns: inferredColumns(readRecord(itemProperties[column])) };
}

function inferredCollectionName(action: Pick<ActionDefinition, "id" | "name"> | undefined): string {
  if (!action) return "items";
  const actionName = action.id.split(".").at(-1) ?? action.name;
  return actionName.replace(/^(?:get|list|query|search|find|read|fetch)[_-]?/i, "") || "items";
}

function inferredColumns(schema: Record<string, unknown> | undefined): KanbanColumn[] {
  const values = Array.isArray(schema?.enum) ? schema.enum.filter(isKanbanScalar).slice(0, 24) : [];
  if (values.length > 0) {
    return values.map((value, index) => ({ id: `column-${index + 1}`, label: humanize(value), value }));
  }
  if (schema?.type === "integer" && Number.isInteger(schema.minimum) && Number.isInteger(schema.maximum)) {
    const minimum = Number(schema.minimum);
    const maximum = Number(schema.maximum);
    if (maximum >= minimum && maximum - minimum < 24) {
      return Array.from({ length: maximum - minimum + 1 }, (_, index) => {
        const value = minimum + index;
        return { id: `column-${value}`, label: String(value), value };
      });
    }
  }
  return [
    { id: "todo", label: "To do", value: "todo" },
    { id: "doing", label: "Doing", value: "doing" },
    { id: "done", label: "Done", value: "done" },
  ];
}

function schemaProperties(schema: JsonSchema | Record<string, unknown> | undefined): Record<string, unknown> {
  return readRecord(schema?.properties) ?? {};
}

function firstProperty(properties: Record<string, unknown>, candidates: string[]): string | undefined {
  const keys = Object.keys(properties);
  return candidates.map((candidate) => keys.find((key) => key.toLowerCase() === candidate.toLowerCase())).find(Boolean);
}

function jsonPathProperty(property: string): string {
  return `$[${JSON.stringify(property)}]`;
}

function humanize(value: string | number | boolean | null): string {
  return String(value ?? "None")
    .replaceAll(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isKanbanScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function boardInput(board: KanbanBoardDefinition): KanbanBoardDefinitionInput {
  return { name: board.name, cardLimit: board.cardLimit ?? 50, columns: board.columns, sources: board.sources };
}

function displayedColumnId(card: KanbanCard): string {
  return card.pending?.columnId ?? card.columnId;
}

function connectionLabel(connection: ConnectionRecord): string {
  const profile = connection.profile as { displayName?: unknown } | null | undefined;
  const displayName = typeof profile?.displayName === "string" ? profile.displayName : undefined;
  return `${connection.service.replaceAll("_", " ")} · ${displayName ?? connection.connectionName ?? "default"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : "Connected Kanban request failed.";
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function formatDueDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
