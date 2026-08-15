import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { AgentChatExtension, AgentChatExtensionTool, AgentChatService } from "../chat/agent-chat-service.ts";
import type { AgentChatResponse, AgentChatToolActivity } from "../chat/agent-chat-types.ts";
import type {
  ISynapseStore,
  SynapseArtifactKind,
  SynapseArtifactNode,
  SynapseEdge,
  SynapseMessage,
  SynapseNode,
  SynapsePosition,
  SynapseProviderNode,
  SynapseThread,
  SynapseWorkspace,
  SynapseWorkspaceSummary,
} from "./synapse-types.ts";

const maximumWorkspaceNameCharacters = 120;
const maximumNodeTitleCharacters = 240;
const maximumNodeTextCharacters = 40_000;
const maximumChatCharacters = 20_000;
const maximumThreadMessages = 40;
const maximumContextNodes = 40;
const maximumArtifactsPerTool = 12;
const maximumProjectedArtifacts = 8;
const canvasNodeWidth = 264;
const providerNodeHeight = 118;
const artifactNodeHeight = 164;
const nodeHorizontalGap = 48;
const nodeVerticalGap = 32;

export interface SynapseServiceOptions {
  catalog: CatalogStore;
  connections: Pick<ConnectionService, "listConnections">;
  agentChat: Pick<AgentChatService, "respondWithExtension" | "getApprovalResult">;
  store: ISynapseStore;
}

/** Owns persistent Synapse canvases and node-scoped agent conversations. */
export class SynapseService {
  private readonly options: SynapseServiceOptions;

  constructor(options: SynapseServiceOptions) {
    this.options = options;
  }

