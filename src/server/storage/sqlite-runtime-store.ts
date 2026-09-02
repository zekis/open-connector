import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { TokenPolicy } from "../../core/action-policy.ts";
import type { ResolvedCredential, RuntimeLogger } from "../../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type {
  ActionApproval,
  ActionApprovalStatus,
  ConnectionActionPermission,
  IConnectionApprovalStore,
} from "../approvals/connection-approval-types.ts";
import type { IMobileAuthStore, MobileDeviceRecord, MobilePairingRecord } from "../auth/mobile-auth-service.ts";
import type { FeedThread, IFeedStore } from "../feed/feed-types.ts";
import type {
  FlowApproval,
  FlowApprovalStatus,
  FlowDefinition,
  FlowRun,
  FlowStep,
  FlowTriggerState,
  IFlowStore,
} from "../flows/flow-types.ts";
import type { IKanbanStore, KanbanBoardDefinition } from "../kanban/kanban-types.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type { ISynapseStore, SynapseWorkspace } from "../synapse/synapse-types.ts";
import type {
  ITeamsGatewayStore,
  TeamsGatewayAgent,
  TeamsGatewayContact,
  TeamsGatewayGroup,
  TeamsGatewaySubscription,
  TeamsGatewayThread,
} from "../teams-gateway/teams-gateway-types.ts";
import type {
  AbandonIdempotencyInput,
  CompleteIdempotencyInput,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IIdempotencyStore,
} from "./idempotency-store.ts";
import type { RuntimeDatabase } from "./runtime-database.ts";
import type { IRuntimePolicyStore, RuntimePolicyRecord } from "./runtime-policy-store.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage, RunLogWriteResult } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "./runtime-token-service.ts";

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseRuntimeActionHttpResult } from "../api/runtime-api.ts";
import { PlainTextSecretCodec } from "../secrets/secret-codec-core.ts";
import { DEFAULT_RUN_LIMIT, decodeRunLogCursor, encodeRunLogCursor } from "./runtime-store.ts";

type RuntimeRow = Record<string, unknown>;
type SecretJsonTable = "oauth_client_configs";
const migrationDirectory = new URL("../../../migrations/", import.meta.url);

export interface SqliteRuntimeDatabaseOptions {
  logger?: RuntimeLogger;
  runLimit?: number;
  secretCodec?: ISecretCodec;
}

interface SecretJsonInput {
  database: DatabaseSync;
  secretCodec: ISecretCodec;
  table: SecretJsonTable;
  service: string;
}

interface SetServiceJsonInput extends SecretJsonInput {
  value: unknown;
}

interface RotatedConnectionSecret {
  service: string;
  connectionName: string;
  value: string;
}

interface RotatedServiceSecret {
  service: string;
  value: string;
}

interface RotatedIdempotencySecret {
  keyHash: string;
  value: string;
}

interface RotatedIdSecret {
  id: string;
  value: string;
}

type IdSecretTable =
  | "flows"
  | "flow_runs"
  | "flow_steps"
  | "flow_approvals"
  | "flow_trigger_states"
  | "feed_threads"
  | "connection_action_permissions"
  | "action_approvals"
  | "synapse_workspaces"
  | "kanban_boards"
  | "teams_gateway_agents"
  | "teams_gateway_threads"
  | "teams_gateway_contacts"
  | "teams_gateway_groups"
  | "teams_gateway_subscriptions";

/**
 * Shared SQLite connection for local runtime state.
 */
export class SqliteRuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore: SqliteConnectionStore;
  readonly oauthClientConfigStore: SqliteOAuthClientConfigStore;
  readonly oauthStateStore: SqliteOAuthStateStore;
  readonly runtimeTokenStore: SqliteRuntimeTokenStore;
  readonly mobileAuthStore: SqliteMobileAuthStore;
  readonly runtimePolicyStore: SqliteRuntimePolicyStore;
  readonly runLogStore: SqliteRunLogStore;
  readonly idempotencyStore: SqliteIdempotencyStore;
  readonly flowStore: SqliteFlowStore;
  readonly feedStore: SqliteFeedStore;
  readonly connectionApprovalStore: SqliteConnectionApprovalStore;
  readonly synapseStore: SqliteSynapseStore;
  readonly kanbanStore: SqliteKanbanStore;
  readonly teamsGatewayStore: SqliteTeamsGatewayStore;

  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(filename: string, options: SqliteRuntimeDatabaseOptions = {}) {
    this.database = new DatabaseSync(filename);
    this.secretCodec = options.secretCodec ?? new PlainTextSecretCodec();
    this.initialize(options.logger);
    this.connectionStore = new SqliteConnectionStore(this.database, this.secretCodec);
    this.oauthClientConfigStore = new SqliteOAuthClientConfigStore(this.database, this.secretCodec);
    this.oauthStateStore = new SqliteOAuthStateStore(this.database);
    this.runtimeTokenStore = new SqliteRuntimeTokenStore(this.database);
    this.mobileAuthStore = new SqliteMobileAuthStore(this.database);
    this.runtimePolicyStore = new SqliteRuntimePolicyStore(this.database);
    this.runLogStore = new SqliteRunLogStore(this.database, options.runLimit ?? DEFAULT_RUN_LIMIT);
    this.idempotencyStore = new SqliteIdempotencyStore(this.database, this.secretCodec);
    this.flowStore = new SqliteFlowStore(this.database, this.secretCodec);
    this.feedStore = new SqliteFeedStore(this.database, this.secretCodec);
    this.connectionApprovalStore = new SqliteConnectionApprovalStore(this.database, this.secretCodec);
    this.synapseStore = new SqliteSynapseStore(this.database, this.secretCodec);
    this.kanbanStore = new SqliteKanbanStore(this.database, this.secretCodec);
    this.teamsGatewayStore = new SqliteTeamsGatewayStore(this.database, this.secretCodec);
  }

  close(): void {
    this.database.close();
  }

  async rotateSecretCodec(nextSecretCodec: ISecretCodec): Promise<void> {
    const connections = await readRotatedConnectionSecrets(this.database, this.secretCodec, nextSecretCodec);
    const oauthConfigs = await readRotatedServiceSecrets(
      this.database,
      this.secretCodec,
      nextSecretCodec,
      "oauth_client_configs",
    );
    const idempotencyResponses = await readRotatedIdempotencySecrets(this.database, this.secretCodec, nextSecretCodec);
    const flowRecords = await Promise.all(
      (
        [
          "flows",
          "flow_runs",
          "flow_steps",
          "flow_approvals",
          "flow_trigger_states",
          "feed_threads",
          "connection_action_permissions",
          "action_approvals",
          "synapse_workspaces",
          "kanban_boards",
          "teams_gateway_agents",
          "teams_gateway_threads",
          "teams_gateway_contacts",
          "teams_gateway_groups",
          "teams_gateway_subscriptions",
        ] as IdSecretTable[]
      ).map((table) => readRotatedIdSecrets(this.database, this.secretCodec, nextSecretCodec, table)),
    );
    runInTransaction(this.database, () => {
      writeRotatedConnectionSecrets(this.database, connections);
      writeRotatedServiceSecrets(this.database, "oauth_client_configs", oauthConfigs);
      writeRotatedIdempotencySecrets(this.database, idempotencyResponses);
      for (const [index, table] of (
        [
          "flows",
          "flow_runs",
          "flow_steps",
          "flow_approvals",
          "flow_trigger_states",
          "feed_threads",
          "connection_action_permissions",
          "action_approvals",
          "synapse_workspaces",
          "kanban_boards",
          "teams_gateway_agents",
          "teams_gateway_threads",
          "teams_gateway_contacts",
          "teams_gateway_groups",
          "teams_gateway_subscriptions",
        ] as IdSecretTable[]
      ).entries()) {
        writeRotatedIdSecrets(this.database, table, flowRecords[index]!);
      }
    });
  }

  resetRuntimeData(): void {
    this.database.exec(`
      delete from connections;
      delete from oauth_client_configs;
      delete from oauth_states;
      delete from runtime_tokens;
      delete from mobile_pairings;
      delete from mobile_devices;
      delete from runtime_policy;
      delete from runs;
      delete from idempotency_records;
      delete from action_approvals;
      delete from connection_action_permissions;
      delete from feed_threads;
      delete from synapse_workspaces;
      delete from kanban_boards;
      delete from teams_gateway_contacts;
      delete from teams_gateway_threads;
      delete from teams_gateway_groups;
      delete from teams_gateway_subscriptions;
      delete from teams_gateway_agents;
      delete from flow_trigger_states;
      delete from flow_approvals;
      delete from flow_steps;
      delete from flow_runs;
      delete from flows;
    `);
  }

  private initialize(logger?: RuntimeLogger): void {
    this.database.exec("pragma journal_mode = wal;");
    runSqliteMigrations(this.database, logger);
  }
}

