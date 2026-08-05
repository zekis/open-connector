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
import { ConnectionApprovalService } from "./approvals/connection-approval-service.ts";
import { AgentChatService } from "./chat/agent-chat-service.ts";
import { ConnectServer } from "./connect-server.ts";
import { ClaudeCodeFlowAgent } from "./flows/claude-code-flow-agent.ts";
import { FlowRunner } from "./flows/flow-runner.ts";
import { FlowService } from "./flows/flow-service.ts";
import { FlowTriggerEngine } from "./flows/flow-trigger-engine.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";

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
}

export async function createConnectApp(options: ConnectAppOptions): Promise<ConnectApp> {
  const runtimeTokens = new RuntimeTokenService(options.runtimeDatabase.runtimeTokenStore, options.logger);
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
  const agentCredentials = new AgentCredentialService(options.runtimeDatabase.connectionStore, claudeCode);
  const agentSettings = new AgentSettingsService(options.runtimeDatabase.connectionStore, claudeCode);
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
  const flows = new FlowService({
    catalog: options.catalog,
    connections,
    agents: agentCredentials,
    agentSettings,
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
    claudeCodeAgent: new ClaudeCodeFlowAgent(agentCredentials, claudeCode),
    getPolicySnapshot,
    logger: options.logger,
  });
  const agentChat = new AgentChatService({
    catalog: options.catalog,
    connections,
    agents: agentCredentials,
    agentSettings,
    claudeCode,
    actions,
    getPolicySnapshot,
  });
  const flowTriggers = new FlowTriggerEngine({
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
      runtimePolicyStore: options.runtimeDatabase.runtimePolicyStore,
      registerStaticRoutes: options.registerStaticRoutes,
      auth: {
        adminToken: options.adminToken,
        runtimeToken: options.runtimeToken,
        hasRuntimeTokens: hasStoredRuntimeTokens,
        resolveRuntimeToken: (token) => runtimeTokens.resolveToken(token),
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
  };
}
