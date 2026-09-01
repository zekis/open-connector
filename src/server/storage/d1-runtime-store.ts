import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { TokenPolicy } from "../../core/action-policy.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type {
  ActionApproval,
  ActionApprovalStatus,
  ConnectionActionPermission,
  IConnectionApprovalStore,
} from "../approvals/connection-approval-types.ts";
import type { IMobileAuthStore, MobileDeviceRecord, MobilePairingRecord } from "../auth/mobile-auth-service.ts";
import type { D1DatabaseBinding } from "../cloudflare/cloudflare-bindings.ts";
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

import { parseRuntimeActionHttpResult } from "../api/runtime-api.ts";
import { PlainTextSecretCodec } from "../secrets/secret-codec-core.ts";
import { DEFAULT_RUN_LIMIT, decodeRunLogCursor, encodeRunLogCursor } from "./runtime-store.ts";

type RuntimeRow = Record<string, unknown>;
type SecretJsonTable = "oauth_client_configs";

export interface D1RuntimeDatabaseOptions {
  runLimit?: number;
  secretCodec?: ISecretCodec;
}

export class D1RuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore: D1ConnectionStore;
  readonly oauthClientConfigStore: D1OAuthClientConfigStore;
  readonly oauthStateStore: D1OAuthStateStore;
  readonly runtimeTokenStore: D1RuntimeTokenStore;
  readonly mobileAuthStore: D1MobileAuthStore;
  readonly runtimePolicyStore: D1RuntimePolicyStore;
  readonly runLogStore: D1RunLogStore;
  readonly idempotencyStore: D1IdempotencyStore;
  readonly flowStore: D1FlowStore;
  readonly feedStore: D1FeedStore;
  readonly connectionApprovalStore: D1ConnectionApprovalStore;
  readonly synapseStore: D1SynapseStore;
  readonly kanbanStore: D1KanbanStore;
  readonly teamsGatewayStore: D1TeamsGatewayStore;

  constructor(database: D1DatabaseBinding, options: D1RuntimeDatabaseOptions = {}) {
    const secretCodec = options.secretCodec ?? new PlainTextSecretCodec();
    this.connectionStore = new D1ConnectionStore(database, secretCodec);
    this.oauthClientConfigStore = new D1OAuthClientConfigStore(database, secretCodec);
    this.oauthStateStore = new D1OAuthStateStore(database);
    this.runtimeTokenStore = new D1RuntimeTokenStore(database);
    this.mobileAuthStore = new D1MobileAuthStore(database);
    this.runtimePolicyStore = new D1RuntimePolicyStore(database);
    this.runLogStore = new D1RunLogStore(database, options.runLimit ?? DEFAULT_RUN_LIMIT);
    this.idempotencyStore = new D1IdempotencyStore(database, secretCodec);
    this.flowStore = new D1FlowStore(database, secretCodec);
    this.feedStore = new D1FeedStore(database, secretCodec);
    this.connectionApprovalStore = new D1ConnectionApprovalStore(database, secretCodec);
    this.synapseStore = new D1SynapseStore(database, secretCodec);
    this.kanbanStore = new D1KanbanStore(database, secretCodec);
    this.teamsGatewayStore = new D1TeamsGatewayStore(database, secretCodec);
  }
}

