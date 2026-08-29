import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService } from "../../connection-service.ts";
import type { ActionPolicySnapshot } from "../../core/action-policy.ts";
import type { IActionRunner } from "../actions/action-runner.ts";
import type { ConnectionApprovalService } from "../approvals/connection-approval-service.ts";
import type {
  IKanbanStore,
  KanbanBoardDefinition,
  KanbanBoardDefinitionInput,
  KanbanBoardSnapshot,
  KanbanBoardSummary,
  KanbanCard,
  KanbanCardMapping,
  KanbanColumn,
  KanbanMoveResult,
  KanbanScalar,
  KanbanSource,
  KanbanSourceResult,
} from "./kanban-types.ts";

import { selectKanbanItems, selectKanbanPath } from "./kanban-path.ts";

const maximumBoardNameCharacters = 120;
const maximumSourceNameCharacters = 120;
const maximumColumns = 24;
const maximumSources = 16;
const defaultBoardCardLimit = 50;
const maximumBoardCardLimit = 100;
const maximumCardTextCharacters = 10_000;
const paginationInputNames = [
  "limit",
  "top",
  "pageSize",
  "page_size",
  "perPage",
  "per_page",
  "maxResults",
  "max_results",
  "first",
  "take",
];

export interface KanbanServiceOptions {
  catalog: CatalogStore;
  connections: Pick<ConnectionService, "getConnectionSummaryById">;
  actions: Pick<IActionRunner, "run">;
  approvals?: Pick<ConnectionApprovalService, "getActionApproval">;
  store: IKanbanStore;
  getPolicySnapshot(): Promise<ActionPolicySnapshot>;
}

type KanbanErrorStatus = 400 | 404 | 409 | 429 | 503;

interface CachedKanbanCard {
  card: KanbanCard;
  raw: unknown;
  source: KanbanSource;
}

interface CachedKanbanBoard {
  snapshot: KanbanBoardSnapshot;
  cards: Map<string, CachedKanbanCard>;
}

interface PendingKanbanMove {
  boardId: string;
  cardKey: string;
  columnId: string;
  approvalId: string;
}

interface ProjectedSource {
  cards: CachedKanbanCard[];
  result: KanbanSourceResult;
}

/** Owns persistent Connected Kanban definitions and provider-backed card projection. */
export class KanbanService {
  private readonly options: KanbanServiceOptions;
  private readonly cache = new Map<string, CachedKanbanBoard>();
  private readonly pendingMoves = new Map<string, PendingKanbanMove>();

  constructor(options: KanbanServiceOptions) {
    this.options = options;
  }

  async list(): Promise<KanbanBoardSummary[]> {
    return (await this.options.store.listBoards()).map((board) => ({
      id: board.id,
      name: board.name,
      columnCount: board.columns.length,
      sourceCount: board.sources.length,
      editableSourceCount: board.sources.filter((source) => source.writeBack).length,
      updatedAt: board.updatedAt,
    }));
  }

  async get(id: string): Promise<KanbanBoardDefinition> {
    return structuredClone(await this.requiredBoard(id));
  }

