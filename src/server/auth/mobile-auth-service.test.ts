import type { IMobileAuthStore, MobileDeviceRecord, MobilePairingRecord } from "./mobile-auth-service.ts";

import { describe, expect, it } from "vitest";
import { hashMobileCredential, MobileAuthService } from "./mobile-auth-service.ts";

describe("MobileAuthService", () => {
  it("exchanges a one-time pairing code for a revocable persistent device token", async () => {
    const store = new MemoryMobileAuthStore();
    const service = new MobileAuthService(store);
    const created = await service.createPairing(" Zeke's phone ");

    expect(created.code).toMatch(/^ocmp_/);
    expect(created.pairing.name).toBe("Zeke's phone");
    expect(store.pairings[0]?.codeHash).toBe(hashMobileCredential(created.code));
    expect(JSON.stringify(store.pairings)).not.toContain(created.code);

    const exchanged = await service.exchangePairing(created.code, "Mozilla/5.0 (iPhone) Safari/605.1");
    expect(exchanged?.token).toMatch(/^ocmd_/);
    expect(exchanged?.device).toMatchObject({
      pairingId: created.pairing.id,
      name: "Zeke's phone",
      userAgent: "Mozilla/5.0 (iPhone) Safari/605.1",
    });
    expect(JSON.stringify(store.devices)).not.toContain(exchanged?.token);
    await expect(service.exchangePairing(created.code)).resolves.toBeUndefined();

    await expect(service.resolveDeviceToken(exchanged!.token)).resolves.toMatchObject({ id: exchanged!.device.id });
    await expect(service.revokeDevice(exchanged!.device.id)).resolves.toBe(true);
    await expect(service.resolveDeviceToken(exchanged!.token)).resolves.toBeUndefined();
  });

  it("rejects expired pairing codes and credentials with the wrong prefix", async () => {
    const store = new MemoryMobileAuthStore();
    const service = new MobileAuthService(store, { pairingTtlMs: -1 });
    const created = await service.createPairing("Expired phone");

    await expect(service.exchangePairing(created.code)).resolves.toBeUndefined();
    await expect(service.exchangePairing("admin-secret")).resolves.toBeUndefined();
    await expect(service.resolveDeviceToken("admin-secret")).resolves.toBeUndefined();
  });
});

class MemoryMobileAuthStore implements IMobileAuthStore {
  readonly pairings: MobilePairingRecord[] = [];
  readonly devices: MobileDeviceRecord[] = [];

  async addPairing(record: MobilePairingRecord): Promise<void> {
    this.pairings.push(record);
  }

  async takePairing(codeHash: string, now: string): Promise<MobilePairingRecord | undefined> {
    const index = this.pairings.findIndex((record) => record.codeHash === codeHash && record.expiresAt > now);
    return index < 0 ? undefined : this.pairings.splice(index, 1)[0];
  }

  async deletePairing(id: string): Promise<boolean> {
    const index = this.pairings.findIndex((record) => record.id === id);
    if (index < 0) return false;
    this.pairings.splice(index, 1);
    return true;
  }

  async addDevice(record: MobileDeviceRecord): Promise<void> {
    this.devices.push(record);
  }

  async listDevices(): Promise<MobileDeviceRecord[]> {
    return [...this.devices];
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<MobileDeviceRecord | undefined> {
    return this.devices.find((record) => record.tokenHash === tokenHash);
  }

  async deleteDevice(id: string): Promise<boolean> {
    const index = this.devices.findIndex((record) => record.id === id);
    if (index < 0) return false;
    this.devices.splice(index, 1);
    return true;
  }

  async markDeviceUsed(id: string, usedAt: string): Promise<void> {
    const device = this.devices.find((record) => record.id === id);
    if (device) device.lastUsedAt = usedAt;
  }
}
