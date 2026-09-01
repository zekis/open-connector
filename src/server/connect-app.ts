import type { CatalogStore } from "../catalog-store.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { RuntimeJwtVerifier } from "./api/runtime-jwt.ts";
import type { ITransitFileService } from "./files/transit-file-store.ts";
import type { Logger } from "./logger.ts";
import type { ISecretCodec } from "./secrets/secret-codec-core.ts";
import type { RuntimeDatabase } from "./storage/runtime-database.ts";
import type { Hono } from "hono";

import { ConnectionService } from "../connection-service.ts";
import { ActionPolicyService, emptyPolicyRules } from "../core/action-policy.ts";
import { OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../oauth/oauth-credential-refresh-service.ts";
import { OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { AgentCredentialService } from "./agents/agent-credential-service.ts";
import { AgentSettingsService } from "./agents/agent-settings-service.ts";
import { ClaudeCodeClient } from "./agents/claude-code-client.ts";
import { CodexClient } from "./agents/codex-client.ts";
import { ConnectionApprovalService } from "./approvals/connection-approval-service.ts";
import { MobileAuthService } from "./auth/mobile-auth-service.ts";
import { AgentChatService } from "./chat/agent-chat-service.ts";
import { ConnectServer } from "./connect-server.ts";
import { FeedService } from "./feed/feed-service.ts";
import { ClaudeCodeFlowAgent } from "./flows/claude-code-flow-agent.ts";
import { CodexFlowAgent } from "./flows/codex-flow-agent.ts";
import { FlowRunner } from "./flows/flow-runner.ts";
import { FlowService } from "./flows/flow-service.ts";
import { FlowTriggerEngine } from "./flows/flow-trigger-engine.ts";
import { KanbanGenerator } from "./kanban/kanban-generator.ts";
import { KanbanService } from "./kanban/kanban-service.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";
import { SynapseService } from "./synapse/synapse-service.ts";
import { TeamsGatewayGraphClient } from "./teams-gateway/teams-gateway-graph.ts";
import { TeamsGatewayService } from "./teams-gateway/teams-gateway-service.ts";

export interface ConnectAppOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  runtimeDatabase: RuntimeDatabase;
  transitFiles: ITransitFileService;
  publicOrigin: string;
  secretCodec: ISecretCodec;
  adminToken?: string;
  runtimeToken?: string;
  verifyRuntimeJwt?: RuntimeJwtVerifier;
  actionPolicy?: ActionPolicyService;
  registerStaticRoutes?: (app: Hono) => void;
  logger?: Logger;
  computeRuntimeAuthConfigured?: boolean;
  compressApiResponses?: boolean;
}

export interface ConnectApp {
  app: Hono;
  runtimeAuthConfigured: boolean;
  flowTriggers: FlowTriggerEngine;
  teamsGateway: TeamsGatewayService;
}

export async function createConnectApp(options: ConnectAppOptions): Promise<ConnectApp> {
  const runtimeTokens = new RuntimeTokenService(options.runtimeDatabase.runtimeTokenStore, options.logger);
  const mobileAuth = new MobileAuthService(options.runtimeDatabase.mobileAuthStore, { logger: options.logger });
  const hasStoredRuntimeTokens = async (): Promise<boolean> => (await runtimeTokens.listTokens()).length > 0;
  const oauthClientConfigs = new OAuthClientConfigService({
    catalog: options.catalog,
    origin: options.publicOrigin,
    store: options.runtimeDatabase.oauthClientConfigStore,
  });
  const connections = new ConnectionService({
    catalog: options.catalog,
    oauthCredentials: new OAuthCredentialRefreshService(oauthClientConfigs),
    providerLoader: options.providerLoader,
    store: options.runtimeDatabase.connectionStore,
    logger: options.logger,
  });
  const claudeCode = new ClaudeCodeClient();
  const codex = new CodexClient();
  const agentCredentials = new AgentCredentialService(options.runtimeDatabase.connectionStore, claudeCode, codex);
  const agentSettings = new AgentSettingsService(options.runtimeDatabase.connectionStore, {
    claude_code: claudeCode,
    openai_codex: codex,
  });
  const actionPolicy = options.actionPolicy ?? new ActionPolicyService();
  const connectionApprovals = new ConnectionApprovalService({
    catalog: options.catalog,
    connections,
    store: options.runtimeDatabase.connectionApprovalStore,
  });
  const actions = new ActionRunner({
    catalog: options.catalog,
    providerLoader: options.providerLoader,
    connections,
    runs: options.runtimeDatabase.runLogStore,
    transitFiles: options.transitFiles,
    actionPolicy,
    approvals: connectionApprovals,
    logger: options.logger,
  });
  const getPolicySnapshot = async () => {
    const record = await options.runtimeDatabase.runtimePolicyStore.get();
    return actionPolicy.createSnapshot(record?.rules ?? emptyPolicyRules(), undefined, record?.updatedAt);
  };
  let synapse: SynapseService;
  const flowSynapses = {
    create: (input: unknown) => synapse.create(input),
    get: (id: string) => synapse.get(id),
    addNode: (workspaceId: string, input: unknown) => synapse.addNode(workspaceId, input),
  };
  const flows = new FlowService({
    catalog: options.catalog,
    connections,
    agents: agentCredentials,
    agentSettings,
    synapses: flowSynapses,
    store: options.runtimeDatabase.flowStore,
  });
  const flowRunner = new FlowRunner({
    catalog: options.catalog,
    connections,
    flows,
    store: options.runtimeDatabase.flowStore,
    actions,
    agentSettings,
    connectionApprovals,
    synapses: flowSynapses,
    claudeCodeAgent: new ClaudeCodeFlowAgent(agentCredentials, claudeCode),
    codexAgent: new CodexFlowAgent(agentCredentials, codex),
    getPolicySnapshot,
    logger: options.logger,
  });
  const agentChat = new AgentChatService({
    catalog: options.catalog,
    connections,
    agents: agentCredentials,
    agentSettings,
    claudeCode,
    codex,
    actions,
    flows,
    flowRuns: flowRunner,
    approvals: connectionApprovals,
    getPolicySnapshot,
  });
  const teamsGateway = new TeamsGatewayService({
    catalog: options.catalog,
    connections,
    agents: agentCredentials,
    agentChat,
    approvals: connectionApprovals,
    graph: new TeamsGatewayGraphClient(connections),
    store: options.runtimeDatabase.teamsGatewayStore,
    logger: options.logger,
  });
  const kanban = new KanbanService({
    catalog: options.catalog,
    connections,
    actions,
    approvals: connectionApprovals,
    store: options.runtimeDatabase.kanbanStore,
    generator: new KanbanGenerator({
      catalog: options.catalog,
      connections,
      agents: agentCredentials,
      agentChat,
    }),
    getPolicySnapshot,
  });
  const feed = new FeedService({
    flows: flowRunner,
    approvals: connectionApprovals,
    agentChat,
    actions,
    getPolicySnapshot,
    store: options.runtimeDatabase.feedStore,
  });
  synapse = new SynapseService({
    catalog: options.catalog,
    connections,
    agentChat,
    actions,
    getPolicySnapshot,
    store: options.runtimeDatabase.synapseStore,
  });
  const flowTriggers = new FlowTriggerEngine({
    catalog: options.catalog,
    flows,
    runner: flowRunner,
    store: options.runtimeDatabase.flowStore,
    connections,
    actions,
    getPolicySnapshot,
    logger: options.logger,
  });

  return {
    app: new ConnectServer({
      catalog: options.catalog,
      providerLoader: options.providerLoader,
      connections,
      agentCredentials,
      agentSettings,
      agentChat,
      feed,
      synapse,
      kanban,
      oauthClientConfigs,
      oauthFlow: new OAuthFlowService({
        clientConfigs: oauthClientConfigs,
        connections,
        states: options.runtimeDatabase.oauthStateStore,
      }),
      actions,
      flows,
      flowRunner,
      flowTriggers,
      connectionApprovals,
      idempotency: options.runtimeDatabase.idempotencyStore,
      transitFiles: options.transitFiles,
      runtimeTokens,
      mobileAuth,
      teamsGateway,
      runtimePolicyStore: options.runtimeDatabase.runtimePolicyStore,
      registerStaticRoutes: options.registerStaticRoutes,
      auth: {
        adminToken: options.adminToken,
        runtimeToken: options.runtimeToken,
        hasRuntimeTokens: hasStoredRuntimeTokens,
        resolveRuntimeToken: (token) => runtimeTokens.resolveToken(token),
        resolveMobileToken: (token) => mobileAuth.resolveDeviceToken(token),
        verifyRuntimeJwt: options.verifyRuntimeJwt,
      },
      actionPolicy,
      logger: options.logger,
      compressApiResponses: options.compressApiResponses,
    }).createApp(),
    runtimeAuthConfigured:
      Boolean(options.runtimeToken) ||
      Boolean(options.verifyRuntimeJwt) ||
      (options.computeRuntimeAuthConfigured === false ? false : await hasStoredRuntimeTokens()),
    flowTriggers,
    teamsGateway,
  };
}