export class D1MobileAuthStore implements IMobileAuthStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async addPairing(record: MobilePairingRecord): Promise<void> {
    await this.database.prepare("delete from mobile_pairings where expires_at <= ?").bind(record.createdAt).run();
    await this.database
      .prepare(
        `
        insert into mobile_pairings (id, name, code_hash, created_at, expires_at)
        values (?, ?, ?, ?, ?)
      `,
      )
      .bind(record.id, record.name, record.codeHash, record.createdAt, record.expiresAt)
      .run();
  }

  async takePairing(codeHash: string, now: string): Promise<MobilePairingRecord | undefined> {
    const row = await this.database
      .prepare(
        `
        delete from mobile_pairings
        where code_hash = ? and expires_at > ?
        returning id, name, code_hash, created_at, expires_at
      `,
      )
      .bind(codeHash, now)
      .first<RuntimeRow>();
    return row ? readMobilePairingRow(row) : undefined;
  }

  async deletePairing(id: string): Promise<boolean> {
    const result = await this.database.prepare("delete from mobile_pairings where id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async addDevice(record: MobileDeviceRecord): Promise<void> {
    await this.database
      .prepare(
        `
        insert into mobile_devices (id, pairing_id, name, token_hash, user_agent, created_at, last_used_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        record.id,
        record.pairingId,
        record.name,
        record.tokenHash,
        record.userAgent ?? null,
        record.createdAt,
        record.lastUsedAt ?? null,
      )
      .run();
  }

  async listDevices(): Promise<MobileDeviceRecord[]> {
    const { results } = await this.database
      .prepare(
        `
        select id, pairing_id, name, token_hash, user_agent, created_at, last_used_at
        from mobile_devices
        order by created_at desc, id desc
      `,
      )
      .all<RuntimeRow>();
    return results.map(readMobileDeviceRow);
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<MobileDeviceRecord | undefined> {
    const row = await this.database
      .prepare(
        `
        select id, pairing_id, name, token_hash, user_agent, created_at, last_used_at
        from mobile_devices
        where token_hash = ?
      `,
      )
      .bind(tokenHash)
      .first<RuntimeRow>();
    return row ? readMobileDeviceRow(row) : undefined;
  }

  async deleteDevice(id: string): Promise<boolean> {
    const result = await this.database.prepare("delete from mobile_devices where id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async markDeviceUsed(id: string, usedAt: string): Promise<void> {
    await this.database.prepare("update mobile_devices set last_used_at = ? where id = ?").bind(usedAt, id).run();
  }
}

function readMobilePairingRow(row: RuntimeRow): MobilePairingRecord {
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    codeHash: readString(row, "code_hash"),
    createdAt: readString(row, "created_at"),
    expiresAt: readString(row, "expires_at"),
  };
}

function readMobileDeviceRow(row: RuntimeRow): MobileDeviceRecord {
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

export class D1ConnectionStore implements IConnectionStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const row = await this.database
      .prepare("select id, revision, value from connections where service = ? and connection_name = ?")
      .bind(service, connectionName)
      .first<RuntimeRow>();
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
    const row = await this.database
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
      .bind(
        crypto.randomUUID(),
        crypto.randomUUID(),
        service,
        connectionName,
        await this.secretCodec.encode(JSON.stringify(credential)),
        new Date().toISOString(),
      )
      .first<RuntimeRow>();
    return {
      id: readString(row!, "id"),
      revision: readString(row!, "revision"),
      service,
      connectionName,
      credential,
    };
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const row = await this.database
      .prepare(
        `
        update connections
        set revision = ?, value = ?, updated_at = ?
        where service = ? and connection_name = ? and id = ? and revision = ?
        returning id
      `,
      )
      .bind(
        crypto.randomUUID(),
        await this.secretCodec.encode(JSON.stringify(input.credential)),
        new Date().toISOString(),
        input.service,
        input.connectionName,
        input.id,
        input.revision,
      )
      .first<RuntimeRow>();
    return row !== null;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    await this.database
      .prepare("delete from connections where service = ? and connection_name = ?")
      .bind(service, connectionName)
      .run();
  }

  async list(): Promise<StoredConnection[]> {
    const { results } = await this.database
      .prepare(
        "select id, revision, service, connection_name, value from connections order by service, connection_name",
      )
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => ({
        id: readString(row, "id"),
        revision: readString(row, "revision"),
        service: readString(row, "service"),
        connectionName: readString(row, "connection_name"),
        credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
      })),
    );
  }
}

export class D1OAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    return await getSecretJson<OAuthClientConfig>(this.database, this.secretCodec, "oauth_client_configs", service);
  }

  async set(config: OAuthClientConfig): Promise<void> {
    await this.database
      .prepare(
        `
        insert into oauth_client_configs (service, value, updated_at)
        values (?, ?, ?)
        on conflict(service) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .bind(config.service, await this.secretCodec.encode(JSON.stringify(config)), new Date().toISOString())
      .run();
  }

  async delete(service: string): Promise<void> {
    await this.database.prepare("delete from oauth_client_configs where service = ?").bind(service).run();
  }

  async list(): Promise<OAuthClientConfig[]> {
    const { results } = await this.database
      .prepare("select value from oauth_client_configs order by service")
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => parseJson<OAuthClientConfig>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }
}

export class D1OAuthStateStore implements IOAuthStateStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    await this.database
      .prepare(
        `
        insert into oauth_states (state, value, created_at)
        values (?, ?, ?)
        on conflict(state) do update set value = excluded.value, created_at = excluded.created_at
      `,
      )
      .bind(state.state, JSON.stringify(state), state.createdAt)
      .run();
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const row = await this.database
      .prepare("delete from oauth_states where state = ? returning value")
      .bind(state)
      .first<RuntimeRow>();
    return row ? parseJson<OAuthAuthorizationState>(readString(row, "value")) : undefined;
  }
}

