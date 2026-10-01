import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamsGatewayJobs } from "./teams-gateway-jobs.ts";

afterEach(() => vi.useRealTimers());

describe("TeamsGatewayJobs", () => {
  it("lets a job run for an hour and aborts at 65 minutes", async () => {
    vi.useFakeTimers();
    const jobs = new TeamsGatewayJobs();
    let signal!: AbortSignal;
    const result = jobs.run("job", async (value) => {
      signal = value;
      await new Promise<void>((resolve) => value.addEventListener("abort", () => resolve(), { once: true }));
      return "late result";
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await result).toMatchObject({ stopReason: "timed_out" });
  });

  it("bounds execution at four jobs and never executes a cancelled queued job", async () => {
    const jobs = new TeamsGatewayJobs();
    const release: Array<() => void> = [];
    let started = 0;
    const results = Array.from({ length: 6 }, (_, index) =>
      jobs.run(String(index), async () => {
        started++;
        await new Promise<void>((resolve) => release.push(resolve));
      }),
    );
    expect(started).toBe(4);
    jobs.cancel("4");
    expect(await results[4]).toMatchObject({ stopReason: "cancelled" });
    expect(started).toBe(4);
    release[0]!();
    await results[0];
    expect(await results[4]).toMatchObject({ stopReason: "cancelled" });
    expect(started).toBe(5);
    for (const finish of release) finish();
    await Promise.all(results);
  });

  it("aborts jobs on shutdown without losing late approval results", async () => {
    const jobs = new TeamsGatewayJobs();
    let release!: () => void;
    let signal!: AbortSignal;
    const result = jobs.run("job", async (value) => {
      signal = value;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { approvalId: "approval" };
    });
    jobs.stop();
    expect(signal.aborted).toBe(true);
    release();
    expect(await result).toMatchObject({ stopReason: "interrupted", value: { approvalId: "approval" } });
  });
});