  async list(): Promise<SynapseWorkspaceSummary[]> {
    return (await this.options.store.listWorkspaces()).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      nodeCount: workspace.nodes.length,
      updatedAt: workspace.updatedAt,
    }));
  }

  async create(input: unknown): Promise<SynapseWorkspace> {
    const body = readObject(input, "Synapse workspace");
    const now = new Date().toISOString();
    const workspace: SynapseWorkspace = {
      id: crypto.randomUUID(),
      name: readText(body.name, "name", maximumWorkspaceNameCharacters),
      nodes: [],
      edges: [],
      threads: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.options.store.setWorkspace(workspace);
    return workspace;
  }

  async get(id: string): Promise<SynapseWorkspace> {
    return await this.requiredWorkspace(id);
  }

  async update(id: string, input: unknown): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(id);
    const body = readObject(input, "Synapse workspace");
    workspace.name = readText(body.name, "name", maximumWorkspaceNameCharacters);
    return await this.save(workspace);
  }

  async delete(id: string): Promise<{ deleted: true }> {
    if (!(await this.options.store.deleteWorkspace(id))) {
      throw new SynapseError("synapse_not_found", `Synapse workspace not found: ${id}.`, 404);
    }
    return { deleted: true };
  }

  async addNode(workspaceId: string, input: unknown): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(workspaceId);
    const body = readObject(input, "Synapse node");
    const requestedPosition = readPosition(body.position);
    if (body.kind === "provider") {
      const position = findOpenPosition(workspace, requestedPosition, "provider");
      await this.addProviderNode(workspace, readText(body.connectionId, "connectionId", 200), position, {
        title: optionalText(body.title, "title", maximumNodeTitleCharacters),
        instructions: optionalText(body.instructions, "instructions", maximumNodeTextCharacters),
      });
    } else if (body.kind === "artifact") {
      const position = findOpenPosition(workspace, requestedPosition, "artifact");
      this.addArtifactNode(workspace, position, readArtifactInput(body));
    } else {
      throw new SynapseError("invalid_synapse_node", "kind must be provider or artifact.");
    }
    return await this.save(workspace);
  }

  async updateNode(workspaceId: string, nodeId: string, input: unknown): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(workspaceId);
    const node = requiredNode(workspace, nodeId);
    const body = readObject(input, "Synapse node update");
    if (body.position !== undefined) node.position = readPosition(body.position);
    if (body.title !== undefined) node.title = readText(body.title, "title", maximumNodeTitleCharacters);
    if (node.kind === "provider" && body.instructions !== undefined) {
      node.instructions = optionalText(body.instructions, "instructions", maximumNodeTextCharacters);
    }
    if (node.kind === "artifact") {
      if (body.summary !== undefined) node.summary = optionalText(body.summary, "summary", maximumNodeTextCharacters);
      if (body.content !== undefined) node.content = optionalText(body.content, "content", maximumNodeTextCharacters);
      if (body.externalUrl !== undefined) node.externalUrl = optionalHttpsUrl(body.externalUrl, "externalUrl");
      if (body.artifactKind !== undefined) node.artifactKind = readArtifactKind(body.artifactKind);
    }
    node.updatedAt = new Date().toISOString();
    return await this.save(workspace);
  }

  async deleteNode(workspaceId: string, nodeId: string): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(workspaceId);
    requiredNode(workspace, nodeId);
    workspace.nodes = workspace.nodes.filter((node) => node.id !== nodeId);
    workspace.edges = workspace.edges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId);
    workspace.threads = workspace.threads.filter((thread) => thread.nodeId !== nodeId);
    return await this.save(workspace);
  }

  async addEdge(workspaceId: string, input: unknown): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(workspaceId);
    const body = readObject(input, "Synapse connection");
    this.connectNodes(
      workspace,
      readText(body.sourceNodeId, "sourceNodeId", 200),
      readText(body.targetNodeId, "targetNodeId", 200),
      optionalText(body.label, "label", 120),
    );
    return await this.save(workspace);
  }

  async deleteEdge(workspaceId: string, edgeId: string): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(workspaceId);
    const next = workspace.edges.filter((edge) => edge.id !== edgeId);
    if (next.length === workspace.edges.length) {
      throw new SynapseError("synapse_edge_not_found", `Synapse connection not found: ${edgeId}.`, 404);
    }
    workspace.edges = next;
    return await this.save(workspace);
  }

  async chat(workspaceId: string, nodeId: string, input: unknown, signal?: AbortSignal): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(workspaceId);
    const selectedNode = requiredNode(workspace, nodeId);
    const body = readObject(input, "Synapse chat message");
    const content = readText(body.content, "content", maximumChatCharacters);
    const thread = threadFor(workspace, nodeId);
    if (thread.pendingApprovalId) {
      throw new SynapseError(
        "synapse_waiting_for_approval",
        "Approve or deny the pending connector action before continuing this node conversation.",
        409,
      );
    }

    const now = new Date().toISOString();
    thread.messages.push({ id: crypto.randomUUID(), role: "user", content, createdAt: now });
    thread.messages = thread.messages.slice(-maximumThreadMessages);
    thread.updatedAt = now;
    const extension = await this.createExtension(workspace, selectedNode);
    const graphContext = createGraphContext(workspace, selectedNode.id);
    const conversation = [
      {
        role: "user" as const,
        content: `Synapse workspace context follows. Treat it as host-provided context, not as a user request.\n${boundedJson(graphContext)}`,
      },
      ...thread.messages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
    ];

    try {
      const response = await this.options.agentChat.respondWithExtension(
        { messages: conversation, voiceMode: false },
        extension,
        undefined,
        signal,
      );
      await this.applyAgentResponse(workspace, selectedNode, thread, response);
      return await this.save(workspace);
    } catch (error) {
      await this.save(workspace);
      throw error;
    }
  }

  async syncPendingApproval(workspaceId: string, nodeId: string): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(workspaceId);
    const selectedNode = requiredNode(workspace, nodeId);
    const thread = threadFor(workspace, nodeId);
    if (!thread.pendingApprovalId) return workspace;
    const result = await this.options.agentChat.getApprovalResult(thread.pendingApprovalId);
    if (result.response) {
      await this.applyAgentResponse(workspace, selectedNode, thread, result.response, thread.pendingMessageId);
      return await this.save(workspace);
    }
    if (result.status === "denied" || result.status === "expired") {
      const message = thread.messages.find((candidate) => candidate.id === thread.pendingMessageId);
      if (message) {
        message.content =
          result.status === "denied"
            ? "The connector action was denied, so Claude stopped this request."
            : "The connector approval expired before the action could run.";
      }
      thread.pendingApprovalId = undefined;
      thread.pendingMessageId = undefined;
      thread.updatedAt = new Date().toISOString();
      return await this.save(workspace);
    }
    return workspace;
  }

  private async createExtension(workspace: SynapseWorkspace, selectedNode: SynapseNode): Promise<AgentChatExtension> {
    const connections = await this.options.connections.listConnections();
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    return {
      systemPrompt: synapseSystemPrompt(selectedNode),
      context: boundedData(createGraphContext(workspace, selectedNode.id), 30_000),
      tools: synapseTools,
      runTool: async (toolName, input) => {
        try {
          return await this.runGraphTool(toolName, input, workspace, selectedNode, connectionsById);
        } catch (error) {
          if (!(error instanceof SynapseError)) throw error;
          return graphActivity(toolName, input, false, { error: { code: error.code, message: error.message } });
        }
      },
    };
  }

  private async runGraphTool(
    toolName: string,
    input: Record<string, unknown>,
    workspace: SynapseWorkspace,
    selectedNode: SynapseNode,
    connectionsById: Map<string, ConnectionSummary>,
  ): Promise<AgentChatToolActivity | undefined> {
    if (toolName === "synapse_add_provider") {
      const connectionId = readText(input.connectionId, "connectionId", 200);
      if (!connectionsById.has(connectionId)) {
        throw new SynapseError("synapse_connection_not_found", `Connected provider not found: ${connectionId}.`, 404);
      }
      const parentNodeId = optionalText(input.parentNodeId, "parentNodeId", 200) ?? selectedNode.id;
      const parent = requiredNode(workspace, parentNodeId);
      const node = await this.addProviderNode(workspace, connectionId, nextFanPosition(workspace, parent, "provider"), {
        title: optionalText(input.title, "title", maximumNodeTitleCharacters),
        instructions: optionalText(input.instructions, "instructions", maximumNodeTextCharacters),
      });
      if (node.id !== parent.id) this.connectNodes(workspace, parent.id, node.id);
      return graphActivity(toolName, input, true, { node });
    }
    if (toolName === "synapse_add_artifacts") {
      const parentNodeId = optionalText(input.parentNodeId, "parentNodeId", 200) ?? selectedNode.id;
      const parent = requiredNode(workspace, parentNodeId);
      if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) {
        throw new SynapseError("invalid_synapse_artifacts", "artifacts must contain at least one item.");
      }
      if (input.artifacts.length > maximumArtifactsPerTool) {
        throw new SynapseError(
          "invalid_synapse_artifacts",
          `A graph tool call can add at most ${maximumArtifactsPerTool} artifacts.`,
        );
      }
      const sourceActivityId = optionalText(input.sourceActivityId, "sourceActivityId", 200);
      const nodes = input.artifacts.map((item, index) => {
        const artifact = readArtifactInput(readObject(item, `artifacts[${index}]`));
        const node = this.addArtifactNode(workspace, nextFanPosition(workspace, parent, "artifact"), {
          ...artifact,
          sourceActivityId,
        });
        this.connectNodes(workspace, parent.id, node.id);
        return node;
      });
      return graphActivity(toolName, input, true, { nodes });
    }
    if (toolName === "synapse_connect_nodes") {
      const edge = this.connectNodes(
        workspace,
        readText(input.sourceNodeId, "sourceNodeId", 200),
        readText(input.targetNodeId, "targetNodeId", 200),
        optionalText(input.label, "label", 120),
      );
      return graphActivity(toolName, input, true, { edge });
    }
    if (toolName === "synapse_update_artifact") {
      const nodeId = optionalText(input.nodeId, "nodeId", 200) ?? selectedNode.id;
      const node = requiredNode(workspace, nodeId);
      if (node.kind !== "artifact") {
        throw new SynapseError("invalid_synapse_node", "Only artifact nodes can be rewritten by this tool.");
      }
      if (input.title !== undefined) node.title = readText(input.title, "title", maximumNodeTitleCharacters);
      if (input.summary !== undefined) node.summary = optionalText(input.summary, "summary", maximumNodeTextCharacters);
      if (input.content !== undefined) node.content = optionalText(input.content, "content", maximumNodeTextCharacters);
      if (input.artifactKind !== undefined) node.artifactKind = readArtifactKind(input.artifactKind);
      node.updatedAt = new Date().toISOString();
      return graphActivity(toolName, input, true, { node });
    }
    return undefined;
  }

  private async addProviderNode(
    workspace: SynapseWorkspace,
    connectionId: string,
    position: SynapsePosition,
    overrides: { title?: string; instructions?: string },
  ): Promise<SynapseProviderNode> {
    const existing = workspace.nodes.find(
      (node): node is SynapseProviderNode => node.kind === "provider" && node.connectionId === connectionId,
    );
    if (existing) {
      if (overrides.instructions) existing.instructions = overrides.instructions;
      return existing;
    }
    const connection = (await this.options.connections.listConnections()).find(
      (candidate) => candidate.id === connectionId,
    );
    if (!connection) {
      throw new SynapseError("synapse_connection_not_found", `Connected provider not found: ${connectionId}.`, 404);
    }
    const now = new Date().toISOString();
    const providerName =
      this.options.catalog.providers.find((provider) => provider.service === connection.service)?.displayName ??
      connection.service;
    const node: SynapseProviderNode = {
      id: crypto.randomUUID(),
      kind: "provider",
      connectionId,
      service: connection.service,
      title: overrides.title ?? providerName,
      instructions: overrides.instructions,
      position,
      createdAt: now,
      updatedAt: now,
    };
    workspace.nodes.push(node);
    return node;
  }

  private addArtifactNode(
    workspace: SynapseWorkspace,
    position: SynapsePosition,
    input: ArtifactInput,
  ): SynapseArtifactNode {
    const now = new Date().toISOString();
    const node: SynapseArtifactNode = {
      id: crypto.randomUUID(),
      kind: "artifact",
      artifactKind: input.artifactKind,
      title: input.title,
      summary: input.summary,
      content: input.content,
      externalUrl: input.externalUrl,
      sourceActionId: input.sourceActionId,
      sourceConnectionId: input.sourceConnectionId,
      sourceActivityId: input.sourceActivityId,
      data: input.data,
      position,
      createdAt: now,
      updatedAt: now,
    };
    workspace.nodes.push(node);
    return node;
  }

  private connectNodes(
    workspace: SynapseWorkspace,
    sourceNodeId: string,
    targetNodeId: string,
    label?: string,
  ): SynapseEdge {
    requiredNode(workspace, sourceNodeId);
    requiredNode(workspace, targetNodeId);
    if (sourceNodeId === targetNodeId) {
      throw new SynapseError("invalid_synapse_edge", "A node cannot connect to itself.");
    }
    const existing = workspace.edges.find(
      (edge) => edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetNodeId,
    );
    if (existing) return existing;
    const edge: SynapseEdge = {
      id: crypto.randomUUID(),
      sourceNodeId,
      targetNodeId,
      label,
      createdAt: new Date().toISOString(),
    };
    workspace.edges.push(edge);
    return edge;
  }

  private async applyAgentResponse(
    workspace: SynapseWorkspace,
    selectedNode: SynapseNode,
    thread: SynapseThread,
    response: AgentChatResponse,
    replaceMessageId?: string,
  ): Promise<void> {
    const message: SynapseMessage = { ...response.message, toolActivity: response.toolActivity };
    if (replaceMessageId) {
      const index = thread.messages.findIndex((candidate) => candidate.id === replaceMessageId);
      if (index >= 0) thread.messages[index] = message;
      else thread.messages.push(message);
    } else {
      thread.messages.push(message);
    }
    thread.messages = thread.messages.slice(-maximumThreadMessages);
    thread.pendingApprovalId = response.status === "waiting_for_approval" ? response.approvalId : undefined;
    thread.pendingMessageId = response.status === "waiting_for_approval" ? response.message.id : undefined;
    thread.updatedAt = response.message.createdAt;
    await this.materializeConnectorResults(workspace, selectedNode, response.toolActivity);
  }

  private async materializeConnectorResults(
    workspace: SynapseWorkspace,
    selectedNode: SynapseNode,
    activities: AgentChatToolActivity[],
  ): Promise<void> {
    for (const activity of activities) {
      if (
        activity.type !== "action" ||
        !activity.ok ||
        !activity.actionId ||
        activity.actionId.startsWith("synapse_") ||
        !activity.connectionId ||
        workspace.nodes.some((node) => node.kind === "artifact" && node.sourceActivityId === activity.id)
      ) {
        continue;
      }
      let connection = workspace.nodes.find(
        (node): node is SynapseProviderNode => node.kind === "provider" && node.connectionId === activity.connectionId,
      );
      if (!connection) {
        connection = await this.addProviderNode(
          workspace,
          activity.connectionId,
          nextFanPosition(workspace, selectedNode, "provider"),
          {},
        );
        if (connection.id !== selectedNode.id) this.connectNodes(workspace, selectedNode.id, connection.id);
      }
      const parent = connection;
      const candidates = artifactCandidates(activity.output, activity.actionId).slice(0, maximumProjectedArtifacts);
      for (const candidate of candidates) {
        const node = this.addArtifactNode(workspace, nextFanPosition(workspace, parent, "artifact"), {
          ...candidate,
          sourceActionId: activity.actionId,
          sourceConnectionId: activity.connectionId,
          sourceActivityId: activity.id,
        });
        this.connectNodes(workspace, parent.id, node.id);
      }
    }
  }

  private async requiredWorkspace(id: string): Promise<SynapseWorkspace> {
    const workspace = await this.options.store.getWorkspace(id);
    if (!workspace) throw new SynapseError("synapse_not_found", `Synapse workspace not found: ${id}.`, 404);
    return workspace;
  }

  private async save(workspace: SynapseWorkspace): Promise<SynapseWorkspace> {
    workspace.updatedAt = new Date().toISOString();
    await this.options.store.setWorkspace(workspace);
    return workspace;
  }
}

