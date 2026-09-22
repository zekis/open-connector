import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (target !== "local" && target !== "remote") {
  throw new Error("Usage: node scripts/migrate-d1.ts <local|remote>");
}

// Non-interactive execution prevents a declined prompt from returning success
// and allowing deployment to proceed without the required schema upgrade.
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
    "d1",
    "migrations",
    "apply",
    "DB",
    `--${target}`,
    "--config",
    "wrangler.local.jsonc",
  ],
  { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CI: "true" } },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
