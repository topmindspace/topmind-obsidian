// ── Kernel Loader: loads the topmind Kernel engines ────────────────────────
//
// In the bundled Obsidian plugin, the Kernel .mjs files are inlined by
// esbuild. We import from the relative path to the engine root's lib/
// directory. esbuild resolves and bundles these into main.js.
//
// Types below must match lib/kernel-api.mjs (+ model-stream / stream-period)
// — wrong shapes here hide real call bugs from tsc.

import type { AiProvider } from "./ai-provider";
import { getVaultBasePath, getEngineRoot } from "./vault-bridge.ts";

// Import Kernel API — esbuild bundles this from ../../lib/kernel-api.mjs
// (flat named exports). The ambient declaration types the namespace as KernelApi
// and must stay in sync with lib/kernel-api.mjs exports.
import * as kernelApiNs from "#kernel/kernel-api.mjs";
import type { KernelApi, KernelContext } from "./kernel-types.ts";

export type {
  StreamTargetResult,
  ListedStreamPeriod,
  ReconcilePeriodResult,
  ApplySuggestionResult,
  KernelContext,
  PreciseEditSpec,
  PreciseEditOk,
  PreciseEditFail,
  ReadWindowOpts,
  ReadWindowResult,
  KernelApi,
} from "./kernel-types.ts";

// ── Kernel result shapes (aligned with lib/) ───────────────────────────────

// Namespace import of the ambient module is typed; bind it without a second assertion.
const api: KernelApi = kernelApiNs as KernelApi;


/**
 * Load the Kernel API module.
 * In the bundled plugin, this is already inlined — no dynamic import needed.
 */
export function getKernel(): KernelApi {
  return api;
}

/**
 * Create a per-workspace kernel context bound to the Obsidian Vault.
 */
export function createKernelContext(
  vaultPath: string,
  engineRoot: string,
  aiProvider?: AiProvider | null,
  localeOverride?: string | null,
): KernelContext {
  return api.createKernelContext({
    workspaceRoot: vaultPath,
    engineRoot,
    aiProvider: aiProvider || undefined,
    localeOverride: localeOverride || undefined,
  });
}

/**
 * Convenience: create a kernel context from an Obsidian App instance.
 */
export function createKernelContextFromApp(
  app: import("obsidian").App,
  plugin: { manifest: { dir?: string } },
  aiProvider?: AiProvider | null,
  localeOverride?: string | null,
): KernelContext {
  const vaultPath = getVaultBasePath(app);
  const engineRoot = getEngineRoot(plugin);
  return createKernelContext(vaultPath, engineRoot, aiProvider, localeOverride);
}
