export interface TeamsGatewayJobResult<T> {
  value?: T;
  error?: unknown;
  stopReason?: "cancelled" | "timed_out" | "interrupted";
}

interface JobEntry {
  controller: AbortController;
  stopReason?: TeamsGatewayJobResult<unknown>["stopReason"];
  start(): Promise<void>;
}

/** Bounds background execution independently of Graph polling and conversation locks. */
export class TeamsGatewayJobs {
  private readonly entries = new Map<string, JobEntry>();
  private readonly queue: JobEntry[] = [];
  private running = 0;

  has(id: string): boolean {
    return this.entries.has(id);
  }

  run<T>(id: string, execute: (signal: AbortSignal) => Promise<T>): Promise<TeamsGatewayJobResult<T>> {
    let finish!: (result: TeamsGatewayJobResult<T>) => void;
    const result = new Promise<TeamsGatewayJobResult<T>>((resolve) => {
      finish = resolve;
    });
    const entry: JobEntry = {
      controller: new AbortController(),
      start: async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (entry.controller.signal.aborted) {
            finish({ stopReason: entry.stopReason });
            return;
          }
          timer = setTimeout(() => {
            if (entry.controller.signal.aborted) return;
            entry.stopReason = "timed_out";
            entry.controller.abort();
          }, 65 * 60_000);
          timer.unref?.();
          const value = await execute(entry.controller.signal);
          finish({ value, stopReason: entry.stopReason });
        } catch (error) {
          finish({ error, stopReason: entry.stopReason });
        } finally {
          if (timer) clearTimeout(timer);
          this.running--;
          this.pump();
        }
      },
    };
    this.entries.set(id, entry);
    this.queue.push(entry);
    this.pump();
    return result;
  }

  cancel(id: string, reason: JobEntry["stopReason"] = "cancelled"): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.stopReason = reason;
    entry.controller.abort();
    const queuedIndex = this.queue.indexOf(entry);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.running++;
      void entry.start();
    }
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  stop(): void {
    for (const entry of this.entries.values()) {
      entry.stopReason = "interrupted";
      entry.controller.abort();
    }
    for (const id of this.entries.keys()) this.cancel(id, "interrupted");
  }

  private pump(): void {
    while (this.running < 4 && this.queue.length) {
      const entry = this.queue.shift()!;
      this.running++;
      void entry.start();
    }
  }
}
