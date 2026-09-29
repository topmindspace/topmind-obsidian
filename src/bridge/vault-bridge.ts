// ── Vault Bridge: Obsidian Vault ↔ topmind workspace path mapping ──────────
//
// Obsidian Vault root = topmind workspace root.
// The Kernel engines use `import fs from "node:fs"` to access the file
// system directly, which works because Obsidian desktop runs in an
// Electron renderer with Node.js integration.
// esbuild platform:'node' keeps these as external require() calls.

import { resolve as pathResolve } from "node:path";
import type { App } from "obsidian";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Get the absolute path of the Obsidian Vault root (= topmind workspace root).
 * Uses the internal adapter's getBasePath() which is available on desktop.
 */
export function getVaultBasePath(app: App): string {
  // Internal desktop adapter API — stable on Electron, typed via a narrow shape.
  const adapter: unknown = app.vault.adapter;
  if (isRecord(adapter) && typeof adapter.getBasePath === "function") {
    const basePath: unknown = Reflect.apply(adapter.getBasePath, adapter, []);
    if (typeof basePath === "string" && basePath.length > 0) {
      return basePath;
    }
  }
  throw new Error(
    "Cannot resolve vault base path. This plugin requires Obsidian desktop (Electron).",
  );
}

/**
 * Get the engine root for template loading.
 * In the Obsidian plugin, the engine root is the plugin's directory,
 * where templates/ are copied alongside main.js.
 */
export function getEngineRoot(plugin: { manifest: { dir?: string } }): string {
  // plugin.manifest.dir is set by Obsidian to the plugin's absolute path
  return plugin.manifest.dir || "";
}

/**
 * Resolve a vault-relative path and assert it stays inside the vault root.
 * Community review scope guard: Node fs is allowed only under the workspace
 * root (plus the plugin's own dir via getEngineRoot). Throws on escape attempts
 * like `../` traversal or absolute-path substitution.
 */
export function resolveInsideVault(vaultRoot: string, rel: string): string {
  const root = pathResolve(vaultRoot);
  const abs = pathResolve(root, String(rel || ""));
  // Both sides are path.resolve-normalized (POSIX on macOS/Linux, \ on Windows).
  const sep = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(prefix)) {
    throw new Error(`path escapes vault root: ${String(rel)}`);
  }
  return abs;
}
