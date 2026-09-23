#!/usr/bin/env node
/**
 * Link or copy the topmind engine lib/ into this repo so TypeScript can
 * resolve #kernel/* imports and humans can browse the sources.
 *
 * Resolution order for the engine:
 *   1. TOPMIND_SRC
 *   2. sibling ../topmind
 *   3. ./.topmind-src
 */
import { existsSync, rmSync, symlinkSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveEngineRoot() {
  const candidates = [
    process.env.TOPMIND_SRC,
    path.resolve(root, "..", "topmind"),
    path.resolve(root, ".topmind-src"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "lib", "kernel-api.mjs"))) return dir;
  }
  console.error(
    "[ensure-engine] Kernel source not found.\n" +
      "  Set TOPMIND_SRC=/path/to/topmind or clone topmindspace/topmind as ../topmind",
  );
  process.exit(1);
}

const engineRoot = resolveEngineRoot();
const engineLib = path.join(engineRoot, "lib");
const localLib = path.join(root, "lib");

// Replace any previous link/dir (never touch the engine itself).
if (existsSync(localLib) || true) {
  try {
    rmSync(localLib, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

try {
  symlinkSync(engineLib, localLib, "dir");
  console.log(`[ensure-engine] symlink lib → ${engineLib}`);
} catch {
  // Windows without symlink privilege: copy
  cpSync(engineLib, localLib, { recursive: true });
  console.log(`[ensure-engine] copied lib ← ${engineLib}`);
}

// Stamp for debugging / pack:verify
writeFileSync(
  path.join(root, ".engine-stamp.json"),
  JSON.stringify({ engineRoot, at: new Date().toISOString() }, null, 2) + "\n",
);

console.log(`[ensure-engine] engine: ${engineRoot}`);
console.log(readFileSync(path.join(engineLib, "kernel-api.mjs"), "utf8").split("\n")[0] || "");
