#!/usr/bin/env node
/**
 * Ensure topmind Kernel lib/ (+ templates/) is available for this repo so
 * TypeScript can resolve #kernel/* imports and esbuild can bundle the engine.
 *
 * Resolution order for a live engine source:
 *   1. TOPMIND_SRC
 *   2. sibling ../topmind
 *   3. ./.topmind-src
 *
 * If no live engine is found but this repo already vendors `lib/kernel-api.mjs`
 * (community-plugin clean builds, offline checkouts), keep the vendored copy
 * and succeed. Community review runs `npm run build` on a clean clone with no
 * sibling engine — the build must not require TOPMIND_SRC.
 *
 * When a live engine is found, lib/ and templates/ are refreshed from it
 * (copy, not symlink — portable on Windows and committable).
 */
import {
  existsSync,
  rmSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localLib = path.join(root, "lib");
const localTemplates = path.join(root, "templates");
const vendoredApi = path.join(localLib, "kernel-api.mjs");

function resolveEngineRoot() {
  const candidates = [
    process.env.TOPMIND_SRC,
    path.resolve(root, "..", "topmind"),
    path.resolve(root, ".topmind-src"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, "lib", "kernel-api.mjs"))) return dir;
  }
  return null;
}

function replaceDir(src, dest) {
  if (existsSync(dest)) {
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

const engineRoot = resolveEngineRoot();

if (engineRoot) {
  const engineLib = path.join(engineRoot, "lib");
  const engineTemplates = path.join(engineRoot, "templates");
  replaceDir(engineLib, localLib);
  if (existsSync(engineTemplates)) {
    replaceDir(engineTemplates, localTemplates);
  }
  writeFileSync(
    path.join(root, ".engine-stamp.json"),
    JSON.stringify({ engineRoot, source: "live", at: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log(`[ensure-engine] refreshed lib ← ${engineLib}`);
  console.log(`[ensure-engine] engine: ${engineRoot}`);
  const first = readFileSync(path.join(engineLib, "kernel-api.mjs"), "utf8").split("\n")[0] || "";
  if (first) console.log(first);
} else if (existsSync(vendoredApi)) {
  writeFileSync(
    path.join(root, ".engine-stamp.json"),
    JSON.stringify({ engineRoot: root, source: "vendored", at: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log(`[ensure-engine] using vendored lib/ (no live engine source)`);
} else {
  console.error(
    "[ensure-engine] Kernel source not found and lib/ is not vendored.\n" +
      "  Set TOPMIND_SRC=/path/to/topmind, clone topmindspace/topmind as ../topmind,\n" +
      "  or commit a snapshot of lib/ (community clean-build requirement).",
  );
  process.exit(1);
}
