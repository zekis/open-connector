import type {
  AgentConnectionSummary,
  AppData,
  KanbanBoardDefinition,
  KanbanBoardDefinitionInput,
  KanbanBoardSnapshot,
  KanbanBoardSummary,
  KanbanCard,
  KanbanColumn,
  KanbanMoveResult,
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
  Sparkles,
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
    apiGet<KanbanBoardSummary[]>("/api/kanban-boards")
      .then((nextBoards) => {
        if (cancelled) return;
        setBoards(nextBoards);
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
          agentConnections={props.data.agentConnections ?? []}
          connectionCount={configuredConnections.length}
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
          description="Describe the board you need. A connected agent will choose the right connector actions and map their data into cards."
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
  agentConnections: AgentConnectionSummary[];
  connectionCount: number;
  onCancel(): void;
  onSave(definition: KanbanBoardDefinitionInput): Promise<void>;
}): ReactNode {
  const [prompt, setPrompt] = useState("");
  const [agentConnectionId, setAgentConnectionId] = useState(props.agentConnections[0]?.id ?? "");
  const [definitionText, setDefinitionText] = useState(() =>
    props.current ? JSON.stringify(boardInput(props.current), null, 2) : "",
  );
  const [preview, setPreview] = useState<KanbanBoardSnapshot>();
  const [busy, setBusy] = useState<"generate" | "preview" | "save">();
  const [error, setError] = useState<string>();

  const parsed = useMemo(() => parseKanbanDefinitionText(definitionText), [definitionText]);

  async function generateDefinition(): Promise<void> {
    if (!prompt.trim() || !agentConnectionId) return;
    setBusy("generate");
    setError(undefined);
    try {
      const generated = await apiPost<KanbanBoardDefinitionInput>("/api/kanban-boards/generate", {
        prompt,
        agentConnectionId,
        current: parsed,
      });
      setDefinitionText(JSON.stringify(generated, null, 2));
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
          <p>Tell your agent what should appear and how you want it organized.</p>
        </div>
        <Button variant="ghost" size="icon-sm" type="button" onClick={props.onCancel} aria-label="Close editor">
          <X size={16} />
        </Button>
      </header>
      <section className="kanban-generation-panel">
        <label className="kanban-prompt-field">
          <span>Describe your board</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Show my open work items by status, with priority, assignee, and due date. Let me move cards between statuses."
            maxLength={4000}
          />
        </label>
        <div className="kanban-generation-controls">
          <label>
            <span>Agent</span>
            <select value={agentConnectionId} onChange={(event) => setAgentConnectionId(event.target.value)}>
              <option value="">Choose an agent</option>
              {props.agentConnections.map((agent) => (
                <option value={agent.id} key={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            disabled={!prompt.trim() || !agentConnectionId || Boolean(busy) || props.connectionCount === 0}
            onClick={() => void generateDefinition()}
          >
            {busy === "generate" ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
            {parsed ? "Regenerate board" : "Generate board"}
          </Button>
        </div>
      </section>
      {props.connectionCount === 0 ? (
        <InlineError message="Connect at least one provider before creating a Connected Kanban board." />
      ) : null}
      {props.agentConnections.length === 0 ? (
        <InlineError message="Connect a subscription agent from the Agents page before generating a board." />
      ) : null}
      {parsed ? (
        <div className="kanban-draft-summary">
          <div>
            <strong>{parsed.name}</strong>
            <span>
              {parsed.columns.length} columns · {parsed.sources.length} source{parsed.sources.length === 1 ? "" : "s"}
            </span>
          </div>
          <label className="kanban-limit-field">
            <span>Maximum cards</span>
            <input
              type="number"
              min={Math.max(1, parsed.sources.length)}
              max={100}
              value={parsed.cardLimit ?? 50}
              onChange={(event) => {
                setDefinitionText(JSON.stringify({ ...parsed, cardLimit: Number(event.target.value) }, null, 2));
                setPreview(undefined);
              }}
            />
          </label>
        </div>
      ) : null}
      <details className="kanban-advanced-definition">
        <summary>Advanced board definition</summary>
        <label className="kanban-definition-field">
          <span>JSON definition</span>
          <textarea
            value={definitionText}
            onChange={(event) => setDefinitionText(event.target.value)}
            spellCheck={false}
          />
        </label>
        <p className="kanban-template-help">
          Paths support keys, quoted keys, indexes, and <code>[*]</code>. Write templates support typed references such
          as <code>$raw.id</code>, <code>$card.id</code>, <code>$source.input.project</code>, and{" "}
          <code>$target.value</code>.
        </p>
      </details>
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
        <Button type="submit" disabled={!parsed || Boolean(busy) || props.connectionCount === 0}>
          {busy === "save" ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
          {props.current ? "Save board" : "Create board"}
        </Button>
      </footer>
    </form>
  );
}

function boardInput(board: KanbanBoardDefinition): KanbanBoardDefinitionInput {
  return { name: board.name, cardLimit: board.cardLimit ?? 50, columns: board.columns, sources: board.sources };
}

/** Parses the advanced editor without letting incomplete JSON crash the natural-language workflow. */
export function parseKanbanDefinitionText(value: string): KanbanBoardDefinitionInput | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const board = parsed as Record<string, unknown>;
    if (typeof board.name !== "string" || !Array.isArray(board.columns) || !Array.isArray(board.sources)) {
      return undefined;
    }
    return board as unknown as KanbanBoardDefinitionInput;
  } catch {
    return undefined;
  }
}

function displayedColumnId(card: KanbanCard): string {
  return card.pending?.columnId ?? card.columnId;
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
