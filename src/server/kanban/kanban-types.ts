export type KanbanScalar = string | number | boolean | null;

export interface KanbanColumn {
  id: string;
  label: string;
  value: KanbanScalar;
  color?: string;
}

export interface KanbanCardMapping {
  id: string;
  title: string;
  column: string;
  description?: string;
  priority?: string;
  labels?: string;
  assignee?: string;
  dueDate?: string;
  url?: string;
  revision?: string;
}

/**
 * Recursive JSON template resolved immediately before a provider update.
 * Exact string tokens can reference `$card`, `$raw`, `$source.input`, or `$target`.
 */
export interface KanbanWriteBack {
  actionId: string;
  inputTemplate: Record<string, unknown>;
}

export interface KanbanSource {
  id: string;
  name: string;
  connectionId: string;
  actionId: string;
  input: Record<string, unknown>;
  itemsPath: string;
  mapping: KanbanCardMapping;
  writeBack?: KanbanWriteBack;
}

export interface KanbanBoardDefinition {
  id: string;
  name: string;
  cardLimit?: number;
  columns: KanbanColumn[];
  sources: KanbanSource[];
  createdAt: string;
  updatedAt: string;
}

export interface KanbanBoardDefinitionInput {
  name: string;
  cardLimit?: number;
  columns: KanbanColumn[];
  sources: KanbanSource[];
}

export interface KanbanGenerationInput {
  prompt: string;
  agentConnectionId: string;
  current?: KanbanBoardDefinitionInput;
}

export interface IKanbanBoardGenerator {
  generate(input: unknown): Promise<unknown>;
}

export interface KanbanBoardSummary {
  id: string;
  name: string;
  columnCount: number;
  sourceCount: number;
  editableSourceCount: number;
  updatedAt: string;
}

export interface KanbanPendingChange {
  columnId: string;
  approvalId: string;
  status: "waiting_for_approval";
}

export interface KanbanCard {
  key: string;
  sourceId: string;
  connectionId: string;
  providerService: string;
  externalId: string;
  title: string;
  columnId: string;
  editable: boolean;
  description?: string;
  priority?: KanbanScalar;
  labels?: string[];
  assignee?: string;
  dueDate?: string;
  url?: string;
  revision?: KanbanScalar;
  pending?: KanbanPendingChange;
}

export interface KanbanSourceResult {
  sourceId: string;
  status: "completed" | "failed" | "waiting_for_approval";
  itemCount: number;
  skippedCount: number;
  limited?: boolean;
  approvalId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface KanbanBoardSnapshot {
  board: KanbanBoardDefinition;
  cards: KanbanCard[];
  sources: KanbanSourceResult[];
  refreshedAt: string;
}

export interface KanbanMoveResult {
  status: "completed" | "waiting_for_approval";
  snapshot: KanbanBoardSnapshot;
  approvalId?: string;
}

export interface IKanbanStore {
  setBoard(board: KanbanBoardDefinition): Promise<void>;
  getBoard(id: string): Promise<KanbanBoardDefinition | undefined>;
  listBoards(limit?: number): Promise<KanbanBoardDefinition[]>;
  deleteBoard(id: string): Promise<boolean>;
}
