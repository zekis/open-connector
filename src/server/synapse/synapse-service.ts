import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { ActionPolicySnapshot } from "../../core/action-policy.ts";
import type { IActionRunner } from "../actions/action-runner.ts";
import type { AgentChatExtension, AgentChatExtensionTool, AgentChatService } from "../chat/agent-chat-service.ts";
import type { AgentChatResponse, AgentChatToolActivity } from "../chat/agent-chat-types.ts";
import type { ProviderPreviewContent, ProviderPreviewDescriptor } from "../previews/provider-preview.ts";
import type {
  ISynapseStore,
  SynapseArtifactKind,
  SynapseArtifactNode,
  SynapseEdge,
  SynapseMessage,
  SynapseNode,
  SynapsePosition,
  SynapseProviderNode,
  SynapseSize,
  SynapseThread,
  SynapseWorkspace,
  SynapseWorkspaceSummary,
} from "./synapse-types.ts";

import {
  createProviderPreviews,
  ProviderPreviewError,
  readProviderPreviewContent,
} from "../previews/provider-preview.ts";

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
const minimumNodeWidth = 220;
const maximumNodeWidth = 1_200;
const minimumNodeHeight = 100;
const maximumNodeHeight = 1_200;

export interface SynapseServiceOptions {
  catalog: CatalogStore;
  connections: Pick<ConnectionService, "listConnections">;
  agentChat: Pick<AgentChatService, "respondWithExtension" | "getApprovalResult">;
  actions?: Pick<IActionRunner, "run">;
  getPolicySnapshot?(): Promise<ActionPolicySnapshot>;
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
    return this.presentWorkspace(await this.requiredWorkspace(id));
  }

  async getPreview(workspaceId: string, nodeId: string, previewId: string): Promise<ProviderPreviewContent> {
    const workspace = await this.requiredWorkspace(workspaceId);
    const node = requiredNode(workspace, nodeId);
    if (node.kind !== "artifact") {
      throw new SynapseError("synapse_preview_not_found", "Only artifact nodes have previews.", 404);
    }
    const descriptor = previewDescriptors(workspace.id, node).find((candidate) => candidate.preview.id === previewId);
    if (!descriptor?.source) {
      throw new SynapseError("synapse_preview_not_found", "Synapse preview content is unavailable.", 404);
    }
    if (!this.options.actions) {
      throw new SynapseError("synapse_preview_unavailable", "Synapse preview content is unavailable.", 404);
    }
    const policy = await this.options.getPolicySnapshot?.();
    const result = await this.options.actions.run({
      actionId: descriptor.source.actionId,
      connectionId: descriptor.source.connectionId,
      input: descriptor.source.input,
      caller: "web",
      policy,
      approvalPolicy: "bypass",
    });
    if (!result?.result.ok) {
      throw new SynapseError(
        "synapse_preview_unavailable",
        result?.result.error?.message ?? "Synapse preview content could not be loaded.",
        503,
      );
    }
    try {
      return readProviderPreviewContent(descriptor, result.result.output);
    } catch (error) {
      if (error instanceof ProviderPreviewError) throw new SynapseError(error.code, error.message, error.status);
      throw error;
    }
  }

  async update(id: string, input: unknown): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(id);
    const body = readObject(input, "Synapse workspace");
    workspace.name = readText(body.name, "name", maximumWorkspaceNameCharacters);
    return await this.save(workspace);
  }

  async arrange(id: string): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(id);
    arrangeWorkspace(workspace);
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
    const requestedSize = body.size === undefined ? undefined : readSize(body.size);
    const parentNodeId = optionalText(body.parentNodeId, "parentNodeId", 200);
    let addedNode: SynapseNode;
    if (body.kind === "provider") {
      const title = optionalText(body.title, "title", maximumNodeTitleCharacters);
      const instructions = optionalText(body.instructions, "instructions", maximumNodeTextCharacters);
      const position = findOpenPosition(
        workspace,
        requestedPosition,
        "provider",
        requestedSize ?? automaticProviderSize(title, instructions),
      );
      addedNode = await this.addProviderNode(workspace, readText(body.connectionId, "connectionId", 200), position, {
        title,
        instructions,
        size: requestedSize,
      });
    } else if (body.kind === "artifact") {
      const artifact = readArtifactInput(body);
      const position = findOpenPosition(
        workspace,
        requestedPosition,
        "artifact",
        requestedSize ?? automaticArtifactSize(artifact),
      );
      addedNode = this.addArtifactNode(workspace, position, artifact, requestedSize);
    } else {
      throw new SynapseError("invalid_synapse_node", "kind must be provider or artifact.");
    }
    if (parentNodeId) this.connectNodes(workspace, parentNodeId, addedNode.id);
    return await this.save(workspace);
  }

  async updateNode(workspaceId: string, nodeId: string, input: unknown): Promise<SynapseWorkspace> {
    const workspace = await this.requiredWorkspace(workspaceId);
    const node = requiredNode(workspace, nodeId);
    const body = readObject(input, "Synapse node update");
    if (body.position !== undefined) node.position = readPosition(body.position);
    if (body.size !== undefined) {
      node.size = readSize(body.size);
      node.autoSize = body.autoSize === true;
    } else if (body.autoSize === true) {
      node.autoSize = true;
    } else if (body.autoSize === false) {
      node.autoSize = false;
    }
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
    if (node.autoSize !== false) {
      node.autoSize = true;
      node.size = automaticNodeSize(node);
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
    if (!thread.pendingApprovalId) return this.presentWorkspace(workspace);
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
    return this.presentWorkspace(workspace);
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
      const title = optionalText(input.title, "title", maximumNodeTitleCharacters);
      const instructions = optionalText(input.instructions, "instructions", maximumNodeTextCharacters);
      const node = await this.addProviderNode(
        workspace,
        connectionId,
        nextFanPosition(workspace, parent, "provider", automaticProviderSize(title, instructions)),
        { title, instructions },
      );
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
        const node = this.addArtifactNode(
          workspace,
          nextFanPosition(workspace, parent, "artifact", automaticArtifactSize(artifact)),
          { ...artifact, sourceActivityId },
        );
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
      if (node.autoSize !== false) {
        node.autoSize = true;
        node.size = automaticNodeSize(node);
      }
      node.updatedAt = new Date().toISOString();
      return graphActivity(toolName, input, true, { node });
    }
    return undefined;
  }

  private async addProviderNode(
    workspace: SynapseWorkspace,
    connectionId: string,
    position: SynapsePosition,
    overrides: { title?: string; instructions?: string; size?: SynapseSize },
  ): Promise<SynapseProviderNode> {
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
      size: overrides.size ?? automaticProviderSize(overrides.title ?? providerName, overrides.instructions),
      autoSize: overrides.size === undefined,
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
    size?: SynapseSize,
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
      sourceInput: input.sourceInput,
      itemIdentity: input.itemIdentity,
      data: input.data,
      position,
      size: size ?? automaticArtifactSize(input),
      autoSize: size === undefined,
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
      let connection = providerNodeForBranch(workspace, selectedNode, activity.connectionId);
      if (!connection) {
        connection = await this.addProviderNode(
          workspace,
          activity.connectionId,
          nextFanPosition(workspace, selectedNode, "provider", automaticProviderSize(undefined, undefined)),
          {},
        );
        if (connection.id !== selectedNode.id) this.connectNodes(workspace, selectedNode.id, connection.id);
      }
      const parent = connection;
      const boundedSourceInput = boundedData(activity.input, 4_000);
      const sourceInput = isRecord(boundedSourceInput) ? boundedSourceInput : undefined;
      const candidates = artifactCandidates(
        activity.output,
        activity.actionId,
        activity.connectionId,
        sourceInput,
      ).slice(0, maximumProjectedArtifacts);
      for (const candidate of candidates) {
        const artifact: ArtifactInput = {
          ...candidate,
          sourceActionId: activity.actionId,
          sourceConnectionId: activity.connectionId,
          sourceActivityId: activity.id,
          sourceInput,
        };
        const existing = artifact.itemIdentity
          ? workspace.nodes.find(
              (node): node is SynapseArtifactNode =>
                node.kind === "artifact" && artifactIdentity(node) === artifact.itemIdentity,
            )
          : undefined;
        const node =
          existing ??
          this.addArtifactNode(
            workspace,
            nextFanPosition(workspace, parent, "artifact", automaticArtifactSize(artifact)),
            artifact,
          );
        if (existing) {
          existing.itemIdentity ??= artifact.itemIdentity;
          existing.sourceActionId = artifact.sourceActionId;
          existing.sourceConnectionId = artifact.sourceConnectionId;
          existing.sourceActivityId = artifact.sourceActivityId;
          existing.sourceInput = artifact.sourceInput;
          existing.data = artifact.data;
          existing.externalUrl ??= artifact.externalUrl;
          existing.updatedAt = new Date().toISOString();
        }
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
    return this.presentWorkspace(workspace);
  }

  private presentWorkspace(workspace: SynapseWorkspace): SynapseWorkspace {
    return {
      ...workspace,
      nodes: workspace.nodes.map((node) =>
        node.kind === "artifact"
          ? {
              ...node,
              size: node.autoSize === false && node.size ? node.size : automaticNodeSize(node),
              previews: previewDescriptors(workspace.id, node).map((descriptor) => descriptor.preview),
            }
          : { ...node, size: node.autoSize === false && node.size ? node.size : automaticNodeSize(node) },
      ),
    };
  }
}