  async create(input: unknown): Promise<KanbanBoardDefinition> {
    const definition = readBoardInput(input);
    await this.validateSources(definition.sources);
    const now = new Date().toISOString();
    const board: KanbanBoardDefinition = {
      ...definition,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await this.options.store.setBoard(board);
    return structuredClone(board);
  }

  async update(id: string, input: unknown): Promise<KanbanBoardDefinition> {
    const current = await this.requiredBoard(id);
    const definition = readBoardInput(input);
    await this.validateSources(definition.sources);
    const board: KanbanBoardDefinition = {
      ...definition,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.options.store.setBoard(board);
    this.cache.delete(id);
    for (const [approvalId, move] of this.pendingMoves) {
      if (move.boardId === id) this.pendingMoves.delete(approvalId);
    }
    return structuredClone(board);
  }

  async delete(id: string): Promise<{ deleted: true }> {
    if (!(await this.options.store.deleteBoard(id))) {
      throw new KanbanError("kanban_not_found", `Kanban board not found: ${id}.`, 404);
    }
    this.cache.delete(id);
    for (const [approvalId, move] of this.pendingMoves) {
      if (move.boardId === id) this.pendingMoves.delete(approvalId);
    }
    return { deleted: true };
  }

  async preview(input: unknown): Promise<KanbanBoardSnapshot> {
    const definition = readBoardInput(input);
    await this.validateSources(definition.sources);
    const now = new Date().toISOString();
    return structuredClone(
      (
        await this.loadBoard({
          ...definition,
          id: "preview",
          createdAt: now,
          updatedAt: now,
        })
      ).snapshot,
    );
  }

  async refresh(id: string): Promise<KanbanBoardSnapshot> {
    return structuredClone((await this.loadBoard(await this.requiredBoard(id))).snapshot);
  }

  async moveCard(boardId: string, cardKey: string, columnId: string): Promise<KanbanMoveResult> {
    const board = await this.requiredBoard(boardId);
    const column = board.columns.find((candidate) => candidate.id === columnId);
    if (!column) throw new KanbanError("kanban_column_not_found", `Kanban column not found: ${columnId}.`, 404);
    const cached = this.cache.get(boardId) ?? (await this.loadBoard(board));
    const cachedCard = cached.cards.get(cardKey);
    if (!cachedCard) throw new KanbanError("kanban_card_not_found", `Kanban card not found: ${cardKey}.`, 404);
    if (cachedCard.card.pending) {
      throw new KanbanError("kanban_move_pending", "This card already has a change waiting for approval.", 409);
    }
    if (cachedCard.card.columnId === columnId) {
      return { status: "completed", snapshot: structuredClone(cached.snapshot) };
    }
    if (!cachedCard.source.writeBack) {
      throw new KanbanError("kanban_card_read_only", "This Kanban source does not have a write-back mapping.", 409);
    }

    const writeBack = cachedCard.source.writeBack;
    const input = resolveWriteTemplate(writeBack.inputTemplate, cachedCard, column);
    const run = await this.options.actions.run({
      actionId: writeBack.actionId,
      connectionId: cachedCard.source.connectionId,
      input,
      caller: "web",
      policy: await this.options.getPolicySnapshot(),
    });
    if (!run) throw new KanbanError("kanban_action_not_found", `Unknown action: ${writeBack.actionId}.`, 404);
    if (run.result.ok) {
      return { status: "completed", snapshot: await this.refresh(boardId) };
    }
    const approvalId = readApprovalId(run.result.error?.details);
    if (run.result.error?.code === "approval_pending" && approvalId) {
      const move: PendingKanbanMove = { boardId, cardKey, columnId, approvalId };
      this.pendingMoves.set(approvalId, move);
      applyPendingMove(cached.snapshot, move);
      return { status: "waiting_for_approval", approvalId, snapshot: structuredClone(cached.snapshot) };
    }
    throw new KanbanError(
      run.result.error?.code ?? "kanban_write_failed",
      run.result.error?.message ?? "The connector rejected this Kanban change.",
      run.result.error?.code === "rate_limited" ? 429 : 409,
    );
  }

  private async loadBoard(board: KanbanBoardDefinition): Promise<CachedKanbanBoard> {
    const policy = await this.options.getPolicySnapshot();
    const cardLimit = normalizeCardLimit(board.cardLimit);
    const sourceLimits = allocateSourceLimits(cardLimit, board.sources.length);
    const projected = await Promise.all(
      board.sources.map((source, index) => this.loadSource(board, source, policy, sourceLimits[index]!)),
    );
    const cached: CachedKanbanBoard = {
      snapshot: {
        board: structuredClone({ ...board, cardLimit }),
        cards: projected.flatMap((source) => source.cards.map((card) => card.card)),
        sources: projected.map((source) => source.result),
        refreshedAt: new Date().toISOString(),
      },
      cards: new Map(projected.flatMap((source) => source.cards.map((card) => [card.card.key, card] as const))),
    };
    await this.decoratePendingMoves(cached);
    if (board.id !== "preview") this.cache.set(board.id, cached);
    return cached;
  }

  private async loadSource(
    board: KanbanBoardDefinition,
    source: KanbanSource,
    policy: ActionPolicySnapshot,
    cardLimit: number,
  ): Promise<ProjectedSource> {
    const action = this.options.catalog.actionsById.get(source.actionId);
    const run = await this.options.actions.run({
      actionId: source.actionId,
      connectionId: source.connectionId,
      input: applyProviderResultLimit(source.input, action?.inputSchema, cardLimit),
      caller: "web",
      policy,
    });
    if (!run?.result.ok) {
      const approvalId = readApprovalId(run?.result.error?.details);
      return {
        cards: [],
        result: {
          sourceId: source.id,
          status: approvalId ? "waiting_for_approval" : "failed",
          itemCount: 0,
          skippedCount: 0,
          approvalId,
          errorCode: run?.result.error?.code ?? "kanban_source_failed",
          errorMessage: run?.result.error?.message ?? "The Kanban source action failed.",
        },
      };
    }
    let items: unknown[];
    try {
      items = selectKanbanItems(run.result.output, source.itemsPath);
    } catch (error) {
      return {
        cards: [],
        result: {
          sourceId: source.id,
          status: "failed",
          itemCount: 0,
          skippedCount: 0,
          errorCode: "invalid_kanban_path",
          errorMessage: error instanceof Error ? error.message : "The source items path is invalid.",
        },
      };
    }
    const limited = items.length > cardLimit || hasMoreProviderResults(run.result.output);
    items = items.slice(0, cardLimit);
    const cards: CachedKanbanCard[] = [];
    const keys = new Set<string>();
    for (const item of items) {
      const card = projectCard(board, source, item);
      if (!card || keys.has(card.card.key)) continue;
      keys.add(card.card.key);
      cards.push(card);
    }
    return {
      cards,
      result: {
        sourceId: source.id,
        status: "completed",
        itemCount: cards.length,
        skippedCount: items.length - cards.length,
        limited,
      },
    };
  }

  private async decoratePendingMoves(cached: CachedKanbanBoard): Promise<void> {
    const moves = [...this.pendingMoves.values()].filter((move) => move.boardId === cached.snapshot.board.id);
    await Promise.all(
      moves.map(async (move) => {
        const approval = await this.options.approvals?.getActionApproval(move.approvalId);
        if (
          !approval ||
          approval.status === "denied" ||
          approval.status === "expired" ||
          approval.status === "consumed"
        ) {
          this.pendingMoves.delete(move.approvalId);
          return;
        }
        applyPendingMove(cached.snapshot, move);
      }),
    );
  }

  private async validateSources(sources: KanbanSource[]): Promise<void> {
    await Promise.all(
      sources.map(async (source) => {
        const connection = await this.options.connections.getConnectionSummaryById(source.connectionId);
        if (!connection) {
          throw new KanbanError("kanban_connection_not_found", `Connection not found: ${source.connectionId}.`, 404);
        }
        const readAction = this.options.catalog.actionsById.get(source.actionId);
        if (!readAction || !readAction.execution.locallyExecutable) {
          throw new KanbanError("kanban_action_not_found", `Executable action not found: ${source.actionId}.`, 404);
        }
        if (readAction.service !== connection.service) {
          throw new KanbanError(
            "kanban_connection_mismatch",
            `${source.actionId} cannot use connection ${source.connectionId}.`,
          );
        }
        if (!source.writeBack) return;
        const writeAction = this.options.catalog.actionsById.get(source.writeBack.actionId);
        if (!writeAction || !writeAction.execution.locallyExecutable) {
          throw new KanbanError(
            "kanban_write_action_not_found",
            `Executable write action not found: ${source.writeBack.actionId}.`,
            404,
          );
        }
        if (writeAction.service !== connection.service) {
          throw new KanbanError(
            "kanban_write_connection_mismatch",
            `${source.writeBack.actionId} cannot use connection ${source.connectionId}.`,
          );
        }
      }),
    );
  }

  private async requiredBoard(id: string): Promise<KanbanBoardDefinition> {
    const board = await this.options.store.getBoard(id);
    if (!board) throw new KanbanError("kanban_not_found", `Kanban board not found: ${id}.`, 404);
    return board;
  }
}

function readBoardInput(value: unknown): KanbanBoardDefinitionInput {
  const body = readObject(value, "Kanban board");
  const columns = readArray(body.columns, "columns", 1, maximumColumns).map(readColumn);
  const sources = readArray(body.sources, "sources", 1, maximumSources).map(readSource);
  const cardLimit = readOptionalInteger(body.cardLimit, "cardLimit", 1, maximumBoardCardLimit) ?? defaultBoardCardLimit;
  if (cardLimit < sources.length) {
    throw new KanbanError("invalid_kanban", "cardLimit must allow at least one card for every source.");
  }
  assertUnique(
    columns.map((column) => column.id),
    "column IDs",
  );
  assertUnique(
    columns.map((column) => column.value),
    "column values",
  );
  assertUnique(
    sources.map((source) => source.id),
    "source IDs",
  );
  return {
    name: readText(body.name, "name", maximumBoardNameCharacters),
    cardLimit,
    columns,
    sources,
  };
}

function readColumn(value: unknown, index: number): KanbanColumn {
  const body = readObject(value, `columns[${index}]`);
  return {
    id: readText(body.id, `columns[${index}].id`, 100),
    label: readText(body.label, `columns[${index}].label`, 100),
    value: readScalar(body.value, `columns[${index}].value`),
    color: readOptionalText(body.color, `columns[${index}].color`, 40),
  };
}

function readSource(value: unknown, index: number): KanbanSource {
  const body = readObject(value, `sources[${index}]`);
  const mapping = readMapping(body.mapping, index);
  validatePath(readText(body.itemsPath, `sources[${index}].itemsPath`, 500));
  for (const path of Object.values(mapping)) {
    if (path) validatePath(path);
  }
  const writeBack =
    body.writeBack === undefined ? undefined : readObject(body.writeBack, `sources[${index}].writeBack`);
  if (writeBack) validateWriteTemplate(writeBack.inputTemplate);
  return {
    id: readText(body.id, `sources[${index}].id`, 100),
    name: readText(body.name, `sources[${index}].name`, maximumSourceNameCharacters),
    connectionId: readText(body.connectionId, `sources[${index}].connectionId`, 200),
    actionId: readText(body.actionId, `sources[${index}].actionId`, 200),
    input: readObject(body.input, `sources[${index}].input`),
    itemsPath: readText(body.itemsPath, `sources[${index}].itemsPath`, 500),
    mapping,
    writeBack: writeBack
      ? {
          actionId: readText(writeBack.actionId, `sources[${index}].writeBack.actionId`, 200),
          inputTemplate: structuredClone(
            readObject(writeBack.inputTemplate, `sources[${index}].writeBack.inputTemplate`),
          ),
        }
      : undefined,
  };
}

function readMapping(value: unknown, index: number): KanbanCardMapping {
  const body = readObject(value, `sources[${index}].mapping`);
  return {
    id: readText(body.id, `sources[${index}].mapping.id`, 500),
    title: readText(body.title, `sources[${index}].mapping.title`, 500),
    column: readText(body.column, `sources[${index}].mapping.column`, 500),
    description: readOptionalText(body.description, `sources[${index}].mapping.description`, 500),
    priority: readOptionalText(body.priority, `sources[${index}].mapping.priority`, 500),
    labels: readOptionalText(body.labels, `sources[${index}].mapping.labels`, 500),
    assignee: readOptionalText(body.assignee, `sources[${index}].mapping.assignee`, 500),
    dueDate: readOptionalText(body.dueDate, `sources[${index}].mapping.dueDate`, 500),
    url: readOptionalText(body.url, `sources[${index}].mapping.url`, 500),
    revision: readOptionalText(body.revision, `sources[${index}].mapping.revision`, 500),
  };
}

function projectCard(board: KanbanBoardDefinition, source: KanbanSource, raw: unknown): CachedKanbanCard | undefined {
  const externalId = mappedScalar(raw, source.mapping.id);
  const title = mappedScalar(raw, source.mapping.title);
  if (externalId === undefined || title === undefined || externalId === null || title === null) return undefined;
  const columnValue = mappedScalar(raw, source.mapping.column);
  const column = board.columns.find((candidate) => scalarEquals(candidate.value, columnValue));
  const card: KanbanCard = {
    key: `${source.id}:${String(externalId)}`,
    sourceId: source.id,
    connectionId: source.connectionId,
    providerService: source.actionId.split(".")[0] ?? source.actionId,
    externalId: String(externalId),
    title: boundedText(title),
    columnId: column?.id ?? "__unmapped",
    editable: Boolean(source.writeBack),
    description: mappedText(raw, source.mapping.description),
    priority: mappedScalar(raw, source.mapping.priority),
    labels: mappedLabels(raw, source.mapping.labels),
    assignee: mappedText(raw, source.mapping.assignee),
    dueDate: mappedText(raw, source.mapping.dueDate),
    url: mappedUrl(raw, source.mapping.url),
    revision: mappedScalar(raw, source.mapping.revision),
  };
  return { card, raw, source };
}

function resolveWriteTemplate(template: unknown, cached: CachedKanbanCard, target: KanbanColumn): unknown {
  const context = {
    card: {
      id: cached.card.externalId,
      key: cached.card.key,
      title: cached.card.title,
      columnId: cached.card.columnId,
      revision: cached.card.revision,
    },
    raw: cached.raw,
    source: { id: cached.source.id, input: cached.source.input },
    target: { id: target.id, label: target.label, value: target.value },
  };
  return resolveTemplateValue(template, context);
}

function resolveTemplateValue(template: unknown, context: Record<string, unknown>): unknown {
  if (typeof template === "string" && template.startsWith("$")) {
    const values = selectKanbanPath(context, template);
    if (values.length === 0) {
      throw new KanbanError("kanban_template_value_missing", `Write template value was not found: ${template}.`);
    }
    return structuredClone(values[0]);
  }
  if (Array.isArray(template)) return template.map((item) => resolveTemplateValue(item, context));
  if (isRecord(template)) {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, resolveTemplateValue(value, context)]),
    );
  }
  return template;
}