export class D1RuntimeTokenStore implements IRuntimeTokenStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async add(record: RuntimeTokenRecord): Promise<void> {
    await this.database
      .prepare(
        `
        insert into runtime_tokens (
          id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        record.id,
        record.name,
        record.tokenHash,
        JSON.stringify(record.allowedActions),
        JSON.stringify(record.blockedActions),
        JSON.stringify(record.allowedProxies),
        record.createdAt,
        record.lastUsedAt ?? null,
      )
      .run();
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    const { results } = await this.database
      .prepare(
        `
        select id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
        from runtime_tokens
        where revoked_at is null
        order by created_at desc, id desc
      `,
      )
      .all<RuntimeRow>();
    return results.map(readRuntimeTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    const row = await this.database
      .prepare(
        `
        select id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
        from runtime_tokens
        where token_hash = ? and revoked_at is null
      `,
      )
      .bind(tokenHash)
      .first<RuntimeRow>();
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async updatePolicy(id: string, policy: TokenPolicy): Promise<RuntimeTokenRecord | undefined> {
    const row = await this.database
      .prepare(
        `
        update runtime_tokens
        set allowed_actions = ?, blocked_actions = ?, allowed_proxies = ?
        where id = ? and revoked_at is null
        returning id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
      `,
      )
      .bind(
        JSON.stringify(policy.allowedActions),
        JSON.stringify(policy.blockedActions),
        JSON.stringify(policy.allowedProxies),
        id,
      )
      .first<RuntimeRow>();
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.database.prepare("delete from runtime_tokens where id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    await this.database
      .prepare("update runtime_tokens set last_used_at = ? where id = ? and revoked_at is null")
      .bind(usedAt, id)
      .run();
  }
}

function readRuntimeTokenRow(row: RuntimeRow): RuntimeTokenRecord {
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

export class D1RuntimePolicyStore implements IRuntimePolicyStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async get(): Promise<RuntimePolicyRecord | undefined> {
    const row = await this.database
      .prepare("select value, updated_at from runtime_policy where id = 1")
      .first<RuntimeRow>();
    return row
      ? {
          rules: parseJson(readString(row, "value")),
          updatedAt: readString(row, "updated_at"),
        }
      : undefined;
  }

  async set(record: RuntimePolicyRecord): Promise<void> {
    await this.database
      .prepare(
        `
        insert into runtime_policy (id, value, updated_at)
        values (1, ?, ?)
        on conflict(id) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .bind(JSON.stringify(record.rules), record.updatedAt)
      .run();
  }
}