export class SynapseError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409;

  constructor(code: string, message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface ArtifactInput {
  artifactKind: SynapseArtifactKind;
  title: string;
  summary?: string;
  content?: string;
  externalUrl?: string;
  sourceActionId?: string;
  sourceConnectionId?: string;
  sourceActivityId?: string;
  data?: unknown;
}

const synapseTools: AgentChatExtensionTool[] = [
  {
    name: "synapse_add_provider",
    description:
      "Add a connected provider to the Synapse and link it from the current context node. Use this when a request needs a provider that is not already represented nearby.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        parentNodeId: { type: "string" },
        title: { type: "string" },
        instructions: { type: "string", description: "Short pre-prompt describing the provider node's job." },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "synapse_add_artifacts",
    description:
      "Create one or more durable Markdown artifact cards and fan them out from a parent node. Prefer one focused card per useful email, search result, document, task, or draft.",
    inputSchema: {
      type: "object",
      properties: {
        parentNodeId: { type: "string" },
        sourceActivityId: {
          type: "string",
          description: "Tool activity id that produced these results, when applicable.",
        },
        artifacts: {
          type: "array",
          minItems: 1,
          maxItems: maximumArtifactsPerTool,
          items: {
            type: "object",
            properties: {
              artifactKind: {
                type: "string",
                enum: ["email", "draft", "document", "search_result", "note", "task", "generic"],
              },
              title: { type: "string" },
              summary: { type: "string" },
              content: {
                type: "string",
                description: "The exact Markdown body rendered on the artifact card.",
              },
              externalUrl: { type: "string" },
            },
            required: ["artifactKind", "title", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["artifacts"],
      additionalProperties: false,
    },
  },
  {
    name: "synapse_connect_nodes",
    description: "Connect two existing Synapse nodes when their relationship is important to the user's investigation.",
    inputSchema: {
      type: "object",
      properties: {
        sourceNodeId: { type: "string" },
        targetNodeId: { type: "string" },
        label: { type: "string" },
      },
      required: ["sourceNodeId", "targetNodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "synapse_update_artifact",
    description:
      "Rewrite an existing artifact card, especially a draft, after discussing changes with the user. Omit nodeId to update the selected artifact.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        artifactKind: {
          type: "string",
          enum: ["email", "draft", "document", "search_result", "note", "task", "generic"],
        },
        title: { type: "string" },
        summary: { type: "string" },
        content: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

function synapseSystemPrompt(selectedNode: SynapseNode): string {
  return `You are working inside Synapse, a visual research and action canvas. The selected node is ${selectedNode.id} (${selectedNode.title}).

Rules:
- use the selected node and its connected component as your factual canvas context; do not assume unrelated canvas nodes
- use connector tools whenever current external data or a side effect is needed
- add a provider node with synapse_add_provider when you use a connection that is not already represented in the visible context
- after retrieving useful results, call synapse_add_artifacts and create one concise artifact per useful result; fan-outs are preferred over burying results in chat
- put the exact Markdown that should be visible on every new artifact card in its content field; use headings, lists, links, and emphasis when they make the result easier to scan
- include sourceActivityId from connector tool activity when turning that result into artifacts
- create draft artifacts for proposed messages or documents before sending when the user is still reviewing them
- update the selected draft or artifact in place with synapse_update_artifact when the user requests revisions
- connect nodes whose relationship helps explain the work
- keep chat concise because durable detail belongs in artifact cards
- never claim a graph mutation or connector side effect succeeded unless its host tool succeeded`;
}

function createGraphContext(workspace: SynapseWorkspace, selectedNodeId: string): Record<string, unknown> {
  const nodeIds = connectedNodeIds(workspace, selectedNodeId);
  const nodes = workspace.nodes.filter((node) => nodeIds.has(node.id)).slice(0, maximumContextNodes);
  const includedIds = new Set(nodes.map((node) => node.id));
  return {
    workspace: { id: workspace.id, name: workspace.name },
    selectedNodeId,
    nodes: nodes.map((node) => ({
      ...node,
      ...(node.kind === "artifact"
        ? {
            summary: truncate(node.summary, 4_000),
            content: truncate(node.content, 8_000),
            data: boundedData(node.data, 2_000),
          }
        : {}),
    })),
    edges: workspace.edges.filter((edge) => includedIds.has(edge.sourceNodeId) && includedIds.has(edge.targetNodeId)),
  };
}

function connectedNodeIds(workspace: SynapseWorkspace, selectedNodeId: string): Set<string> {
  const visited = new Set([selectedNodeId]);
  const queue = [selectedNodeId];
  while (queue.length > 0 && visited.size < maximumContextNodes) {
    const current = queue.shift()!;
    for (const edge of workspace.edges) {
      const adjacent =
        edge.sourceNodeId === current
          ? edge.targetNodeId
          : edge.targetNodeId === current
            ? edge.sourceNodeId
            : undefined;
      if (adjacent && !visited.has(adjacent)) {
        visited.add(adjacent);
        queue.push(adjacent);
      }
    }
  }
  return visited;
}

function artifactCandidates(output: unknown, actionId: string): ArtifactInput[] {
  const outputRecord = isRecord(output) ? output : undefined;
  const collection = ["items", "results", "value", "messages", "files", "records"]
    .map((field) => outputRecord?.[field])
    .find(Array.isArray);
  const values = collection ?? (output === undefined ? [] : [output]);
  return values.map((value, index) => artifactFromValue(value, actionId, index));
}

function artifactFromValue(value: unknown, actionId: string, index: number): ArtifactInput {
  const item = isRecord(value) ? value : undefined;
  const title = firstText(item, ["subject", "title", "name", "displayName", "fileName", "path"]);
  const summary = firstText(item, ["bodyPreview", "snippet", "description", "summary", "preview"]);
  const content = firstText(item, ["content", "body", "text"]);
  const externalUrl = firstHttpsUrl(item, ["webLink", "webUrl", "url", "link"]);
  return {
    artifactKind: inferArtifactKind(actionId),
    title: title ?? `${humanize(actionId)} result ${index + 1}`,
    summary: truncate(summary, 4_000),
    content: artifactMarkdown(value, summary, content, externalUrl),
    externalUrl,
    data: boundedData(value),
  };
}

function artifactMarkdown(
  value: unknown,
  summary: string | undefined,
  content: string | undefined,
  externalUrl: string | undefined,
): string {
  const markdownContent = content && !/<[a-z][\s\S]*>/i.test(content) ? content : undefined;
  const body = truncate(markdownContent ?? summary, maximumNodeTextCharacters);
  const sourceLink = externalUrl ? `[Open source](${externalUrl})` : undefined;
  if (body || sourceLink) return [body, sourceLink].filter(Boolean).join("\n\n");
  const serialized = JSON.stringify(boundedData(value), null, 2);
  return `\`\`\`json\n${serialized ?? "{}"}\n\`\`\``;
}

function inferArtifactKind(actionId: string): SynapseArtifactKind {
  const normalized = actionId.toLowerCase();
  if (normalized.includes("draft")) return "draft";
  if (normalized.includes("email") || normalized.includes("message") || normalized.startsWith("outlook."))
    return "email";
  if (normalized.includes("search") || normalized.includes("brave")) return "search_result";
  if (normalized.includes("task") || normalized.includes("work_item")) return "task";
  if (normalized.includes("file") || normalized.includes("document") || normalized.includes("note")) return "document";
  return "generic";
}

function nextFanPosition(
  workspace: SynapseWorkspace,
  parent: SynapseNode,
  nodeKind: SynapseNode["kind"],
): SynapsePosition {
  const siblings = workspace.edges
    .filter((edge) => edge.sourceNodeId === parent.id)
    .map((edge) => workspace.nodes.find((node) => node.id === edge.targetNodeId))
    .filter((node): node is SynapseNode => Boolean(node));
  const lane = siblings.length % 5;
  const column = Math.floor(siblings.length / 5);
  const verticalOffset = lane === 0 ? 0 : Math.ceil(lane / 2) * (lane % 2 === 1 ? 1 : -1);
  const preferred = {
    x: parent.position.x + (column + 1) * (canvasNodeWidth + nodeHorizontalGap),
    y: parent.position.y + verticalOffset * (artifactNodeHeight + nodeVerticalGap),
  };
  return findOpenPosition(workspace, preferred, nodeKind);
}

function findOpenPosition(
  workspace: SynapseWorkspace,
  preferred: SynapsePosition,
  nodeKind: SynapseNode["kind"],
): SynapsePosition {
  if (positionIsOpen(workspace, preferred, nodeKind)) return preferred;
  const stepX = canvasNodeWidth + nodeHorizontalGap;
  const stepY = artifactNodeHeight + nodeVerticalGap;
  for (let radius = 1; radius <= workspace.nodes.length + 2; radius += 1) {
    for (const offset of placementOffsets(radius)) {
      const candidate = { x: preferred.x + offset.x * stepX, y: preferred.y + offset.y * stepY };
      if (positionIsOpen(workspace, candidate, nodeKind)) return candidate;
    }
  }
  return { x: preferred.x + (workspace.nodes.length + 3) * stepX, y: preferred.y };
}

function placementOffsets(radius: number): SynapsePosition[] {
  const offsets: SynapsePosition[] = [
    { x: 0, y: radius },
    { x: radius, y: 0 },
    { x: 0, y: -radius },
    { x: -radius, y: 0 },
  ];
  for (let step = 1; step <= radius; step += 1) {
    offsets.push(
      { x: radius, y: step },
      { x: radius, y: -step },
      { x: -radius, y: step },
      { x: -radius, y: -step },
      { x: step, y: radius },
      { x: -step, y: radius },
      { x: step, y: -radius },
      { x: -step, y: -radius },
    );
  }
  return offsets;
}

function positionIsOpen(
  workspace: SynapseWorkspace,
  position: SynapsePosition,
  nodeKind: SynapseNode["kind"],
): boolean {
  const height = nodeKind === "provider" ? providerNodeHeight : artifactNodeHeight;
  return workspace.nodes.every((node) => {
    const nodeHeight = node.kind === "provider" ? providerNodeHeight : artifactNodeHeight;
    return (
      position.x + canvasNodeWidth + nodeHorizontalGap <= node.position.x ||
      node.position.x + canvasNodeWidth + nodeHorizontalGap <= position.x ||
      position.y + height + nodeVerticalGap <= node.position.y ||
      node.position.y + nodeHeight + nodeVerticalGap <= position.y
    );
  });
}

function threadFor(workspace: SynapseWorkspace, nodeId: string): SynapseThread {
  const existing = workspace.threads.find((thread) => thread.nodeId === nodeId);
  if (existing) return existing;
  const thread: SynapseThread = { nodeId, messages: [], updatedAt: new Date().toISOString() };
  workspace.threads.push(thread);
  return thread;
}

function requiredNode(workspace: SynapseWorkspace, nodeId: string): SynapseNode {
  const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new SynapseError("synapse_node_not_found", `Synapse node not found: ${nodeId}.`, 404);
  return node;
}

function readArtifactInput(body: Record<string, unknown>): ArtifactInput {
  return {
    artifactKind: readArtifactKind(body.artifactKind),
    title: readText(body.title, "title", maximumNodeTitleCharacters),
    summary: optionalText(body.summary, "summary", maximumNodeTextCharacters),
    content: optionalText(body.content, "content", maximumNodeTextCharacters),
    externalUrl: optionalHttpsUrl(body.externalUrl, "externalUrl"),
    sourceActionId: optionalText(body.sourceActionId, "sourceActionId", 200),
    sourceConnectionId: optionalText(body.sourceConnectionId, "sourceConnectionId", 200),
    sourceActivityId: optionalText(body.sourceActivityId, "sourceActivityId", 200),
    data: body.data,
  };
}

function readArtifactKind(value: unknown): SynapseArtifactKind {
  if (
    value === "email" ||
    value === "draft" ||
    value === "document" ||
    value === "search_result" ||
    value === "note" ||
    value === "task" ||
    value === "generic"
  ) {
    return value;
  }
  throw new SynapseError("invalid_synapse_artifact", "artifactKind is invalid.");
}

function graphActivity(toolName: string, input: unknown, ok: boolean, output: unknown): AgentChatToolActivity {
  return {
    id: crypto.randomUUID(),
    type: "action",
    label: humanize(toolName),
    ok,
    actionId: toolName,
    input: boundedData(input),
    output: boundedData(output),
  };
}

function readPosition(value: unknown): SynapsePosition {
  const position = readObject(value, "position");
  const x = finiteNumber(position.x, "position.x");
  const y = finiteNumber(position.y, "position.y");
  return { x, y };
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SynapseError("invalid_synapse_position", `${field} must be a finite number.`);
  }
  return Math.round(value);
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SynapseError("invalid_synapse", `${label} must be an object.`);
  return value;
}

function readText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SynapseError("invalid_synapse", `${field} is required.`);
  }
  const text = value.trim();
  if (text.length > maximum)
    throw new SynapseError("invalid_synapse", `${field} must not exceed ${maximum} characters.`);
  return text;
}

function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return readText(value, field, maximum);
}

function optionalHttpsUrl(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field, 4_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new SynapseError("invalid_synapse", `${field} must be an HTTPS URL.`);
  }
}

function firstText(value: Record<string, unknown> | undefined, fields: string[]): string | undefined {
  for (const field of fields) {
    const candidate = value?.[field];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (isRecord(candidate)) {
      const nested = firstText(candidate, ["content", "text", "name", "address"]);
      if (nested) return nested;
    }
  }
  return undefined;
}

function firstHttpsUrl(value: Record<string, unknown> | undefined, fields: string[]): string | undefined {
  for (const field of fields) {
    try {
      const candidate = value?.[field];
      if (typeof candidate === "string" && new URL(candidate).protocol === "https:") return candidate;
    } catch {
      // Continue to the next common URL field.
    }
  }
  return undefined;
}

function boundedData(value: unknown, maximumCharacters = 12_000): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= maximumCharacters
      ? value
      : { truncated: true, preview: serialized.slice(0, maximumCharacters) };
  } catch {
    return { unavailable: true };
  }
}

function boundedJson(value: unknown): string {
  return JSON.stringify(boundedData(value));
}

function truncate(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function humanize(value: string): string {
  const words = value.replace(/[._-]+/gu, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Activity";
}