export class SynapseError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409 | 413 | 503;

  constructor(code: string, message: string, status: 400 | 404 | 409 | 413 | 503 = 400) {
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
  sourceInput?: Record<string, unknown>;
  itemIdentity?: string;
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
- retrieve attachment metadata for useful emails that report attachments so the canvas can render those files
- put the exact Markdown that should be visible on every new artifact card in its content field; use headings, lists, links, and emphasis when they make the result easier to scan
- include sourceActivityId from connector tool activity when turning that result into artifacts
- create draft artifacts for proposed messages or documents before sending when the user is still reviewing them
- update the selected draft or artifact in place with synapse_update_artifact when the user requests revisions
- connect nodes whose relationship helps explain the work
- keep chat concise because durable detail belongs in artifact cards
- never claim a graph mutation or connector side effect succeeded unless its host tool succeeded`;
}

function createGraphContext(workspace: SynapseWorkspace, selectedNodeId: string): Record<string, unknown> {
  const nodesById = new Map(workspace.nodes.map((node) => [node.id, node]));
  const rankedNodes = connectedNodesByDistance(workspace, selectedNodeId)
    .map(({ nodeId, distance }) => ({ node: nodesById.get(nodeId), distance }))
    .filter((entry): entry is { node: SynapseNode; distance: number } => entry.node !== undefined);
  const includedIds = new Set(rankedNodes.map(({ node }) => node.id));
  return {
    workspace: { id: workspace.id, name: workspace.name },
    selectedNodeId,
    nodes: rankedNodes.map(({ node, distance }) => ({
      ...node,
      graphDistance: distance,
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

function connectedNodesByDistance(
  workspace: SynapseWorkspace,
  selectedNodeId: string,
): Array<{ nodeId: string; distance: number }> {
  const adjacency = new Map<string, string[]>();
  for (const edge of workspace.edges) {
    adjacency.set(edge.sourceNodeId, [...(adjacency.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
    adjacency.set(edge.targetNodeId, [...(adjacency.get(edge.targetNodeId) ?? []), edge.sourceNodeId]);
  }
  const visited = new Set([selectedNodeId]);
  const ordered = [{ nodeId: selectedNodeId, distance: 0 }];
  const queue = [...ordered];
  while (queue.length > 0 && visited.size < maximumContextNodes) {
    const current = queue.shift()!;
    for (const adjacent of adjacency.get(current.nodeId) ?? []) {
      if (!visited.has(adjacent)) {
        visited.add(adjacent);
        const entry = { nodeId: adjacent, distance: current.distance + 1 };
        ordered.push(entry);
        queue.push(entry);
        if (visited.size >= maximumContextNodes) break;
      }
    }
  }
  return ordered;
}

function providerNodeForBranch(
  workspace: SynapseWorkspace,
  selectedNode: SynapseNode,
  connectionId: string,
): SynapseProviderNode | undefined {
  const nodesById = new Map(workspace.nodes.map((node) => [node.id, node]));
  for (const { nodeId } of connectedNodesByDistance(workspace, selectedNode.id)) {
    const node = nodesById.get(nodeId);
    if (node?.kind === "provider" && node.connectionId === connectionId) return node;
  }
  return undefined;
}

function previewDescriptors(workspaceId: string, node: SynapseArtifactNode): ProviderPreviewDescriptor[] {
  return createProviderPreviews({
    service: node.sourceActionId?.split(".")[0],
    connectionId: node.sourceConnectionId,
    actionId: node.sourceActionId,
    sourceInput: node.sourceInput,
    item: isRecord(node.data) ? node.data : {},
    title: node.title,
    summary: node.summary,
    externalUrl: node.externalUrl,
    contentUrl: (previewId) =>
      `/api/synapses/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(node.id)}/previews/${encodeURIComponent(previewId)}`,
  });
}

function artifactCandidates(
  output: unknown,
  actionId: string,
  connectionId: string,
  sourceInput: Record<string, unknown> | undefined,
): ArtifactInput[] {
  const outputRecord = isRecord(output) ? output : undefined;
  const collection = ["items", "results", "value", "messages", "files", "records", "attachments"]
    .map((field) => outputRecord?.[field])
    .find(Array.isArray);
  const values = collection ?? (output === undefined ? [] : [output]);
  return values.map((value, index) => artifactFromValue(value, actionId, connectionId, sourceInput, index));
}

function artifactFromValue(
  value: unknown,
  actionId: string,
  connectionId: string,
  sourceInput: Record<string, unknown> | undefined,
  index: number,
): ArtifactInput {
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
    itemIdentity: providerItemIdentity(item, actionId, connectionId, sourceInput),
    data: boundedData(value),
  };
}

function providerItemIdentity(
  item: Record<string, unknown> | undefined,
  actionId: string,
  connectionId: string,
  sourceInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!item) return undefined;
  const service = actionId.split(".")[0] ?? actionId;
  const resource = actionId
    .split(".")
    .at(-1)!
    .replace(/^(?:list|get|search|download|create|update|read)_/u, "")
    .replace(/ies$/u, "y")
    .replace(/s$/u, "");
  const explicit = firstText(item, [
    "id",
    "messageId",
    "itemId",
    "invoiceId",
    "contactId",
    "workItemId",
    "projectId",
    "eventId",
    "taskId",
    "uid",
  ]);
  const messageId = actionId.includes("attachment") ? firstText(sourceInput, ["messageId"]) : undefined;
  const path = firstText(item, ["pathLower", "pathDisplay", "path"]);
  const externalUrl = firstHttpsUrl(item, ["webUrl", "webLink", "url", "link"]);
  const stableValue = explicit
    ? `${messageId ? `${messageId}:` : ""}${explicit}`
    : path
      ? path.toLowerCase()
      : normalizedIdentityUrl(externalUrl);
  return stableValue ? `${connectionId}:${service}:${resource}:${stableValue}` : undefined;
}

function artifactIdentity(node: SynapseArtifactNode): string | undefined {
  if (node.itemIdentity) return node.itemIdentity;
  if (!node.sourceActionId || !node.sourceConnectionId) return undefined;
  return providerItemIdentity(
    isRecord(node.data) ? node.data : undefined,
    node.sourceActionId,
    node.sourceConnectionId,
    node.sourceInput,
  );
}

function normalizedIdentityUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  url.hash = "";
  return url.toString();
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

function automaticNodeSize(node: SynapseNode): SynapseSize {
  return node.kind === "provider"
    ? automaticProviderSize(node.title, node.instructions)
    : automaticArtifactSize({
        title: node.title,
        summary: node.summary,
        content: node.content,
      });
}

function automaticProviderSize(title: string | undefined, instructions: string | undefined): SynapseSize {
  return automaticTextSize([title, instructions].filter(Boolean).join("\n"), "provider");
}

function automaticArtifactSize(input: Pick<ArtifactInput, "title" | "summary" | "content">): SynapseSize {
  return automaticTextSize([input.title, input.summary, input.content].filter(Boolean).join("\n"), "artifact");
}

function automaticTextSize(text: string, kind: SynapseNode["kind"]): SynapseSize {
  const lines = text.split(/\r?\n/u);
  const longestLine = Math.max(0, ...lines.map((line) => line.length));
  const width = clampNumber(320 + Math.max(0, longestLine - 48) * 3, 320, kind === "provider" ? 480 : 560);
  const charactersPerLine = Math.max(28, Math.floor((width - 42) / 6.6));
  const visualLines = Math.max(
    1,
    lines.reduce((total, line) => total + Math.max(1, Math.ceil(Math.max(1, line.length) / charactersPerLine)), 0),
  );
  const baseHeight = kind === "provider" ? 82 : 92;
  const minimumHeight = kind === "provider" ? providerNodeHeight : artifactNodeHeight;
  return {
    width: Math.round(width),
    height: Math.round(clampNumber(baseHeight + visualLines * 17, minimumHeight, maximumNodeHeight)),
  };
}

function arrangeWorkspace(workspace: SynapseWorkspace): void {
  const nodesById = new Map(workspace.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(workspace.nodes.map((node) => [node.id, 0]));
  for (const edge of workspace.edges) {
    if (!nodesById.has(edge.sourceNodeId) || !nodesById.has(edge.targetNodeId)) continue;
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
  }

  const layerByNodeId = new Map<string, number>();
  const remainingIndegree = new Map(indegree);
  const queue = workspace.nodes.filter((node) => remainingIndegree.get(node.id) === 0).map((node) => node.id);
  for (const nodeId of queue) layerByNodeId.set(nodeId, 0);
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const nextLayer = (layerByNodeId.get(nodeId) ?? 0) + 1;
    for (const targetId of outgoing.get(nodeId) ?? []) {
      layerByNodeId.set(targetId, Math.max(layerByNodeId.get(targetId) ?? 0, nextLayer));
      const nextIndegree = (remainingIndegree.get(targetId) ?? 1) - 1;
      remainingIndegree.set(targetId, nextIndegree);
      if (nextIndegree === 0) queue.push(targetId);
    }
  }

  let fallbackLayer = Math.max(0, ...layerByNodeId.values());
  for (const node of workspace.nodes) {
    if (!layerByNodeId.has(node.id)) layerByNodeId.set(node.id, fallbackLayer++);
    node.size = automaticNodeSize(node);
    node.autoSize = true;
    node.updatedAt = new Date().toISOString();
  }

  const layers = new Map<number, SynapseNode[]>();
  for (const node of workspace.nodes) {
    const layer = layerByNodeId.get(node.id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }
  const orderedLayers = [...layers.entries()].sort(([left], [right]) => left - right);
  const totalHeights = new Map(
    orderedLayers.map(([layer, nodes]) => [
      layer,
      nodes.reduce((height, node) => height + sizeForNode(node).height, 0) + Math.max(0, nodes.length - 1) * 48,
    ]),
  );
  const maximumLayerHeight = Math.max(0, ...totalHeights.values());
  let x = 80;
  for (const [layer, nodes] of orderedLayers) {
    let y = 80 + (maximumLayerHeight - (totalHeights.get(layer) ?? 0)) / 2;
    let maximumLayerWidth = 0;
    for (const node of nodes) {
      const size = sizeForNode(node);
      node.position = { x: Math.round(x), y: Math.round(y) };
      y += size.height + 48;
      maximumLayerWidth = Math.max(maximumLayerWidth, size.width);
    }
    x += maximumLayerWidth + 96;
  }
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function nextFanPosition(
  workspace: SynapseWorkspace,
  parent: SynapseNode,
  nodeKind: SynapseNode["kind"],
  requestedSize?: SynapseSize,
): SynapsePosition {
  const siblings = workspace.edges
    .filter((edge) => edge.sourceNodeId === parent.id)
    .map((edge) => workspace.nodes.find((node) => node.id === edge.targetNodeId))
    .filter((node): node is SynapseNode => Boolean(node));
  const lane = siblings.length % 5;
  const column = Math.floor(siblings.length / 5);
  const verticalOffset = lane === 0 ? 0 : Math.ceil(lane / 2) * (lane % 2 === 1 ? 1 : -1);
  const parentSize = sizeForNode(parent);
  const newSize = requestedSize ?? defaultSizeForKind(nodeKind);
  const preferred = {
    x: parent.position.x + parentSize.width + nodeHorizontalGap + column * (newSize.width + nodeHorizontalGap),
    y: parent.position.y + verticalOffset * (newSize.height + nodeVerticalGap),
  };
  return findOpenPosition(workspace, preferred, nodeKind, newSize);
}

function findOpenPosition(
  workspace: SynapseWorkspace,
  preferred: SynapsePosition,
  nodeKind: SynapseNode["kind"],
  requestedSize?: SynapseSize,
): SynapsePosition {
  const size = requestedSize ?? defaultSizeForKind(nodeKind);
  if (positionIsOpen(workspace, preferred, size)) return preferred;
  const stepX = size.width + nodeHorizontalGap;
  const stepY = size.height + nodeVerticalGap;
  for (let radius = 1; radius <= workspace.nodes.length + 2; radius += 1) {
    for (const offset of placementOffsets(radius)) {
      const candidate = { x: preferred.x + offset.x * stepX, y: preferred.y + offset.y * stepY };
      if (positionIsOpen(workspace, candidate, size)) return candidate;
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

function positionIsOpen(workspace: SynapseWorkspace, position: SynapsePosition, size: SynapseSize): boolean {
  return workspace.nodes.every((node) => {
    const nodeSize = sizeForNode(node);
    return (
      position.x + size.width + nodeHorizontalGap <= node.position.x ||
      node.position.x + nodeSize.width + nodeHorizontalGap <= position.x ||
      position.y + size.height + nodeVerticalGap <= node.position.y ||
      node.position.y + nodeSize.height + nodeVerticalGap <= position.y
    );
  });
}

function sizeForNode(node: SynapseNode): SynapseSize {
  return node.autoSize === false && node.size ? node.size : automaticNodeSize(node);
}

function defaultSizeForKind(kind: SynapseNode["kind"]): SynapseSize {
  return {
    width: canvasNodeWidth,
    height: kind === "provider" ? providerNodeHeight : artifactNodeHeight,
  };
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
    sourceInput: body.sourceInput === undefined ? undefined : readObject(body.sourceInput, "sourceInput"),
    itemIdentity: optionalText(body.itemIdentity, "itemIdentity", 1_000),
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

function readSize(value: unknown): SynapseSize {
  const size = readObject(value, "size");
  const width = finiteNumber(size.width, "size.width");
  const height = finiteNumber(size.height, "size.height");
  if (width < minimumNodeWidth || width > maximumNodeWidth) {
    throw new SynapseError(
      "invalid_synapse_size",
      `size.width must be between ${minimumNodeWidth} and ${maximumNodeWidth}.`,
    );
  }
  if (height < minimumNodeHeight || height > maximumNodeHeight) {
    throw new SynapseError(
      "invalid_synapse_size",
      `size.height must be between ${minimumNodeHeight} and ${maximumNodeHeight}.`,
    );
  }
  return { width, height };
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