export class D1IdempotencyStore implements IIdempotencyStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    await this.database.prepare("delete from idempotency_records where expires_at <= ?").bind(input.now).run();

    const inserted = await this.database
      .prepare(
        `
        insert into idempotency_records (
          key_hash, claim_id, request_hash, state, response_value, created_at, expires_at
        )
        values (?, ?, ?, 'in_progress', null, ?, ?)
        on conflict(key_hash) do nothing
      `,
      )
      .bind(input.keyHash, input.claimId, input.requestHash, input.now, input.expiresAt)
      .run();
    if ((inserted.meta.changes ?? 0) > 0) {
      return { kind: "acquired" };
    }

    const row = await this.database
      .prepare("select request_hash, state, response_value from idempotency_records where key_hash = ?")
      .bind(input.keyHash)
      .first<RuntimeRow>();
    if (!row) {
      throw new Error("Idempotency record disappeared while claiming it.");
    }
    if (readString(row, "request_hash") !== input.requestHash) {
      return { kind: "conflict" };
    }
    if (readString(row, "state") === "in_progress") {
      return { kind: "in_progress" };
    }

    const response = parseRuntimeActionHttpResult(
      parseJson(await this.secretCodec.decode(readString(row, "response_value"))),
    );
    return { kind: "completed", response };
  }

  async complete(input: CompleteIdempotencyInput): Promise<boolean> {
    const result = await this.database
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
      .bind(
        await this.secretCodec.encode(JSON.stringify(input.response)),
        input.expiresAt,
        input.keyHash,
        input.claimId,
        input.requestHash,
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async abandon(input: AbandonIdempotencyInput): Promise<boolean> {
    const result = await this.database
      .prepare(
        `
        delete from idempotency_records
        where key_hash = ?
          and claim_id = ?
          and request_hash = ?
          and state = 'in_progress'
      `,
      )
      .bind(input.keyHash, input.claimId, input.requestHash)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class D1RunLogStore implements IRunLogStore {
  private readonly database: D1DatabaseBinding;
  private readonly limit: number;

  constructor(database: D1DatabaseBinding, limit: number) {
    this.database = database;
    this.limit = limit;
  }

  async add(run: RunLog): Promise<RunLogWriteResult> {
    await this.database
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
      .bind(
        run.id,
        run.service,
        run.actionId,
        run.caller,
        run.startedAt,
        run.completedAt,
        run.ok ? 1 : 0,
        JSON.stringify(run),
      )
      .run();

    try {
      await this.database
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
        .bind(this.limit)
        .run();
      return { retentionApplied: true };
    } catch {
      return { retentionApplied: false };
    }
  }

  async get(id: string): Promise<RunLog | undefined> {
    const row = await this.database
      .prepare("select service, value from runs where id = ?")
      .bind(id)
      .first<RuntimeRow>();
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
    const { results } = await this.database
      .prepare(`select service, value from runs ${where} order by started_at desc, id desc limit ?`)
      .bind(...values, limit + 1)
      .all<RuntimeRow>();
    const runs = results.map(readRunLogRow);
    const items = runs.slice(0, limit);

    return {
      items,
      nextCursor: runs.length > limit && items.length > 0 ? encodeRunLogCursor(items[items.length - 1]) : undefined,
    };
  }
}

export class D1FlowStore implements IFlowStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setFlow(flow: FlowDefinition): Promise<void> {
    await this.database
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
      .bind(flow.id, flow.status, flow.createdAt, flow.updatedAt, await this.encode(flow))
      .run();
  }

  async getFlow(id: string): Promise<FlowDefinition | undefined> {
    return await this.getById<FlowDefinition>("flows", id);
  }

  async listFlows(): Promise<FlowDefinition[]> {
    return await this.listValues<FlowDefinition>("select value from flows order by updated_at desc, id desc");
  }

  async deleteFlow(id: string): Promise<boolean> {
    await this.deleteTriggerState(id);
    const result = await this.database.prepare("delete from flows where id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async addRun(run: FlowRun): Promise<void> {
    await this.database
      .prepare(
        `
        insert into flow_runs (id, flow_id, status, started_at, updated_at, value)
        values (?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(run.id, run.flowId, run.status, run.startedAt, run.updatedAt, await this.encode(run))
      .run();
  }

  async updateRun(run: FlowRun): Promise<void> {
    await this.database
      .prepare("update flow_runs set status = ?, updated_at = ?, value = ? where id = ?")
      .bind(run.status, run.updatedAt, await this.encode(run), run.id)
      .run();
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
    await this.database
      .prepare(
        `
        insert into flow_steps (id, run_id, sequence, status, started_at, value)
        values (?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(step.id, step.runId, step.sequence, step.status, step.startedAt, await this.encode(step))
      .run();
  }

  async updateStep(step: FlowStep): Promise<void> {
    await this.database
      .prepare("update flow_steps set status = ?, value = ? where id = ?")
      .bind(step.status, await this.encode(step), step.id)
      .run();
  }

  async listSteps(runId: string): Promise<FlowStep[]> {
    return await this.listValues<FlowStep>(
      "select value from flow_steps where run_id = ? order by sequence, id",
      runId,
    );
  }

  async addApproval(approval: FlowApproval): Promise<void> {
    await this.database
      .prepare(
        `
        insert into flow_approvals (id, flow_id, run_id, step_id, status, requested_at, value)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        approval.id,
        approval.flowId,
        approval.runId,
        approval.stepId,
        approval.status,
        approval.requestedAt,
        await this.encode(approval),
      )
      .run();
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
    const result = await this.database
      .prepare("update flow_approvals set status = ?, value = ? where id = ? and status = ?")
      .bind(approval.status, await this.encode(approval), approval.id, expectedStatus)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async setTriggerState(state: FlowTriggerState): Promise<void> {
    await this.database
      .prepare(
        `
        insert into flow_trigger_states (id, updated_at, value)
        values (?, ?, ?)
        on conflict(id) do update set
          updated_at = excluded.updated_at,
          value = excluded.value
      `,
      )
      .bind(state.flowId, state.updatedAt, await this.encode(state))
      .run();
  }

  async getTriggerState(flowId: string): Promise<FlowTriggerState | undefined> {
    return await this.getById<FlowTriggerState>("flow_trigger_states", flowId);
  }

  async deleteTriggerState(flowId: string): Promise<void> {
    await this.database.prepare("delete from flow_trigger_states where id = ?").bind(flowId).run();
  }

  private async getById<T>(
    table: "flows" | "flow_runs" | "flow_steps" | "flow_approvals" | "flow_trigger_states",
    id: string,
  ): Promise<T | undefined> {
    const row = await this.database.prepare(`select value from ${table} where id = ?`).bind(id).first<RuntimeRow>();
    return row ? parseJson<T>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  private async listValues<T>(query: string, ...parameters: Array<string | number>): Promise<T[]> {
    const { results } = await this.database
      .prepare(query)
      .bind(...parameters)
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => parseJson<T>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }

  private encode(value: unknown): Promise<string> {
    return this.secretCodec.encode(JSON.stringify(value));
  }
}

export class D1FeedStore implements IFeedStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setThread(thread: FeedThread): Promise<void> {
    await this.database
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
      .bind(thread.id, thread.flowRunId, thread.updatedAt, await this.secretCodec.encode(JSON.stringify(thread)))
      .run();
  }

  async getThread(id: string): Promise<FeedThread | undefined> {
    const row = await this.database.prepare("select value from feed_threads where id = ?").bind(id).first<RuntimeRow>();
    return row ? parseJson<FeedThread>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listThreads(limit = 500): Promise<FeedThread[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const { results } = await this.database
      .prepare("select value from feed_threads order by updated_at desc, id desc limit ?")
      .bind(boundedLimit)
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => parseJson<FeedThread>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }
}

export class D1SynapseStore implements ISynapseStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setWorkspace(workspace: SynapseWorkspace): Promise<void> {
    await this.database
      .prepare(
        `
        insert into synapse_workspaces (id, updated_at, value)
        values (?, ?, ?)
        on conflict(id) do update set
          updated_at = excluded.updated_at,
          value = excluded.value
      `,
      )
      .bind(workspace.id, workspace.updatedAt, await this.secretCodec.encode(JSON.stringify(workspace)))
      .run();
  }

  async getWorkspace(id: string): Promise<SynapseWorkspace | undefined> {
    const row = await this.database
      .prepare("select value from synapse_workspaces where id = ?")
      .bind(id)
      .first<RuntimeRow>();
    return row ? parseJson<SynapseWorkspace>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listWorkspaces(limit = 100): Promise<SynapseWorkspace[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const { results } = await this.database
      .prepare("select value from synapse_workspaces order by updated_at desc, id desc limit ?")
      .bind(boundedLimit)
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => parseJson<SynapseWorkspace>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const result = await this.database.prepare("delete from synapse_workspaces where id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class D1TeamsGatewayStore implements ITeamsGatewayStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setAgent(agent: TeamsGatewayAgent): Promise<void> {
    await this.database
      .prepare(
        `insert into teams_gateway_agents (id, updated_at, value) values (?, ?, ?)
         on conflict(id) do update set updated_at = excluded.updated_at, value = excluded.value`,
      )
      .bind(agent.id, agent.updatedAt, await this.secretCodec.encode(JSON.stringify(agent)))
      .run();
  }

  async getAgent(id: string): Promise<TeamsGatewayAgent | undefined> {
    const row = await this.database
      .prepare("select value from teams_gateway_agents where id = ?")
      .bind(id)
      .first<RuntimeRow>();
    return row ? parseJson<TeamsGatewayAgent>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listAgents(): Promise<TeamsGatewayAgent[]> {
    const { results } = await this.database
      .prepare("select value from teams_gateway_agents order by updated_at desc, id desc limit 500")
      .all<RuntimeRow>();
    return Promise.all(
      results.map(async (row) => parseJson<TeamsGatewayAgent>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }

  async deleteAgent(id: string): Promise<boolean> {
    await this.database.prepare("delete from teams_gateway_contacts where agent_id = ?").bind(id).run();
    await this.database.prepare("delete from teams_gateway_threads where agent_id = ?").bind(id).run();
    await this.database.prepare("delete from teams_gateway_groups where agent_id = ?").bind(id).run();
    const result = await this.database.prepare("delete from teams_gateway_agents where id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async setThread(thread: TeamsGatewayThread): Promise<void> {
    await this.database
      .prepare(
        `insert into teams_gateway_threads (id, agent_id, chat_id, updated_at, value) values (?, ?, ?, ?, ?)
         on conflict(id) do update set agent_id = excluded.agent_id, chat_id = excluded.chat_id,
           updated_at = excluded.updated_at, value = excluded.value`,
      )
      .bind(
        thread.id,
        thread.agentId,
        thread.chatId,
        thread.updatedAt,
        await this.secretCodec.encode(JSON.stringify(thread)),
      )
      .run();
  }

  async getThread(agentId: string, chatId: string): Promise<TeamsGatewayThread | undefined> {
    const row = await this.database
      .prepare("select value from teams_gateway_threads where agent_id = ? and chat_id = ?")
      .bind(agentId, chatId)
      .first<RuntimeRow>();
    return row ? parseJson<TeamsGatewayThread>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listThreads(agentId?: string, limit = 100): Promise<TeamsGatewayThread[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const statement = agentId
      ? this.database
          .prepare(
            "select value from teams_gateway_threads where agent_id = ? order by updated_at desc, id desc limit ?",
          )
          .bind(agentId, boundedLimit)
      : this.database
          .prepare("select value from teams_gateway_threads order by updated_at desc, id desc limit ?")
          .bind(boundedLimit);
    const { results } = await statement.all<RuntimeRow>();
    return Promise.all(
      results.map(async (row) =>
        parseJson<TeamsGatewayThread>(await this.secretCodec.decode(readString(row, "value"))),
      ),
    );
  }

  async setContact(contact: TeamsGatewayContact): Promise<void> {
    await this.database
      .prepare(
        `insert into teams_gateway_contacts (id, agent_id, email, updated_at, value) values (?, ?, ?, ?, ?)
         on conflict(id) do update set agent_id = excluded.agent_id, email = excluded.email,
           updated_at = excluded.updated_at, value = excluded.value`,
      )
      .bind(
        contact.id,
        contact.agentId,
        contact.email,
        contact.lastInboundAt,
        await this.secretCodec.encode(JSON.stringify(contact)),
      )
      .run();
  }

  async getContact(agentId: string, email: string): Promise<TeamsGatewayContact | undefined> {
    const row = await this.database
      .prepare("select value from teams_gateway_contacts where agent_id = ? and email = ?")
      .bind(agentId, email.toLowerCase())
      .first<RuntimeRow>();
    return row ? parseJson<TeamsGatewayContact>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listContacts(agentId: string): Promise<TeamsGatewayContact[]> {
    const { results } = await this.database
      .prepare("select value from teams_gateway_contacts where agent_id = ? order by updated_at desc, id desc")
      .bind(agentId)
      .all<RuntimeRow>();
    return Promise.all(
      results.map(async (row) =>
        parseJson<TeamsGatewayContact>(await this.secretCodec.decode(readString(row, "value"))),
      ),
    );
  }

  async setGroup(group: TeamsGatewayGroup): Promise<void> {
    await this.database
      .prepare(
        `insert into teams_gateway_groups (id, agent_id, kind, external_id, updated_at, value)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set agent_id = excluded.agent_id, kind = excluded.kind,
           external_id = excluded.external_id, updated_at = excluded.updated_at, value = excluded.value`,
      )
      .bind(
        group.id,
        group.agentId,
        group.kind,
        group.externalId,
        group.updatedAt,
        await this.secretCodec.encode(JSON.stringify(group)),
      )
      .run();
  }

  async listGroups(agentId?: string): Promise<TeamsGatewayGroup[]> {
    const statement = agentId
      ? this.database
          .prepare("select value from teams_gateway_groups where agent_id = ? order by updated_at desc, id desc")
          .bind(agentId)
      : this.database.prepare("select value from teams_gateway_groups order by updated_at desc, id desc");
    const { results } = await statement.all<RuntimeRow>();
    return Promise.all(
      results.map(async (row) => parseJson<TeamsGatewayGroup>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }

  async deleteMissingGroups(agentId: string, retainedIds: string[]): Promise<void> {
    const retained = new Set(retainedIds);
    const groups = await this.listGroups(agentId);
    await Promise.all(
      groups
        .filter((group) => !retained.has(group.id))
        .map((group) => this.database.prepare("delete from teams_gateway_groups where id = ?").bind(group.id).run()),
    );
  }
}

export class D1KanbanStore implements IKanbanStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async setBoard(board: KanbanBoardDefinition): Promise<void> {
    await this.database
      .prepare(
        `
        insert into kanban_boards (id, updated_at, value)
        values (?, ?, ?)
        on conflict(id) do update set
          updated_at = excluded.updated_at,
          value = excluded.value
      `,
      )
      .bind(board.id, board.updatedAt, await this.secretCodec.encode(JSON.stringify(board)))
      .run();
  }

  async getBoard(id: string): Promise<KanbanBoardDefinition | undefined> {
    const row = await this.database
      .prepare("select value from kanban_boards where id = ?")
      .bind(id)
      .first<RuntimeRow>();
    return row ? parseJson<KanbanBoardDefinition>(await this.secretCodec.decode(readString(row, "value"))) : undefined;
  }

  async listBoards(limit = 100): Promise<KanbanBoardDefinition[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const { results } = await this.database
      .prepare("select value from kanban_boards order by updated_at desc, id desc limit ?")
      .bind(boundedLimit)
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) =>
        parseJson<KanbanBoardDefinition>(await this.secretCodec.decode(readString(row, "value"))),
      ),
    );
  }

  async deleteBoard(id: string): Promise<boolean> {
    const result = await this.database.prepare("delete from kanban_boards where id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class D1ConnectionApprovalStore implements IConnectionApprovalStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async replacePermissions(connectionId: string, permissions: ConnectionActionPermission[]): Promise<void> {
    await this.database
      .prepare("delete from connection_action_permissions where connection_id = ?")
      .bind(connectionId)
      .run();
    for (const permission of permissions) {
      await this.database
        .prepare(
          `insert into connection_action_permissions (id, connection_id, action_id, updated_at, value)
           values (?, ?, ?, ?, ?)`,
        )
        .bind(
          connectionPermissionId(connectionId, permission.actionId),
          connectionId,
          permission.actionId,
          permission.updatedAt,
          await this.encode(permission),
        )
        .run();
    }
  }

  async listPermissions(connectionId?: string): Promise<ConnectionActionPermission[]> {
    const statement = connectionId
      ? this.database
          .prepare("select value from connection_action_permissions where connection_id = ? order by action_id")
          .bind(connectionId)
      : this.database.prepare("select value from connection_action_permissions order by connection_id, action_id");
    const { results } = await statement.all<RuntimeRow>();
    return await this.decodeRows<ConnectionActionPermission>(results);
  }

  async getPermission(connectionId: string, actionId: string): Promise<ConnectionActionPermission | undefined> {
    return await this.getById<ConnectionActionPermission>(
      "connection_action_permissions",
      connectionPermissionId(connectionId, actionId),
    );
  }

  async addActionApproval(approval: ActionApproval): Promise<void> {
    await this.database
      .prepare("insert into action_approvals (id, status, request_hash, requested_at, value) values (?, ?, ?, ?, ?)")
      .bind(approval.id, approval.status, approval.requestHash, approval.requestedAt, await this.encode(approval))
      .run();
  }

  async getActionApproval(id: string): Promise<ActionApproval | undefined> {
    return await this.getById<ActionApproval>("action_approvals", id);
  }

  async listActionApprovals(limit = 500): Promise<ActionApproval[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const { results } = await this.database
      .prepare("select value from action_approvals order by requested_at desc, id desc limit ?")
      .bind(boundedLimit)
      .all<RuntimeRow>();
    return await this.decodeRows<ActionApproval>(results);
  }

  async findActionApproval(requestHash: string, status: ActionApprovalStatus): Promise<ActionApproval | undefined> {
    const row = await this.database
      .prepare(
        "select value from action_approvals where request_hash = ? and status = ? order by requested_at desc, id desc limit 1",
      )
      .bind(requestHash, status)
      .first<RuntimeRow>();
    return row ? await this.decode<ActionApproval>(readString(row, "value")) : undefined;
  }

  async updateActionApproval(approval: ActionApproval, expectedStatus: ActionApprovalStatus): Promise<boolean> {
    const result = await this.database
      .prepare("update action_approvals set status = ?, value = ? where id = ? and status = ?")
      .bind(approval.status, await this.encode(approval), approval.id, expectedStatus)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  private async getById<T>(
    table: "connection_action_permissions" | "action_approvals",
    id: string,
  ): Promise<T | undefined> {
    const row = await this.database.prepare(`select value from ${table} where id = ?`).bind(id).first<RuntimeRow>();
    return row ? await this.decode<T>(readString(row, "value")) : undefined;
  }

  private async decodeRows<T>(rows: RuntimeRow[]): Promise<T[]> {
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

async function getSecretJson<T>(
  database: D1DatabaseBinding,
  secretCodec: ISecretCodec,
  table: SecretJsonTable,
  service: string,
): Promise<T | undefined> {
  const row = await database.prepare(`select value from ${table} where service = ?`).bind(service).first<RuntimeRow>();
  return row ? parseJson<T>(await secretCodec.decode(readString(row, "value"))) : undefined;
}

function readString(row: RuntimeRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected D1 column ${key} to be a string.`);
  }

  return value;
}

function readRunLogRow(row: RuntimeRow): RunLog {
  const run = parseJson<RunLog>(readString(row, "value"));
  return { ...run, service: readString(row, "service") };
}

function readOptionalString(row: RuntimeRow, key: string): string | undefined {
  const value = row[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected D1 column ${key} to be a string.`);
  }

  return value;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