function applyPendingMove(snapshot: KanbanBoardSnapshot, move: PendingKanbanMove): void {
  const card = snapshot.cards.find((candidate) => candidate.key === move.cardKey);
  if (!card) return;
  card.pending = {
    columnId: move.columnId,
    approvalId: move.approvalId,
    status: "waiting_for_approval",
  };
}

function mappedScalar(raw: unknown, path: string | undefined): KanbanScalar | undefined {
  if (!path) return undefined;
  const value = selectKanbanPath(raw, path)[0];
  return isScalar(value) ? value : undefined;
}

function mappedText(raw: unknown, path: string | undefined): string | undefined {
  const value = mappedScalar(raw, path);
  return value === undefined || value === null ? undefined : boundedText(value);
}

function mappedLabels(raw: unknown, path: string | undefined): string[] | undefined {
  if (!path) return undefined;
  const selected = selectKanbanPath(raw, path)[0];
  const labels = Array.isArray(selected)
    ? selected
        .filter(isScalar)
        .filter((value) => value !== null)
        .map(String)
    : typeof selected === "string"
      ? selected.split(/[;,]/)
      : [];
  const normalized = labels
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 20);
  return normalized.length > 0 ? normalized : undefined;
}

function mappedUrl(raw: unknown, path: string | undefined): string | undefined {
  const value = mappedText(raw, path);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function readApprovalId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.approvalId === "string" ? value.approvalId : undefined;
}