export class SqliteMobileAuthStore implements IMobileAuthStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async addPairing(record: MobilePairingRecord): Promise<void> {
    this.database.prepare("delete from mobile_pairings where expires_at <= ?").run(record.createdAt);
    this.database
      .prepare(
        `
        insert into mobile_pairings (id, name, code_hash, created_at, expires_at)
        values (?, ?, ?, ?, ?)
      `,
      )
      .run(record.id, record.name, record.codeHash, record.createdAt, record.expiresAt);
  }

  async takePairing(codeHash: string, now: string): Promise<MobilePairingRecord | undefined> {
    const row = this.database
      .prepare(
        `
        delete from mobile_pairings
        where code_hash = ? and expires_at > ?
        returning id, name, code_hash, created_at, expires_at
      `,
      )
      .get(codeHash, now);
    return row ? readMobilePairingRow(row) : undefined;
  }

  async deletePairing(id: string): Promise<boolean> {
    return this.database.prepare("delete from mobile_pairings where id = ?").run(id).changes > 0;
  }

  async addDevice(record: MobileDeviceRecord): Promise<void> {
    this.database
      .prepare(
        `
        insert into mobile_devices (id, pairing_id, name, token_hash, user_agent, created_at, last_used_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.pairingId,
        record.name,
        record.tokenHash,
        record.userAgent ?? null,
        record.createdAt,
        record.lastUsedAt ?? null,
      );
  }

  async listDevices(): Promise<MobileDeviceRecord[]> {
    return this.database
      .prepare(
        `
        select id, pairing_id, name, token_hash, user_agent, created_at, last_used_at
        from mobile_devices
        order by created_at desc, id desc
      `,
      )
      .all()
      .map(readMobileDeviceRow);
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<MobileDeviceRecord | undefined> {
    const row = this.database
      .prepare(
        `
        select id, pairing_id, name, token_hash, user_agent, created_at, last_used_at
        from mobile_devices
        where token_hash = ?
      `,
      )
      .get(tokenHash);
    return row ? readMobileDeviceRow(row) : undefined;
  }

  async deleteDevice(id: string): Promise<boolean> {
    return this.database.prepare("delete from mobile_devices where id = ?").run(id).changes > 0;
  }

  async markDeviceUsed(id: string, usedAt: string): Promise<void> {
    this.database.prepare("update mobile_devices set last_used_at = ? where id = ?").run(usedAt, id);
  }
}

function readMobilePairingRow(row: unknown): MobilePairingRecord {
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    codeHash: readString(row, "code_hash"),
    createdAt: readString(row, "created_at"),
    expiresAt: readString(row, "expires_at"),
  };
}

function readMobileDeviceRow(row: unknown): MobileDeviceRecord {
  return {
    id: readString(row, "id"),
    pairingId: readString(row, "pairing_id"),
    name: readString(row, "name"),
    tokenHash: readString(row, "token_hash"),
    userAgent: readOptionalString(row, "user_agent"),
    createdAt: readString(row, "created_at"),
    lastUsedAt: readOptionalString(row, "last_used_at"),
  };
}

export class SqliteConnectionStore implements IConnectionStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const row = this.database
      .prepare("select id, revision, value from connections where service = ? and connection_name = ?")
      .get(service, connectionName);
    return row
      ? {
          id: readString(row, "id"),
          revision: readString(row, "revision"),
          service,
          connectionName,
          credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
        }
      : undefined;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const row = this.database
      .prepare(
        `
        insert into connections (id, revision, service, connection_name, value, updated_at)
        values (?, ?, ?, ?, ?, ?)
        on conflict(service, connection_name) do update set
          revision = excluded.revision,
          value = excluded.value,
          updated_at = excluded.updated_at
        returning id, revision
      `,
      )
      .get(
        crypto.randomUUID(),
        crypto.randomUUID(),
        service,
        connectionName,
        await this.secretCodec.encode(JSON.stringify(credential)),
        new Date().toISOString(),
      );
    return {
      id: readString(row, "id"),
      revision: readString(row, "revision"),
      service,
      connectionName,
      credential,
    };
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const row = this.database
      .prepare(
        `
        update connections
        set revision = ?, value = ?, updated_at = ?
        where service = ? and connection_name = ? and id = ? and revision = ?
        returning id
      `,
      )
      .get(
        crypto.randomUUID(),
        await this.secretCodec.encode(JSON.stringify(input.credential)),
        new Date().toISOString(),
        input.service,
        input.connectionName,
        input.id,
        input.revision,
      );
    return row !== undefined;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    this.database
      .prepare("delete from connections where service = ? and connection_name = ?")
      .run(service, connectionName);
  }

  async list(): Promise<StoredConnection[]> {
    const rows = this.database
      .prepare(
        "select id, revision, service, connection_name, value from connections order by service, connection_name",
      )
      .all();
    return await Promise.all(
      rows.map(async (row) => ({
        id: readString(row, "id"),
        revision: readString(row, "revision"),
        service: readString(row, "service"),
        connectionName: readString(row, "connection_name"),
        credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
      })),
    );
  }
}

export class SqliteOAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    return await getSecretJson<OAuthClientConfig>({
      database: this.database,
      secretCodec: this.secretCodec,
      table: "oauth_client_configs",
      service,
    });
  }

  async set(config: OAuthClientConfig): Promise<void> {
    await setServiceJson({
      database: this.database,
      secretCodec: this.secretCodec,
      table: "oauth_client_configs",
      service: config.service,
      value: config,
    });
  }

  async delete(service: string): Promise<void> {
    this.database.prepare("delete from oauth_client_configs where service = ?").run(service);
  }

  async list(): Promise<OAuthClientConfig[]> {
    const rows = this.database.prepare("select value from oauth_client_configs order by service").all();
    return await Promise.all(
      rows.map(async (row) => parseJson<OAuthClientConfig>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }
}

export class SqliteOAuthStateStore implements IOAuthStateStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    this.database
      .prepare(
        `
        insert into oauth_states (state, value, created_at)
        values (?, ?, ?)
        on conflict(state) do update set value = excluded.value, created_at = excluded.created_at
      `,
      )
      .run(state.state, JSON.stringify(state), state.createdAt);
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const pending = getJson<OAuthAuthorizationState>(this.database, "oauth_states", "state", state);
    this.database.prepare("delete from oauth_states where state = ?").run(state);
    return pending;
  }
}

export class SqliteRuntimeTokenStore implements IRuntimeTokenStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async add(record: RuntimeTokenRecord): Promise<void> {
    this.database
      .prepare(
        `
        insert into runtime_tokens (
          id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.name,
        record.tokenHash,
        JSON.stringify(record.allowedActions),
        JSON.stringify(record.blockedActions),
        JSON.stringify(record.allowedProxies),
        record.createdAt,
        record.lastUsedAt ?? null,
      );
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    return this.database
      .prepare(
        `
        select id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
        from runtime_tokens
        where revoked_at is null
        order by created_at desc, id desc
      `,
      )
      .all()
      .map(readRuntimeTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    const row = this.database
      .prepare(
        `
        select id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
        from runtime_tokens
        where token_hash = ? and revoked_at is null
      `,
      )
      .get(tokenHash);
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async updatePolicy(id: string, policy: TokenPolicy): Promise<RuntimeTokenRecord | undefined> {
    const row = this.database
      .prepare(
        `
        update runtime_tokens
        set allowed_actions = ?, blocked_actions = ?, allowed_proxies = ?
        where id = ? and revoked_at is null
        returning id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
      `,
      )
      .get(
        JSON.stringify(policy.allowedActions),
        JSON.stringify(policy.blockedActions),
        JSON.stringify(policy.allowedProxies),
        id,
      );
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async revoke(id: string): Promise<boolean> {
    const result = this.database.prepare("delete from runtime_tokens where id = ?").run(id);
    return result.changes > 0;
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    this.database
      .prepare("update runtime_tokens set last_used_at = ? where id = ? and revoked_at is null")
      .run(usedAt, id);
  }
}

function readRuntimeTokenRow(row: unknown): RuntimeTokenRecord {
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    tokenHash: readString(row, "token_hash"),
    allowedActions: parseJson(readString(row, "allowed_actions")),
    blockedActions: parseJson(readString(row, "blocked_actions")),
    allowedProxies: parseJson(readString(row, "allowed_proxies")),
    createdAt: readString(row, "created_at"),
    lastUsedAt: readOptionalString(row, "last_used_at"),
  };
}

export class SqliteRuntimePolicyStore implements IRuntimePolicyStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async get(): Promise<RuntimePolicyRecord | undefined> {
    const row = this.database.prepare("select value, updated_at from runtime_policy where id = 1").get();
    return row
      ? {
          rules: parseJson(readString(row, "value")),
          updatedAt: readString(row, "updated_at"),
        }
      : undefined;
  }

  async set(record: RuntimePolicyRecord): Promise<void> {
    this.database
      .prepare(
        `
        insert into runtime_policy (id, value, updated_at)
        values (1, ?, ?)
        on conflict(id) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .run(JSON.stringify(record.rules), record.updatedAt);
  }
}

export class SqliteIdempotencyStore implements IIdempotencyStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const claim = runInTransaction(this.database, () => {
      this.database.prepare("delete from idempotency_records where expires_at <= ?").run(input.now);
      const inserted = this.database
        .prepare(
          `
          insert into idempotency_records (
            key_hash, claim_id, request_hash, state, response_value, created_at, expires_at
          )
          values (?, ?, ?, 'in_progress', null, ?, ?)
          on conflict(key_hash) do nothing
        `,
        )
        .run(input.keyHash, input.claimId, input.requestHash, input.now, input.expiresAt);

      if (inserted.changes > 0) {
        return { kind: "acquired" } as const;
      }

      const row = this.database
        .prepare(
          `
          select request_hash, state, response_value
          from idempotency_records
          where key_hash = ?
        `,
        )
        .get(input.keyHash) as RuntimeRow;
      return { kind: "existing", row } as const;
    });

    if (claim.kind === "acquired") {
      return claim;
    }
    if (readString(claim.row, "request_hash") !== input.requestHash) {
      return { kind: "conflict" };
    }
    if (readString(claim.row, "state") === "in_progress") {
      return { kind: "in_progress" };
    }

    return {
      kind: "completed",
      response: parseRuntimeActionHttpResult(
        parseJson(await this.secretCodec.decode(readString(claim.row, "response_value"))),
      ),
    };
  }

  async complete(input: CompleteIdempotencyInput): Promise<boolean> {
    const responseValue = await this.secretCodec.encode(JSON.stringify(input.response));
    const result = this.database
      .prepare(
        `
        update idempotency_records
        set state = 'completed', response_value = ?, expires_at = ?
        where key_hash = ?
          and claim_id = ?
          and request_hash = ?
          and state = 'in_progress'
      `,
      )
      .run(responseValue, input.expiresAt, input.keyHash, input.claimId, input.requestHash);
    return result.changes > 0;
  }

  async abandon(input: AbandonIdempotencyInput): Promise<boolean> {
    const result = this.database
      .prepare(
        `
        delete from idempotency_records
        where key_hash = ?
          and claim_id = ?
          and request_hash = ?
          and state = 'in_progress'
      `,
      )
      .run(input.keyHash, input.claimId, input.requestHash);
    return result.changes > 0;
  }
}

export class SqliteRunLogStore implements IRunLogStore {
  private readonly database: DatabaseSync;
  private readonly limit: number;

  constructor(database: DatabaseSync, limit: number) {
    this.database = database;
    this.limit = limit;
  }

  async add(run: RunLog): Promise<RunLogWriteResult> {
    insertRun(this.database, run);

    try {
      this.database
        .prepare(
          `
          delete from runs
          where id in (
            select id from runs
            order by started_at desc, id desc
            limit -1 offset ?
          )
        `,
        )
        .run(this.limit);
      return { retentionApplied: true };
    } catch {
      return { retentionApplied: false };
    }
  }

  async get(id: string): Promise<RunLog | undefined> {
    const row = this.database.prepare("select service, value from runs where id = ?").get(id);
    return row ? readRunLogRow(row) : undefined;
  }

  async list(input: RunLogListInput = {}): Promise<RunLogPage> {
    const limit = Math.max(1, Math.min(input.limit ?? this.limit, this.limit));
    const cursor = decodeRunLogCursor(input.cursor);
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (cursor) {
      conditions.push("(started_at < ? or (started_at = ? and id < ?))");
      values.push(cursor.startedAt, cursor.startedAt, cursor.id);
    }
    if (input.service) {
      conditions.push("service = ?");
      values.push(input.service);
    }
    if (input.actionId) {
      conditions.push("action_id = ?");
      values.push(input.actionId);
    }
    if (input.caller) {
      conditions.push("caller = ?");
      values.push(input.caller);
    }
    if (input.ok !== undefined) {
      conditions.push("ok = ?");
      values.push(input.ok ? 1 : 0);
    }
    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const rows = this.database
      .prepare(`select service, value from runs ${where} order by started_at desc, id desc limit ?`)
      .all(...values, limit + 1);
    const runs = rows.map(readRunLogRow);
    const items = runs.slice(0, limit);

    return {
      items,
      nextCursor: runs.length > limit && items.length > 0 ? encodeRunLogCursor(items[items.length - 1]) : undefined,
    };
  }
}

export class SqliteFlowStore implements IFlowStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setFlow(flow: FlowDefinition): Promise<void> {
    this.database
      .prepare(
        `
        insert into flows (id, status, created_at, updated_at, value)
        values (?, ?, ?, ?, ?)
        on conflict(id) do update set
          status = excluded.status,
          updated_at = excluded.updated_at,
          value = excluded.value
      `,
      )
      .run(flow.id, flow.status, flow.createdAt, flow.updatedAt, await this.encode(flow));
  }

  async getFlow(id: string): Promise<FlowDefinition | undefined> {
    return await this.getById<FlowDefinition>("flows", id);
  }

  async listFlows(): Promise<FlowDefinition[]> {
    return await this.listValues<FlowDefinition>("select value from flows order by updated_at desc, id desc");
  }

  async deleteFlow(id: string): Promise<boolean> {
    let deleted = false;
    runInTransaction(this.database, () => {
      this.database.prepare("delete from flow_trigger_states where id = ?").run(id);
      deleted = this.database.prepare("delete from flows where id = ?").run(id).changes > 0;
    });
    return deleted;
  }

  async addRun(run: FlowRun): Promise<void> {
    this.database
      .prepare(
        `
        insert into flow_runs (id, flow_id, status, started_at, updated_at, value)
        values (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(run.id, run.flowId, run.status, run.startedAt, run.updatedAt, await this.encode(run));
  }

  async updateRun(run: FlowRun): Promise<void> {
    this.database
      .prepare("update flow_runs set status = ?, updated_at = ?, value = ? where id = ?")
      .run(run.status, run.updatedAt, await this.encode(run), run.id);
  }

  async getRun(id: string): Promise<FlowRun | undefined> {
    return await this.getById<FlowRun>("flow_runs", id);
  }

  async listRuns(flowId?: string, limit = 100): Promise<FlowRun[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    return flowId
      ? await this.listValues<FlowRun>(
          "select value from flow_runs where flow_id = ? order by started_at desc, id desc limit ?",
          flowId,
          boundedLimit,
        )
      : await this.listValues<FlowRun>(
          "select value from flow_runs order by started_at desc, id desc limit ?",
          boundedLimit,
        );
  }

  async addStep(step: FlowStep): Promise<void> {
    this.database
      .prepare(
        `
        insert into flow_steps (id, run_id, sequence, status, started_at, value)
        values (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(step.id, step.runId, step.sequence, step.status, step.startedAt, await this.encode(step));
  }

  async updateStep(step: FlowStep): Promise<void> {
    this.database
      .prepare("update flow_steps set status = ?, value = ? where id = ?")
      .run(step.status, await this.encode(step), step.id);
  }

  async listSteps(runId: string): Promise<FlowStep[]> {
    return await this.listValues<FlowStep>(
      "select value from flow_steps where run_id = ? order by sequence, id",
      runId,
    );
  }

  async addApproval(approval: FlowApproval): Promise<void> {
    this.database
      .prepare(
        `
        insert into flow_approvals (id, flow_id, run_id, step_id, status, requested_at, value)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        approval.id,
        approval.flowId,
        approval.runId,
        approval.stepId,
        approval.status,
        approval.requestedAt,
        await this.encode(approval),
      );
  }

  async getApproval(id: string): Promise<FlowApproval | undefined> {
    return await this.getById<FlowApproval>("flow_approvals", id);
  }

  async listApprovals(status?: FlowApprovalStatus): Promise<FlowApproval[]> {
    return status
      ? await this.listValues<FlowApproval>(
          "select value from flow_approvals where status = ? order by requested_at desc, id desc",
          status,
        )
      : await this.listValues<FlowApproval>("select value from flow_approvals order by requested_at desc, id desc");
  }

  async updateApproval(approval: FlowApproval, expectedStatus: FlowApprovalStatus): Promise<boolean> {
    return (
      this.database
        .prepare("update flow_approvals set status = ?, value = ? where id = ? and status = ?")
        .run(approval.status, await this.encode(approval), approval.id, expectedStatus).changes > 0
    );
  }

  async setTriggerState(state: FlowTriggerState): Promise<void> {
    this.database
      .prepare(
        `
        insert into flow_trigger_states (id, updated_at, value)
        values (?, ?, ?)
        on conflict(id) do update set
          updated_at = excluded.updated_at,
          value = excluded.value
      `,
      )
      .run(state.flowId, state.updatedAt, await this.encode(state));
  }

  async getTriggerState(flowId: string): Promise<FlowTriggerState | undefined> {
    return await this.getById<FlowTriggerState>("flow_trigger_states", flowId);
  }

  async deleteTriggerState(flowId: string): Promise<void> {
    this.database.prepare("delete from flow_trigger_states where id = ?").run(flowId);
  }

  private async getById<T>(table: IdSecretTable, id: string): Promise<T | undefined> {
    const row = this.database.prepare(`select value from ${table} where id = ?`).get(id);
    return row ? parseJson<T>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  private async listValues<T>(query: string, ...parameters: Array<string | number>): Promise<T[]> {
    const rows = this.database.prepare(query).all(...parameters);
    return await Promise.all(
      rows.map(async (row) => parseJson<T>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }

  private encode(value: unknown): Promise<string> {
    return this.secretCodec.encode(JSON.stringify(value));
  }
}

export class SqliteFeedStore implements IFeedStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setThread(thread: FeedThread): Promise<void> {
    this.database
      .prepare(
        `
        insert into feed_threads (id, flow_run_id, updated_at, value)
        values (?, ?, ?, ?)
        on conflict(id) do update set
          flow_run_id = excluded.flow_run_id,
          updated_at = excluded.updated_at,
          value = excluded.value
      `,
      )
      .run(thread.id, thread.flowRunId, thread.updatedAt, await this.secretCodec.encode(JSON.stringify(thread)));
  }

  async getThread(id: string): Promise<FeedThread | undefined> {
    const row = this.database.prepare("select value from feed_threads where id = ?").get(id);
    return row ? parseJson<FeedThread>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listThreads(limit = 500): Promise<FeedThread[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const rows = this.database
      .prepare("select value from feed_threads order by updated_at desc, id desc limit ?")
      .all(boundedLimit);
    return await Promise.all(
      rows.map(async (row) => parseJson<FeedThread>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }
}

export class SqliteSynapseStore implements ISynapseStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setWorkspace(workspace: SynapseWorkspace): Promise<void> {
    this.database
      .prepare(
        `
        insert into synapse_workspaces (id, updated_at, value)
        values (?, ?, ?)
        on conflict(id) do update set
          updated_at = excluded.updated_at,
          value = excluded.value
      `,
      )
      .run(workspace.id, workspace.updatedAt, await this.secretCodec.encode(JSON.stringify(workspace)));
  }

  async getWorkspace(id: string): Promise<SynapseWorkspace | undefined> {
    const row = this.database.prepare("select value from synapse_workspaces where id = ?").get(id);
    return row ? parseJson<SynapseWorkspace>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listWorkspaces(limit = 100): Promise<SynapseWorkspace[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.database
      .prepare("select value from synapse_workspaces order by updated_at desc, id desc limit ?")
      .all(boundedLimit);
    return await Promise.all(
      rows.map(async (row) => parseJson<SynapseWorkspace>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    return this.database.prepare("delete from synapse_workspaces where id = ?").run(id).changes > 0;
  }
}

export class SqliteTeamsGatewayStore implements ITeamsGatewayStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setAgent(agent: TeamsGatewayAgent): Promise<void> {
    await this.setRecord("teams_gateway_agents", agent.id, agent.updatedAt, agent);
  }

  async getAgent(id: string): Promise<TeamsGatewayAgent | undefined> {
    return this.getRecord<TeamsGatewayAgent>("teams_gateway_agents", "id", id);
  }

  async listAgents(): Promise<TeamsGatewayAgent[]> {
    return this.listRecords<TeamsGatewayAgent>("teams_gateway_agents", undefined, 500);
  }

  async deleteAgent(id: string): Promise<boolean> {
    return runInTransaction(this.database, () => {
      this.database.prepare("delete from teams_gateway_contacts where agent_id = ?").run(id);
      this.database.prepare("delete from teams_gateway_threads where agent_id = ?").run(id);
      this.database.prepare("delete from teams_gateway_groups where agent_id = ?").run(id);
      this.database.prepare("delete from teams_gateway_subscriptions where agent_id = ?").run(id);
      return this.database.prepare("delete from teams_gateway_agents where id = ?").run(id).changes > 0;
    });
  }

  async setThread(thread: TeamsGatewayThread): Promise<void> {
    const value = await this.secretCodec.encode(JSON.stringify(thread));
    this.database
      .prepare(
        `insert into teams_gateway_threads (id, agent_id, chat_id, updated_at, value)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set agent_id = excluded.agent_id, chat_id = excluded.chat_id,
           updated_at = excluded.updated_at, value = excluded.value`,
      )
      .run(thread.id, thread.agentId, thread.chatId, thread.updatedAt, value);
  }

  async getThread(agentId: string, chatId: string): Promise<TeamsGatewayThread | undefined> {
    const row = this.database
      .prepare("select value from teams_gateway_threads where agent_id = ? and chat_id = ?")
      .get(agentId, chatId);
    return row ? parseJson<TeamsGatewayThread>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listThreads(agentId?: string, limit = 100): Promise<TeamsGatewayThread[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = agentId
      ? this.database
          .prepare(
            "select value from teams_gateway_threads where agent_id = ? order by updated_at desc, id desc limit ?",
          )
          .all(agentId, boundedLimit)
      : this.database
          .prepare("select value from teams_gateway_threads order by updated_at desc, id desc limit ?")
          .all(boundedLimit);
    return Promise.all(
      rows.map(async (row) => parseJson<TeamsGatewayThread>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }

  async setContact(contact: TeamsGatewayContact): Promise<void> {
    const value = await this.secretCodec.encode(JSON.stringify(contact));
    this.database
      .prepare(
        `insert into teams_gateway_contacts (id, agent_id, email, updated_at, value)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set agent_id = excluded.agent_id, email = excluded.email,
           updated_at = excluded.updated_at, value = excluded.value`,
      )
      .run(contact.id, contact.agentId, contact.email, contact.lastInboundAt, value);
  }

  async getContact(agentId: string, email: string): Promise<TeamsGatewayContact | undefined> {
    const row = this.database
      .prepare("select value from teams_gateway_contacts where agent_id = ? and email = ?")
      .get(agentId, email.toLowerCase());
    return row ? parseJson<TeamsGatewayContact>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listContacts(agentId: string): Promise<TeamsGatewayContact[]> {
    const rows = this.database
      .prepare("select value from teams_gateway_contacts where agent_id = ? order by updated_at desc, id desc")
      .all(agentId);
    return Promise.all(
      rows.map(async (row) => parseJson<TeamsGatewayContact>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }

  async setGroup(group: TeamsGatewayGroup): Promise<void> {
    const value = await this.secretCodec.encode(JSON.stringify(group));
    this.database
      .prepare(
        `insert into teams_gateway_groups (id, agent_id, kind, external_id, updated_at, value)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set agent_id = excluded.agent_id, kind = excluded.kind,
           external_id = excluded.external_id, updated_at = excluded.updated_at, value = excluded.value`,
      )
      .run(group.id, group.agentId, group.kind, group.externalId, group.updatedAt, value);
  }

  async getGroup(id: string): Promise<TeamsGatewayGroup | undefined> {
    const row = this.database.prepare("select value from teams_gateway_groups where id = ?").get(id);
    return row ? parseJson<TeamsGatewayGroup>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listGroups(agentId?: string): Promise<TeamsGatewayGroup[]> {
    const rows = agentId
      ? this.database
          .prepare("select value from teams_gateway_groups where agent_id = ? order by updated_at desc, id desc")
          .all(agentId)
      : this.database.prepare("select value from teams_gateway_groups order by updated_at desc, id desc").all();
    return Promise.all(
      rows.map(async (row) => parseJson<TeamsGatewayGroup>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }

  async deleteMissingGroups(agentId: string, retainedIds: string[]): Promise<void> {
    const retained = new Set(retainedIds);
    const groups = await this.listGroups(agentId);
    runInTransaction(this.database, () => {
      for (const group of groups) {
        if (!retained.has(group.id) && group.enabled !== false) {
          this.database.prepare("delete from teams_gateway_groups where id = ?").run(group.id);
        }
      }
    });
  }

  async setSubscription(subscription: TeamsGatewaySubscription): Promise<void> {
    const value = await this.secretCodec.encode(JSON.stringify(subscription));
    this.database
      .prepare(
        `insert into teams_gateway_subscriptions
           (id, subscription_id, agent_id, expires_at, updated_at, value)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set subscription_id = excluded.subscription_id,
           agent_id = excluded.agent_id, expires_at = excluded.expires_at,
           updated_at = excluded.updated_at, value = excluded.value`,
      )
      .run(
        subscription.sourceKey,
        subscription.subscriptionId,
        subscription.agentId,
        subscription.expiresAt,
        subscription.updatedAt,
        value,
      );
  }

  async getSubscriptionById(subscriptionId: string): Promise<TeamsGatewaySubscription | undefined> {
    const row = this.database
      .prepare("select value from teams_gateway_subscriptions where subscription_id = ?")
      .get(subscriptionId);
    return row
      ? parseJson<TeamsGatewaySubscription>(await this.secretCodec.decode(readString(row, "value")))
      : undefined;
  }

  async listSubscriptions(agentId?: string): Promise<TeamsGatewaySubscription[]> {
    const rows = agentId
      ? this.database
          .prepare("select value from teams_gateway_subscriptions where agent_id = ? order by id")
          .all(agentId)
      : this.database.prepare("select value from teams_gateway_subscriptions order by id").all();
    return Promise.all(
      rows.map(async (row) =>
        parseJson<TeamsGatewaySubscription>(await this.secretCodec.decode(readString(row, "value"))),
      ),
    );
  }

  async deleteSubscription(sourceKey: string): Promise<void> {
    this.database.prepare("delete from teams_gateway_subscriptions where id = ?").run(sourceKey);
  }

  private async setRecord(table: "teams_gateway_agents", id: string, updatedAt: string, value: unknown): Promise<void> {
    this.database
      .prepare(
        `insert into ${table} (id, updated_at, value) values (?, ?, ?)
         on conflict(id) do update set updated_at = excluded.updated_at, value = excluded.value`,
      )
      .run(id, updatedAt, await this.secretCodec.encode(JSON.stringify(value)));
  }

  private async getRecord<T>(table: "teams_gateway_agents", field: "id", value: string): Promise<T | undefined> {
    const row = this.database.prepare(`select value from ${table} where ${field} = ?`).get(value);
    return row ? parseJson<T>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  private async listRecords<T>(
    table: "teams_gateway_agents",
    _agentId: string | undefined,
    limit: number,
  ): Promise<T[]> {
    const rows = this.database
      .prepare(`select value from ${table} order by updated_at desc, id desc limit ?`)
      .all(limit);
    return Promise.all(rows.map(async (row) => parseJson<T>(await this.secretCodec.decode(readString(row, "value")))));
  }
}

export class SqliteKanbanStore implements IKanbanStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setBoard(board: KanbanBoardDefinition): Promise<void> {
    this.database
      .prepare(
        `
        insert into kanban_boards (id, updated_at, value)
        values (?, ?, ?)
        on conflict(id) do update set
          updated_at = excluded.updated_at,
          value = excluded.value
      `,
      )
      .run(board.id, board.updatedAt, await this.secretCodec.encode(JSON.stringify(board)));
  }

  async getBoard(id: string): Promise<KanbanBoardDefinition | undefined> {
    const row = this.database.prepare("select value from kanban_boards where id = ?").get(id);
    return row ? parseJson<KanbanBoardDefinition>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listBoards(limit = 100): Promise<KanbanBoardDefinition[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.database
      .prepare("select value from kanban_boards order by updated_at desc, id desc limit ?")
      .all(boundedLimit);
    return await Promise.all(
      rows.map(async (row) =>
        parseJson<KanbanBoardDefinition>(await this.secretCodec.decode(readString(row, "value"))),
      ),
    );
  }

  async deleteBoard(id: string): Promise<boolean> {
    return this.database.prepare("delete from kanban_boards where id = ?").run(id).changes > 0;
  }
}

export class SqliteConnectionApprovalStore implements IConnectionApprovalStore {
  private readonly database: DatabaseSync;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async replacePermissions(connectionId: string, permissions: ConnectionActionPermission[]): Promise<void> {
    const encoded = await Promise.all(
      permissions.map(async (permission) => ({ permission, value: await this.encode(permission) })),
    );
    runInTransaction(this.database, () => {
      this.database.prepare("delete from connection_action_permissions where connection_id = ?").run(connectionId);
      const insert = this.database.prepare(`
        insert into connection_action_permissions (id, connection_id, action_id, updated_at, value)
        values (?, ?, ?, ?, ?)
      `);
      for (const item of encoded) {
        insert.run(
          connectionPermissionId(connectionId, item.permission.actionId),
          connectionId,
          item.permission.actionId,
          item.permission.updatedAt,
          item.value,
        );
      }
    });
  }

  async listPermissions(connectionId?: string): Promise<ConnectionActionPermission[]> {
    const rows = connectionId
      ? this.database
          .prepare("select value from connection_action_permissions where connection_id = ? order by action_id")
          .all(connectionId)
      : this.database
          .prepare("select value from connection_action_permissions order by connection_id, action_id")
          .all();
    return await this.decodeRows<ConnectionActionPermission>(rows);
  }

  async getPermission(connectionId: string, actionId: string): Promise<ConnectionActionPermission | undefined> {
    return await this.getById<ConnectionActionPermission>(
      "connection_action_permissions",
      connectionPermissionId(connectionId, actionId),
    );
  }

  async addActionApproval(approval: ActionApproval): Promise<void> {
    this.database
      .prepare(`insert into action_approvals (id, status, request_hash, requested_at, value) values (?, ?, ?, ?, ?)`)
      .run(approval.id, approval.status, approval.requestHash, approval.requestedAt, await this.encode(approval));
  }

  async getActionApproval(id: string): Promise<ActionApproval | undefined> {
    return await this.getById<ActionApproval>("action_approvals", id);
  }

  async listActionApprovals(limit = 500): Promise<ActionApproval[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const rows = this.database
      .prepare("select value from action_approvals order by requested_at desc, id desc limit ?")
      .all(boundedLimit);
    return await this.decodeRows<ActionApproval>(rows);
  }

  async findActionApproval(requestHash: string, status: ActionApprovalStatus): Promise<ActionApproval | undefined> {
    const row = this.database
      .prepare(
        "select value from action_approvals where request_hash = ? and status = ? order by requested_at desc, id desc limit 1",
      )
      .get(requestHash, status);
    return row ? await this.decode<ActionApproval>(readString(row, "value")) : undefined;
  }

  async updateActionApproval(approval: ActionApproval, expectedStatus: ActionApprovalStatus): Promise<boolean> {
    return (
      this.database
        .prepare("update action_approvals set status = ?, value = ? where id = ? and status = ?")
        .run(approval.status, await this.encode(approval), approval.id, expectedStatus).changes > 0
    );
  }

  private async getById<T>(table: IdSecretTable, id: string): Promise<T | undefined> {
    const row = this.database.prepare(`select value from ${table} where id = ?`).get(id);
    return row ? await this.decode<T>(readString(row, "value")) : undefined;
  }

  private async decodeRows<T>(rows: Record<string, unknown>[]): Promise<T[]> {
    return await Promise.all(rows.map((row) => this.decode<T>(readString(row, "value"))));
  }

  private async decode<T>(value: string): Promise<T> {
    return parseJson<T>(await this.secretCodec.decode(value));
  }

  private encode(value: unknown): Promise<string> {
    return this.secretCodec.encode(JSON.stringify(value));
  }
}

function connectionPermissionId(connectionId: string, actionId: string): string {
  return `${connectionId.length}:${connectionId}${actionId}`;
}

function insertRun(database: DatabaseSync, run: RunLog): void {
  database
    .prepare(
      `
      insert into runs (id, service, action_id, caller, started_at, completed_at, ok, value)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        service = excluded.service,
        action_id = excluded.action_id,
        caller = excluded.caller,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        ok = excluded.ok,
        value = excluded.value
    `,
    )
    .run(
      run.id,
      run.service,
      run.actionId,
      run.caller,
      run.startedAt,
      run.completedAt,
      run.ok ? 1 : 0,
      JSON.stringify(run),
    );
}

function readRunLogRow(row: unknown): RunLog {
  const run = parseJson<RunLog>(readString(row, "value"));
  return { ...run, service: readString(row, "service") };
}

function runSqliteMigrations(database: DatabaseSync, logger?: RuntimeLogger): void {
  const startedAt = Date.now();
  database.exec(`
    create table if not exists runtime_migrations (
      name text primary key,
      applied_at text not null
    );
  `);
  const applied = new Set(
    database
      .prepare("select name from runtime_migrations")
      .all()
      .map((row) => readString(row, "name")),
  );
  const migrationFiles = readdirSync(migrationDirectory)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  let newlyAppliedCount = 0;

  for (const file of migrationFiles) {
    if (applied.has(file)) {
      continue;
    }

    const migrationStartedAt = Date.now();
    logger?.info({ migration: file }, "sqlite migration started");
    try {
      const sql = readFileSync(new URL(file, migrationDirectory), "utf8");
      runInTransaction(database, () => {
        database.exec(sql);
        database
          .prepare("insert into runtime_migrations (name, applied_at) values (?, ?)")
          .run(file, new Date().toISOString());
      });
    } catch (error) {
      logger?.error(
        { migration: file, durationMs: Date.now() - migrationStartedAt, err: error },
        "sqlite migration failed",
      );
      throw error;
    }
    applied.add(file);
    newlyAppliedCount += 1;
    logger?.info({ migration: file, durationMs: Date.now() - migrationStartedAt }, "sqlite migration completed");
  }

  logger?.info(
    {
      migrationCount: migrationFiles.length,
      appliedCount: migrationFiles.filter((file) => applied.has(file)).length,
      newlyAppliedCount,
      durationMs: Date.now() - startedAt,
    },
    "sqlite migrations ready",
  );
}

async function readRotatedConnectionSecrets(
  database: DatabaseSync,
  currentCodec: ISecretCodec,
  nextCodec: ISecretCodec,
): Promise<RotatedConnectionSecret[]> {
  const rows = database.prepare("select service, connection_name, value from connections").all();
  return await Promise.all(
    rows.map(async (row) => ({
      service: readString(row, "service"),
      connectionName: readString(row, "connection_name"),
      value: await nextCodec.encode(await currentCodec.decode(readString(row, "value"))),
    })),
  );
}

function writeRotatedConnectionSecrets(database: DatabaseSync, connections: RotatedConnectionSecret[]): void {
  const statement = database.prepare("update connections set value = ? where service = ? and connection_name = ?");
  for (const connection of connections) {
    statement.run(connection.value, connection.service, connection.connectionName);
  }
}

async function readRotatedServiceSecrets(
  database: DatabaseSync,
  currentCodec: ISecretCodec,
  nextCodec: ISecretCodec,
  table: SecretJsonTable,
): Promise<RotatedServiceSecret[]> {
  const rows = database.prepare(`select service, value from ${table}`).all();
  return await Promise.all(
    rows.map(async (row) => ({
      service: readString(row, "service"),
      value: await nextCodec.encode(await currentCodec.decode(readString(row, "value"))),
    })),
  );
}

function writeRotatedServiceSecrets(
  database: DatabaseSync,
  table: SecretJsonTable,
  services: RotatedServiceSecret[],
): void {
  const statement = database.prepare(`update ${table} set value = ? where service = ?`);
  for (const service of services) {
    statement.run(service.value, service.service);
  }
}

async function readRotatedIdempotencySecrets(
  database: DatabaseSync,
  currentCodec: ISecretCodec,
  nextCodec: ISecretCodec,
): Promise<RotatedIdempotencySecret[]> {
  const rows = database
    .prepare("select key_hash, response_value from idempotency_records where response_value is not null")
    .all();
  return await Promise.all(
    rows.map(async (row) => ({
      keyHash: readString(row, "key_hash"),
      value: await nextCodec.encode(await currentCodec.decode(readString(row, "response_value"))),
    })),
  );
}

function writeRotatedIdempotencySecrets(database: DatabaseSync, responses: RotatedIdempotencySecret[]): void {
  const statement = database.prepare("update idempotency_records set response_value = ? where key_hash = ?");
  for (const response of responses) {
    statement.run(response.value, response.keyHash);
  }
}

async function readRotatedIdSecrets(
  database: DatabaseSync,
  currentCodec: ISecretCodec,
  nextCodec: ISecretCodec,
  table: IdSecretTable,
): Promise<RotatedIdSecret[]> {
  const rows = database.prepare(`select id, value from ${table}`).all();
  return await Promise.all(
    rows.map(async (row) => ({
      id: readString(row, "id"),
      value: await nextCodec.encode(await currentCodec.decode(readString(row, "value"))),
    })),
  );
}

function writeRotatedIdSecrets(database: DatabaseSync, table: IdSecretTable, records: RotatedIdSecret[]): void {
  const statement = database.prepare(`update ${table} set value = ? where id = ?`);
  for (const record of records) {
    statement.run(record.value, record.id);
  }
}

function runInTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("begin immediate");
  try {
    const result = work();
    database.exec("commit");
    return result;
  } catch (error) {
    database.exec("rollback");
    throw error;
  }
}

function getJson<T>(database: DatabaseSync, table: "oauth_states", keyColumn: "state", key: string): T | undefined {
  const row = database.prepare(`select value from ${table} where ${keyColumn} = ?`).get(key) as RuntimeRow | undefined;
  return row ? parseJson<T>(readString(row, "value")) : undefined;
}

async function getSecretJson<T>(input: SecretJsonInput): Promise<T | undefined> {
  const stored = getStoredValue(input.database, input.table, "service", input.service);
  return stored ? parseJson<T>(await input.secretCodec.decode(stored)) : undefined;
}

function getStoredValue(
  database: DatabaseSync,
  table: SecretJsonTable,
  keyColumn: "service",
  key: string,
): string | undefined {
  const row = database.prepare(`select value from ${table} where ${keyColumn} = ?`).get(key) as RuntimeRow | undefined;
  return row ? readString(row, "value") : undefined;
}

async function setServiceJson(input: SetServiceJsonInput): Promise<void> {
  input.database
    .prepare(
      `
      insert into ${input.table} (service, value, updated_at)
      values (?, ?, ?)
      on conflict(service) do update set value = excluded.value, updated_at = excluded.updated_at
    `,
    )
    .run(input.service, await input.secretCodec.encode(JSON.stringify(input.value)), new Date().toISOString());
}

function readString(row: unknown, key: string): string {
  if (typeof row !== "object" || row == null) {
    throw new Error(`Expected SQLite row for ${key}.`);
  }

  const value = (row as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string.`);
  }

  return value;
}

function readOptionalString(row: unknown, key: string): string | undefined {
  if (typeof row !== "object" || row == null) {
    throw new Error(`Expected SQLite row for ${key}.`);
  }

  const value = (row as Record<string, unknown>)[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string.`);
  }

  return value;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
