import type { ChildProcess } from "node:child_process";

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const dataDir = process.env.OOMOL_CONNECT_DATA_DIR ?? join(process.cwd(), "data");
const saynaCacheDir = join(dataDir, "sayna-cache");
mkdirSync(saynaCacheDir, { recursive: true });
if (readdirSync(saynaCacheDir).length === 0) {
  cpSync("/opt/sayna/cache", saynaCacheDir, { recursive: true, force: false });
}
const sayna = spawn("/opt/sayna/sayna", [], {
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    LD_LIBRARY_PATH: "/opt/sayna",
    RUST_LOG: process.env.SAYNA_LOG_LEVEL ?? "warn",
    HOST: "127.0.0.1",
    PORT: "3001",
    CACHE_PATH: saynaCacheDir,
  },
});
let stopping = false;
let exitCode = 0;
let connector: ChildProcess | undefined;

function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  terminate(sayna);
  if (connector) terminate(connector);
  setTimeout(() => process.exit(exitCode), 5_000).unref();
}

function terminate(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}

sayna.once("error", (error) => {
  console.error("Embedded Sayna failed to start.", error);
  stop(1);
});
sayna.once("exit", (code, signal) => {
  if (!stopping) console.error(`Embedded Sayna stopped unexpectedly (${signal ?? code ?? "unknown"}).`);
  stop(code ?? 1);
});

try {
  await waitForSayna();
} catch (error) {
  console.error("Embedded Sayna did not become ready.", error);
  stop(1);
  process.exit(1);
}

connector = spawn(process.execPath, ["src/server/index.ts"], {
  stdio: "inherit",
  env: process.env,
});
connector.once("error", (error) => {
  console.error("Open Connector failed to start.", error);
  stop(1);
});
connector.once("exit", (code, signal) => {
  if (!stopping && code) console.error(`Open Connector stopped unexpectedly (${signal ?? code}).`);
  stop(code ?? 0);
});

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

async function waitForSayna(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (stopping) throw new Error("Sayna stopped during startup.");
    if (await canConnectToSayna()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Sayna did not listen on port 3001 within 60 seconds.");
}

function canConnectToSayna(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 3001 });
    const finish = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
