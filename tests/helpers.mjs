// ── topmind Obsidian Plugin — Unit Tests (shared helpers) ──────────────────
//
// Honesty rule: pure-logic cases import the **shipped** TypeScript sources
// (Node --experimental-strip-types). Tests must not re-copy algorithms.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "..", "src");
const pluginRoot = path.join(__dirname, "..");

/** Import a shipped TypeScript source module via strip-types. */
async function importShipped(relFromSrc) {
  const abs = path.join(srcDir, relFromSrc);
  return import(pathToFileURL(abs).href);
}

export { fs, path, pathToFileURL, fileURLToPath, __dirname, srcDir, pluginRoot, importShipped };
