import type { RuntimeLogger } from "../../core/types.ts";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface MobilePairingRecord {
  id: string;
  name: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface MobileDeviceRecord {
  id: string;
  pairingId: string;
  name: string;
  tokenHash: string;
  userAgent?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface MobileDeviceSummary {
  id: string;
  pairingId: string;
  name: string;
  userAgent?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface MobilePairingSummary {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
}

export interface MobilePairingCreation {
  code: string;
  pairing: MobilePairingSummary;
}

export interface MobilePairingExchange {
  token: string;
  device: MobileDeviceSummary;
}

export interface IMobileAuthStore {
  addPairing(record: MobilePairingRecord): Promise<void>;
  takePairing(codeHash: string, now: string): Promise<MobilePairingRecord | undefined>;
  deletePairing(id: string): Promise<boolean>;
  addDevice(record: MobileDeviceRecord): Promise<void>;
  listDevices(): Promise<MobileDeviceRecord[]>;
  findDeviceByTokenHash(tokenHash: string): Promise<MobileDeviceRecord | undefined>;
  deleteDevice(id: string): Promise<boolean>;
  markDeviceUsed(id: string, usedAt: string): Promise<void>;
}

const pairingCodePrefix = "ocmp_";
const mobileTokenPrefix = "ocmd_";
const defaultPairingTtlMs = 10 * 60 * 1000;
const maximumNameLength = 80;
const maximumUserAgentLength = 512;

/** Creates revocable, non-expiring browser credentials from one-time mobile pairing codes. */
export class MobileAuthService {
  private readonly store: IMobileAuthStore;
  private readonly pairingTtlMs: number;
  private readonly logger?: RuntimeLogger;

  constructor(store: IMobileAuthStore, options: { pairingTtlMs?: number; logger?: RuntimeLogger } = {}) {
    this.store = store;
    this.pairingTtlMs = options.pairingTtlMs ?? defaultPairingTtlMs;
    this.logger = options.logger;
  }

  async createPairing(name: string): Promise<MobilePairingCreation> {
    const normalizedName = normalizeDeviceName(name);
    const code = `${pairingCodePrefix}${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date();
    const record: MobilePairingRecord = {
      id: randomUUID(),
      name: normalizedName,
      codeHash: hashMobileCredential(code),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.pairingTtlMs).toISOString(),
    };
    await this.store.addPairing(record);
    return { code, pairing: summarizePairing(record) };
  }

  async exchangePairing(code: string, userAgent?: string): Promise<MobilePairingExchange | undefined> {
    if (!code.startsWith(pairingCodePrefix)) return undefined;
    const pairing = await this.store.takePairing(hashMobileCredential(code), new Date().toISOString());
    if (!pairing) return undefined;

    const token = `${mobileTokenPrefix}${randomBytes(32).toString("base64url")}`;
    const record: MobileDeviceRecord = {
      id: randomUUID(),
      pairingId: pairing.id,
      name: pairing.name,
      tokenHash: hashMobileCredential(token),
      userAgent: normalizeUserAgent(userAgent),
      createdAt: new Date().toISOString(),
    };
    await this.store.addDevice(record);
    return { token, device: summarizeDevice(record) };
  }

  async listDevices(): Promise<MobileDeviceSummary[]> {
    return (await this.store.listDevices()).map(summarizeDevice);
  }

  async resolveDeviceToken(token: string): Promise<MobileDeviceSummary | undefined> {
    if (!token.startsWith(mobileTokenPrefix)) return undefined;
    const tokenHash = hashMobileCredential(token);
    const record = await this.store.findDeviceByTokenHash(tokenHash);
    if (!record || !equalHashes(record.tokenHash, tokenHash)) return undefined;
    await this.recordLastUsed(record.id);
    return summarizeDevice(record);
  }

  async revokeDevice(id: string): Promise<boolean> {
    return this.store.deleteDevice(id);
  }

  async cancelPairing(id: string): Promise<boolean> {
    return this.store.deletePairing(id);
  }

  private async recordLastUsed(deviceId: string): Promise<void> {
    try {
      await this.store.markDeviceUsed(deviceId, new Date().toISOString());
    } catch (error) {
      this.logger?.warn({ deviceId, err: error }, "mobile device last use update failed");
    }
  }
}

export function hashMobileCredential(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function normalizeDeviceName(name: string): string {
  const normalized = name.trim();
  return (normalized || "Mobile browser").slice(0, maximumNameLength);
}

function normalizeUserAgent(userAgent: string | undefined): string | undefined {
  const normalized = userAgent?.trim();
  return normalized ? normalized.slice(0, maximumUserAgentLength) : undefined;
}

function summarizePairing(record: MobilePairingRecord): MobilePairingSummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function summarizeDevice(record: MobileDeviceRecord): MobileDeviceSummary {
  return {
    id: record.id,
    pairingId: record.pairingId,
    name: record.name,
    userAgent: record.userAgent,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function equalHashes(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
