import { build, Platform, Arch } from "electron-builder";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Stage outside the server workspace so electron-builder cannot collect server dependencies.
const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const stagePrefix = join(tmpdir(), "ocgw-desktop-build-");
const stage = await mkdtemp(stagePrefix);
try {
  for (const file of ["main.mjs", "navigation.mjs", "window-state.mjs", "assets"]) {
    await cp(join(root, file), join(stage, file), { recursive: true });
  }
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({
      name: manifest.name,
      productName: manifest.productName,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      type: "module",
      main: "main.mjs",
    }),
  );
  await build({
    projectDir: stage,
    targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
    publish: "never",
    config: {
      ...manifest.build,
      electronVersion: manifest.devDependencies.electron,
      npmRebuild: false,
      directories: { output: join(root, "dist") },
    },
  });
} finally {
  if (stage.startsWith(stagePrefix)) await rm(stage, { recursive: true, force: true });
}