function scalarEquals(left: KanbanScalar, right: KanbanScalar | undefined): boolean {
  return right !== undefined && (Object.is(left, right) || String(left) === String(right));
}

function boundedText(value: KanbanScalar): string {
  return String(value).slice(0, maximumCardTextCharacters);
}

function normalizeCardLimit(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined
    ? Math.max(1, Math.min(value, maximumBoardCardLimit))
    : defaultBoardCardLimit;
}

function allocateSourceLimits(cardLimit: number, sourceCount: number): number[] {
  const base = Math.floor(cardLimit / sourceCount);
  const remainder = cardLimit % sourceCount;
  return Array.from({ length: sourceCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function applyProviderResultLimit(
  input: Record<string, unknown>,
  inputSchema: unknown,
  cardLimit: number,
): Record<string, unknown> {
  const properties = readObjectProperty(inputSchema, "properties");
  const propertyName = paginationInputNames.find((candidate) => properties && Object.hasOwn(properties, candidate));
  if (!propertyName || !properties) return structuredClone(input);
  const propertySchema = isRecord(properties[propertyName]) ? properties[propertyName] : undefined;
  const maximum = typeof propertySchema?.maximum === "number" ? Math.floor(propertySchema.maximum) : cardLimit;
  const providerLimit = Math.max(1, Math.min(cardLimit, maximum));
  const current = input[propertyName];
  if (current !== undefined && (typeof current !== "number" || !Number.isFinite(current))) {
    return structuredClone(input);
  }
  return { ...structuredClone(input), [propertyName]: Math.min(Math.floor(current ?? providerLimit), providerLimit) };
}

function hasMoreProviderResults(output: unknown): boolean {
  if (!isRecord(output)) return false;
  const containers = [output, output.pagination, output.meta, output.pageInfo].filter(isRecord);
  return containers.some((container) =>
    ["nextLink", "next_link", "nextCursor", "next_cursor", "hasMore", "has_more", "hasNextPage"].some((key) => {
      const value = container[key];
      return value === true || (typeof value === "string" && value.trim().length > 0);
    }),
  );
}

function readObjectProperty(value: unknown, property: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[property]) ? value[property] : undefined;
}

function validatePath(path: string): void {
  try {
    selectKanbanPath(null, path);
  } catch (error) {
    throw new KanbanError(
      "invalid_kanban_path",
      error instanceof Error ? error.message : `Invalid JSON path: ${path}.`,
    );
  }
}

function validateWriteTemplate(value: unknown): void {
  if (typeof value === "string" && value.startsWith("$")) {
    validatePath(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateWriteTemplate(item);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) validateWriteTemplate(item);
  }
}

function assertUnique<T>(values: T[], label: string): void {
  if (new Set(values).size !== values.length) throw new KanbanError("invalid_kanban", `${label} must be unique.`);
}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new KanbanError("invalid_kanban", `${field} must be a JSON object.`);
  return value;
}

function readArray(value: unknown, field: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new KanbanError("invalid_kanban", `${field} must contain between ${minimum} and ${maximum} items.`);
  }
  return value;
}

function readText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new KanbanError("invalid_kanban", `${field} must be a non-empty string up to ${maximum} characters.`);
  }
  return value.trim();
}

function readOptionalText(value: unknown, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : readText(value, field, maximum);
}

function readOptionalInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new KanbanError("invalid_kanban", `${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function readScalar(value: unknown, field: string): KanbanScalar {
  if (!isScalar(value)) throw new KanbanError("invalid_kanban", `${field} must be a string, number, boolean, or null.`);
  return value;
}

function isScalar(value: unknown): value is KanbanScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class KanbanError extends Error {
  readonly code: string;
  readonly status: KanbanErrorStatus;

  constructor(code: string, message: string, status: KanbanErrorStatus = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
