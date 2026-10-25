// ── Pure Kernel write-path operations (no Obsidian imports) ────────────────
//
// KernelService UI layer calls these. Unit/integration tests call them with a
// real Kernel API + temp workspace — no App/Notice required.

import fs from "node:fs";
import path from "node:path";
import { resolveInsideVault } from "../bridge/vault-bridge.ts";
import { acceptPendingWrite as acceptWorkspacePendingWrite } from "#kernel/pending-writes.mjs";
import { createHash } from "node:crypto";
import type { KernelApi } from "../bridge/kernel-loader.ts";
import {
  stripFrontmatter,
  extractFrontmatter,
  seedPeriodFrontmatter,
  sanitizeFileName,
  normalizeCaptureText,
  mergeCaptureTags,
  mapKernelTodoItem,
  isRecord,
  isUnknownArray,
  parseJsonUnknown,
} from "../utils.ts";
import type { StreamPeriod, TodoItem } from "../types.ts";
import {
  stashPendingWrite,
  takePendingWrite,
  listPendingWrites,
  rejectPendingWrite,
  restorePendingWrite,
} from "./pending-writes.ts";
import { resolvesOutsideVaultSync } from "#kernel/vault-walk.mjs";
import { isSafeRel } from "./workspace-agent-tools.ts";
import { sanitizeAiWriteBody } from "#kernel/ai-content-sanitize.mjs";

import { resolveEmbeddedTemplate } from "../data/workspace-templates.ts";

export {
  listPendingWrites,
  rejectPendingWrite,
  restorePendingWrite,
  stashPendingWrite,
  takePendingWrite,
};

export interface CaptureOpts {
  target?: "stream" | "inbox";
  tags?: string[];
  writebackMode?: "auto" | "confirm";
  /** Standalone file instead of appending the stream period note (Desktop forceAtom parity). */
  forceAtom?: boolean;
}

/**
 * Capture text to stream period note or inbox via Kernel writeback.
 * Uses resolveStreamTarget.periodRelPath / periodAbsPath (not invented `relPath`).
 */
export function captureToWorkspace(
  kernel: KernelApi,
  workspaceRoot: string,
  engineRoot: string,
  text: string,
  opts: CaptureOpts = {},
): { ok: boolean; path?: string; error?: string } {
  if (!fs.existsSync(path.join(workspaceRoot, "topmind.yaml"))) {
    return { ok: false, error: "workspace-not-ready" };
  }

  const normalized = normalizeCaptureText(text);
  if (!normalized.ok || !normalized.text) {
    return { ok: false, error: normalized.error || "empty-text" };
  }
  const safeText = normalized.text;
  const captureContent = mergeCaptureTags(safeText, opts.tags);

  try {
    const contract = kernel.loadContract(workspaceRoot);
    const model = kernel.resolveWorkspaceModel({
      workspaceRoot,
      engineRoot,
      config: contract,
    });
    const target = opts.target || "stream";

    let relPath: string;
    let content: string;
    let targetPath: string;

    if (target === "stream") {
      const streamCat = kernel.findStreamCategory(model);
      if (!streamCat) {
        return { ok: false, error: "no-stream-category" };
      }

      // forceAtom: one standalone note under the stream category (Desktop parity).
      if (opts.forceAtom) {
        const catDir = streamCat.directory;
        const stamp = Date.now();
        const slug = sanitizeFileName(safeText.slice(0, 40)) || "note";
        relPath = `${catDir}/${stamp}-${slug}.md`;
        targetPath = resolveInsideVault(workspaceRoot, relPath);
        content = `---\nsource_type: external-capture\ncreated: ${new Date().toISOString()}\ntags: [${(opts.tags || []).join(", ")}]\n---\n\n# ${safeText.slice(0, 80)}\n\n${captureContent}\n`;
      } else {
        const streamTarget = kernel.resolveStreamTarget({
          workspaceRoot,
          engineRoot,
          config: contract,
        });
        if (!streamTarget.periodRelPath || !streamTarget.periodAbsPath) {
          return {
            ok: false,
            error:
              streamTarget.packing === "atom"
                ? "atom-packing"
                : "no-period-path",
          };
        }
        relPath = streamTarget.periodRelPath;
        targetPath = streamTarget.periodAbsPath;
        const packing = streamTarget.packing || "weekly";
        const appendHeading = streamTarget.appendHeading || "day";

        const raw = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf-8") : "";
        const body = stripFrontmatter(raw);
        const newBody = kernel.appendToPeriodBody(body, {
          content: captureContent,
          packing,
          appendHeading,
        });
        const fm = extractFrontmatter(raw) || seedPeriodFrontmatter(relPath);
        content = `${fm}${newBody}`;
      }
    } else {
      const buffer = model.categories.find((c) => c.role === "buffer" && c.directory);
      let inboxDir = buffer?.directory;
      if (!inboxDir) {
        try {
          inboxDir = fs.readdirSync(workspaceRoot, { withFileTypes: true })
            .find((e) => e.isDirectory() && /^00[ -]/.test(e.name))?.name;
        } catch {
          inboxDir = undefined;
        }
      }
      inboxDir = inboxDir || "00-Inbox";
      relPath = `${inboxDir}/${Date.now()}-${sanitizeFileName(safeText.slice(0, 30))}.md`;
      targetPath = resolveInsideVault(workspaceRoot, relPath);
      content = `---\nsource_type: external-capture\ncreated: ${new Date().toISOString()}\ntags: [${(opts.tags || []).join(", ")}]\n---\n\n# ${safeText.slice(0, 80)}\n\n${captureContent}\n`;
    }

    const isUpdate = fs.existsSync(targetPath);
    const result = kernel.executeWrite({
      targetPath,
      content,
      workspaceRoot,
      contract,
      operation: isUpdate ? "update" : "create",
      actor: "user",
      confirmed: true,
      skipShadow: true,
      writebackModeOverride: opts.writebackMode,
    });

    if (result.pending) {
      return { ok: false, error: "pending-confirmation" };
    }
    return { ok: true, path: relPath.replace(/\\/g, "/") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function resolveInboxDirectory(
  kernel: KernelApi,
  workspaceRoot: string,
  engineRoot: string,
): string {
  try {
    const contract = kernel.loadContract(workspaceRoot);
    const model = kernel.resolveWorkspaceModel({
      workspaceRoot,
      engineRoot,
      config: contract,
    });
    const buffer = model.categories.find((c) => c.role === "buffer" && c.directory);
    if (buffer?.directory) return buffer.directory;
  } catch {
    /* fall through */
  }
  try {
    const found = fs
      .readdirSync(workspaceRoot, { withFileTypes: true })
      .find((e) => e.isDirectory() && /^00[ -]/.test(e.name))?.name;
    if (found) return found;
  } catch {
    /* fall through */
  }
  return "00-Inbox";
}

/**
 * Create an untitled inbox note via Kernel writeback (user actor, confirmed).
 */
export function createInboxNoteInWorkspace(
  kernel: KernelApi,
  workspaceRoot: string,
  engineRoot: string,
  opts: { now?: Date } = {},
): { ok: boolean; path?: string; error?: string } {
  if (!fs.existsSync(path.join(workspaceRoot, "topmind.yaml"))) {
    return { ok: false, error: "workspace-not-ready" };
  }
  try {
    const contract = kernel.loadContract(workspaceRoot);
    const inboxDir = resolveInboxDirectory(kernel, workspaceRoot, engineRoot);
    // Containment before mkdir — never create dirs outside the workspace.
    const absDir = resolveInsideVault(workspaceRoot, inboxDir);
    fs.mkdirSync(absDir, { recursive: true });
    const now = opts.now instanceof Date ? opts.now : new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    let fileName = `Untitled-${ts}.md`;
    let relPath = `${inboxDir}/${fileName}`.replace(/\\/g, "/");
    let counter = 1;
    while (fs.existsSync(path.join(workspaceRoot, relPath))) {
      fileName = `Untitled-${ts}-${counter}.md`;
      relPath = `${inboxDir}/${fileName}`.replace(/\\/g, "/");
      counter += 1;
    }
    const title = fileName.replace(/\.md$/iu, "");
    const content = `---\ncreated: ${now.toISOString()}\n---\n\n# ${title}\n\n`;
    const result = kernel.executeWrite({
      targetPath: resolveInsideVault(workspaceRoot, relPath),
      content,
      workspaceRoot,
      contract,
      operation: "create",
      actor: "user",
      confirmed: true,
      skipShadow: true,
    });
    if (result.pending) return { ok: false, error: "pending-confirmation" };
    return { ok: true, path: relPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Accept a stashed confirm-mode write and persist via Kernel writeback.
 */
export function acceptPendingWrite(
  kernel: KernelApi,
  workspaceRoot: string,
  id: string,
): { ok: boolean; path?: string; error?: string } {
  try {
    const result = acceptWorkspacePendingWrite(workspaceRoot, id);
    return { ok: result.ok, path: result.relativePath, error: result.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List stream periods via Kernel async listStreamPeriods(options object).
 */
export async function listStreamPeriodsForWorkspace(
  kernel: KernelApi,
  workspaceRoot: string,
  engineRoot: string,
): Promise<{ periods: StreamPeriod[]; current: StreamPeriod | null }> {
  try {
    const contract = kernel.loadContract(workspaceRoot);
    const model = kernel.resolveWorkspaceModel({
      workspaceRoot,
      engineRoot,
      config: contract,
    });
    if (!kernel.findStreamCategory(model)) {
      return { periods: [], current: null };
    }

    const listed = await kernel.listStreamPeriods({
      workspaceRoot,
      engineRoot,
      config: contract,
      limit: 50,
    });

    const periods: StreamPeriod[] = listed.map((p) => {
      const fileName = p.fileName || path.basename(p.relPath || "");
      const period = fileName.replace(/\.md$/iu, "");
      const mtimeMs = p.mtime ? Date.parse(p.mtime) : 0;
      return {
        period,
        relPath: p.relPath,
        title: p.title || period,
        entryCount: 0,
        mtime: Number.isFinite(mtimeMs) ? mtimeMs : 0,
        reconciled: p.reconciled !== false,
      };
    });
    return { periods, current: periods[0] || null };
  } catch {
    return { periods: [], current: null };
  }
}

/**
 * Reconcile period note via Kernel reconcilePeriodBody(body, opts) → { changed }.
 */
export function reconcilePeriodNote(
  kernel: KernelApi,
  workspaceRoot: string,
  engineRoot: string,
  relPath: string,
  opts: { writebackMode?: "auto" | "confirm" } = {},
): { ok: boolean; reconciled: boolean; error?: string } {
  try {
    const contract = kernel.loadContract(workspaceRoot);
    const absPath = path.join(workspaceRoot, relPath);
    if (!fs.existsSync(absPath)) {
      return { ok: false, reconciled: false, error: "period note not found" };
    }

    const raw = fs.readFileSync(absPath, "utf-8");
    const fm = extractFrontmatter(raw) || seedPeriodFrontmatter(relPath);
    const body = stripFrontmatter(raw);

    const streamTarget = kernel.resolveStreamTarget({
      workspaceRoot,
      engineRoot,
      config: contract,
    });
    const packing = streamTarget.packing || "weekly";
    const appendHeading = streamTarget.appendHeading || "day";

    const result = kernel.reconcilePeriodBody(body, { packing, appendHeading });
    if (!result.changed) {
      return { ok: true, reconciled: false };
    }

    const content = `${fm}${result.body}`;
    kernel.executeWrite({
      targetPath: absPath,
      content,
      workspaceRoot,
      contract,
      operation: "update",
      actor: "user",
      confirmed: true,
      skipShadow: true,
      writebackModeOverride: opts.writebackMode,
    });
    return { ok: true, reconciled: true };
  } catch (err) {
    return {
      ok: false,
      reconciled: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Read todos with Kernel `done` field mapping. */
export function readTodosFromWorkspace(
  kernel: KernelApi,
  workspaceRoot: string,
): TodoItem[] {
  try {
    const list = kernel.readTodoList(workspaceRoot);
    if (!list) return [];
    const items = isUnknownArray(list.items) ? list.items.filter(isRecord) : [];
    return items.map(mapKernelTodoItem);
  } catch {
    return [];
  }
}

/**
 * First-time template seed: create all NN- dirs from templates/{id}.json
 * when vault has none (Desktop parity).
 */
export function seedFullTemplateIfEmpty(
  workspaceRoot: string,
  engineRoot: string,
  templateId: string,
): string[] {
  let discovered: string[] = [];
  try {
    discovered = fs
      .readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{2}[ -].+/u.test(e.name))
      .map((e) => e.name);
  } catch {
    discovered = [];
  }
  if (discovered.length > 0) return [];

  const sep = "-";
  let categories: Record<string, { name: string }> | null = null;
  // Prefer disk templates (manual zip / engine refresh); fall back to the
  // copy bundled into main.js so community installs (3-file download) still seed.
  const tplPath = path.join(engineRoot, "templates", `${templateId}.json`);
  try {
    if (fs.existsSync(tplPath)) {
      const parsed = parseJsonUnknown(fs.readFileSync(tplPath, "utf-8"));
      if (isRecord(parsed) && isRecord(parsed.categories)) {
        const cats: Record<string, { name: string }> = {};
        for (const [slot, def] of Object.entries(parsed.categories)) {
          if (isRecord(def) && typeof def.name === "string") {
            cats[slot] = { name: def.name };
          }
        }
        if (Object.keys(cats).length > 0) categories = cats;
      }
    }
  } catch {
    categories = null;
  }
  if (!categories) {
    const embedded = resolveEmbeddedTemplate(templateId);
    if (embedded?.categories) categories = embedded.categories;
  }
  if (!categories) {
    categories = {
      "00": { name: "Inbox" },
      "10": { name: "动态" },
      "20": { name: "专题" },
      "88": { name: "交付" },
      "99": { name: "归档" },
    };
  }
  const created: string[] = [];
  for (const [slot, def] of Object.entries(categories)) {
    const dirName = `${slot}${sep}${def.name}`;
    const abs = path.join(workspaceRoot, dirName);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      created.push(dirName);
    }
  }
  return created;
}

/**
 * Initialize workspace: full template seed if empty + Kernel ensureRequiredStructure
 * (which runs ensureContract). Same contract path as Desktop/UTR — no private seed YAML.
 */
export function initWorkspaceStructure(
  kernel: KernelApi,
  workspaceRoot: string,
  engineRoot: string,
  templateId: string = "stream",
): {
  ok: boolean;
  error?: string;
  created?: string[];
  contractStatus?: string;
  contractOnDiskValid?: boolean;
  contractErrors?: string[];
  recovery?: string;
} {
  try {
    const created = seedFullTemplateIfEmpty(workspaceRoot, engineRoot, templateId);
    const ensured = kernel.ensureRequiredStructure(workspaceRoot, {
      engineRoot,
      templateId,
    });
    const onDiskValid = ensured.contractOnDiskValid !== false;
    if (!onDiskValid) {
      return {
        ok: false,
        created,
        contractStatus: ensured.contractStatus,
        contractOnDiskValid: false,
        contractErrors: ensured.contractErrors || [],
        recovery:
          "Contract unrepairable — use Kernel reseedContract (backs up bad topmind.yaml; content dirs kept) or repair manually.",
        error:
          (ensured.contractErrors && ensured.contractErrors[0]) ||
          "topmind.yaml is unrepairable",
      };
    }
    return {
      ok: true,
      created,
      contractStatus: ensured.contractStatus,
      contractOnDiskValid: true,
      contractErrors: ensured.contractErrors || [],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** User-triggered recovery: backup bad contract + write fresh v4 defaults. */
export function reseedWorkspaceContract(
  kernel: KernelApi,
  workspaceRoot: string,
  opts: { templateId?: string; locale?: string } = {},
): { ok: boolean; error?: string; backupPath?: string | null; status?: string } {
  try {
    if (typeof kernel.reseedContract !== "function") {
      return { ok: false, error: "Kernel reseedContract not available" };
    }
    const result = kernel.reseedContract(workspaceRoot, opts);
    return {
      ok: result.onDiskValid === true,
      backupPath: result.backupPath ?? null,
      status: result.status,
      error: result.onDiskValid ? undefined : "reseed failed",
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read operational writeback.mode from topmind.yaml (not plugin data.json). */
export function resolveContractWritebackMode(
  kernel: KernelApi,
  workspaceRoot: string,
): "auto" | "confirm" | null {
  try {
    const contract = kernel.loadContract(workspaceRoot);
    const writeback = isRecord(contract.writeback) ? contract.writeback : undefined;
    const mode = writeback?.mode;
    if (mode === "auto" || mode === "confirm") return mode;
  } catch {
    /* missing or unreadable contract */
  }
  return null;
}

/**
 * Mirror Settings writeback dropdown into workspace topmind.yaml.
 * Plugin data.json stays a display cache only.
 */
export function mirrorWritebackModeToContract(
  kernel: KernelApi,
  workspaceRoot: string,
  mode: "auto" | "confirm",
): { ok: boolean; error?: string } {
  if (mode !== "auto" && mode !== "confirm") {
    return { ok: false, error: "invalid-mode" };
  }
  if (typeof kernel.writeContract !== "function") {
    return { ok: false, error: "Kernel writeContract not available" };
  }
  if (!fs.existsSync(path.join(workspaceRoot, "topmind.yaml"))) {
    return { ok: false, error: "workspace-not-ready" };
  }
  try {
    const current = kernel.loadContract(workspaceRoot);
    const prevWriteback = isRecord(current.writeback) ? current.writeback : {};
    kernel.writeContract(workspaceRoot, {
      ...current,
      writeback: { ...prevWriteback, mode },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function resolveInsideWorkspace(
  kernel: KernelApi,
  workspaceRoot: string,
  relativePath: string,
): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  const rel = String(relativePath || "").replace(/\\/gu, "/").replace(/^\/+/u, "");
  if (!rel || rel.includes("..")) {
    return { ok: false, error: "invalid-relative-path" };
  }
  const abs = path.resolve(workspaceRoot, rel);
  if (typeof kernel.isPathInsideWorkspace === "function") {
    if (!kernel.isPathInsideWorkspace(workspaceRoot, abs)) {
      return { ok: false, error: "path-outside-workspace" };
    }
  } else {
    const root = path.resolve(workspaceRoot);
    const inside = abs === root ? false : !path.relative(root, abs).startsWith("..");
    if (!inside) return { ok: false, error: "path-outside-workspace" };
  }
  return { ok: true, abs, rel };
}

export interface WorkspaceReadOpts {
  relativePath: string;
  offset?: number;
  limit?: number;
  around?: string;
  heading?: string;
  contextLines?: number;
}

/**
 * Kernel-backed windowed read (numbered lines + around/heading).
 * Same contract as Desktop `read_file` / `readPathWindow`.
 */
export function readWorkspaceWindow(
  kernel: KernelApi,
  workspaceRoot: string,
  opts: WorkspaceReadOpts,
): {
  ok: boolean;
  error?: string;
  contentHash?: string;
  window?: ReturnType<NonNullable<KernelApi["formatReadWindow"]>>;
} {
  const loc = resolveInsideWorkspace(kernel, workspaceRoot, opts.relativePath);
  if (!loc.ok) return { ok: false, error: loc.error };
  if (!fs.existsSync(loc.abs) || !fs.statSync(loc.abs).isFile()) {
    return { ok: false, error: "file-not-found" };
  }
  if (typeof kernel.formatReadWindow !== "function") {
    return { ok: false, error: "kernel-formatReadWindow-missing" };
  }
  const full = fs.readFileSync(loc.abs, "utf-8");
  const contentHash = createHash("sha256").update(full, "utf8").digest("hex").slice(0, 16);
  const win = kernel.formatReadWindow(full, {
    relativePath: loc.rel,
    offset: opts.offset,
    limit: opts.limit,
    around: opts.around,
    heading: opts.heading,
    contextLines: opts.contextLines,
    maxLimit: 5000,
    maxChars: 80_000,
  });
  return { ok: true, window: win, contentHash };
}

export interface WorkspaceEditOpts {
  relativePath: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  startLine?: number;
  endLine?: number;
  heading?: string;
  /** Optimistic concurrency: contentHash from the latest read/edit of this file. */
  expectedHash?: string;
  actor?: "user" | "ai";
  confirmed?: boolean;
  writebackMode?: "auto" | "confirm";
}

/**
 * Kernel-backed unique-span edit + writeback-engine.
 * Same match/refuse/diagnostic contract as Desktop `pathOps.editPath`.
 */
export function preciseEditWorkspace(
  kernel: KernelApi,
  workspaceRoot: string,
  opts: WorkspaceEditOpts,
): {
  ok: boolean;
  error?: string;
  diagnostic?: string;
  reason?: string;
  count?: number;
  pending?: boolean;
  needsConfirm?: boolean;
  pendingId?: string;
  targetPath?: string;
  replacements?: number;
  matchMode?: string;
  wroteFiles?: boolean;
  contentHash?: string;
  postEditWindow?: { startLine: number; endLine: number; totalLines: number; content: string };
  note?: string;
} {
  if (!opts.relativePath?.endsWith(".md")) {
    return { ok: false, error: "md-only", reason: "md-only" };
  }
  const loc = resolveInsideWorkspace(kernel, workspaceRoot, opts.relativePath);
  if (!loc.ok) return { ok: false, error: loc.error, reason: loc.error };
  if (!fs.existsSync(loc.abs)) {
    return { ok: false, error: "file-not-found", reason: "file-not-found" };
  }
  if (typeof kernel.applyUniqueSpan !== "function") {
    return { ok: false, error: "kernel-applyUniqueSpan-missing", reason: "missing-matcher" };
  }
  const old = fs.readFileSync(loc.abs, "utf-8");
  // Strip thinking/meta and block JSON/thinking dumps on the replacement body.
  const allowJson = /\.(?:json|jsonc|ya?ml|toml|ini|cfg|conf)$/iu.test(loc.rel);
  const sanitizedNew = sanitizeAiWriteBody(opts.newText, { allowJson });
  if (!sanitizedNew.ok) {
    return {
      ok: false,
      error: `write-blocked:${sanitizedNew.reason}`,
      reason: sanitizedNew.reason,
      targetPath: loc.rel,
      replacements: 0,
      wroteFiles: false,
      note: "Write blocked: payload looked like AI thinking/JSON dump. Reply with the real body only.",
    };
  }
  // Optimistic concurrency: refuse when the file changed since the model last read it.
  // Soft expectedHash (AI 编辑宽松, Desktop pathOps parity): a stale hash must
  // not block a still-valid unique-span edit. Hard reject only when the matcher
  // cannot find oldText either.
  let hashStale = false;
  if (typeof opts.expectedHash === "string" && opts.expectedHash.trim()) {
    const currentHash = createHash("sha256").update(old, "utf8").digest("hex").slice(0, 16);
    if (currentHash !== opts.expectedHash.trim()) {
      hashStale = true;
    }
  }
  const applied = kernel.applyUniqueSpan(old, {
    oldText: opts.oldText,
    newText: sanitizedNew.text,
    replaceAll: Boolean(opts.replaceAll),
    startLine: opts.startLine,
    endLine: opts.endLine,
    heading: opts.heading,
    path: loc.rel,
  });
  if (!applied.ok) {
    if (hashStale) {
      return {
        ok: false,
        error: "hash-mismatch",
        reason: "hash-mismatch",
        diagnostic: `File changed since last read (expectedHash mismatch): ${loc.rel}. Re-read with read_file to refresh contentHash/oldText, then retry.`,
        targetPath: loc.rel,
        replacements: 0,
        wroteFiles: false,
      };
    }
    return {
      ok: false,
      error: applied.reason,
      reason: applied.reason,
      count: applied.count,
      diagnostic: applied.diagnostic,
      targetPath: loc.rel,
      replacements: 0,
      wroteFiles: false,
    };
  }
  if (applied.next === old) {
    return {
      ok: true,
      targetPath: loc.rel,
      replacements: 0,
      matchMode: applied.mode,
      wroteFiles: false,
    };
  }
  try {
    const contract = kernel.loadContract(workspaceRoot);
    const result = kernel.executeWrite({
      targetPath: loc.abs,
      content: applied.next,
      workspaceRoot,
      contract,
      operation: "edit",
      actor: opts.actor || "ai",
      confirmed: opts.confirmed === true,
      skipShadow: true,
      writebackModeOverride: opts.writebackMode,
    });
    if (result.pending) {
      let pendingId: string | undefined;
      try {
        pendingId = stashPendingWrite({
          workspaceRoot,
          relativePath: loc.rel,
          content: applied.next,
          toolName: "edit_file",
        }).id;
      } catch {
        pendingId = undefined;
      }
      return {
        ok: false,
        pending: true,
        needsConfirm: true,
        pendingId,
        targetPath: loc.rel,
        replacements: 0,
        matchMode: applied.mode,
        wroteFiles: false,
        error: "pending-confirmation",
        reason: "pending",
      };
    }
    // Fresh numbered window around the first replacement so multi-step edits
    // can continue without stale line numbers (Desktop postEditWindow parity).
    let postEditWindow: { startLine: number; endLine: number; totalLines: number; content: string } | undefined;
    try {
      const firstSpan = applied.spans?.[0];
      if (firstSpan && typeof kernel.formatReadWindow === "function") {
        const before = applied.next.slice(0, firstSpan.start);
        const startLine = before.split("\n").length;
        const win = kernel.formatReadWindow(applied.next, {
          relativePath: loc.rel,
          offset: Math.max(1, startLine - 8),
          limit: 32,
          maxLimit: 80,
          maxChars: 8000,
        });
        if (win && !win.empty) {
          postEditWindow = {
            startLine: win.startLine,
            endLine: win.endLine,
            totalLines: win.totalLines,
            content: win.numbered || win.content || "",
          };
        }
      }
    } catch {
      /* best-effort */
    }
    return {
      ok: true,
      targetPath: loc.rel,
      replacements: applied.replacements,
      matchMode: applied.mode,
      wroteFiles: result.wroteFiles !== false,
      contentHash: createHash("sha256").update(applied.next, "utf8").digest("hex").slice(0, 16),
      postEditWindow,
      note: hashStale ? "expectedHash was stale; unique-span still matched and was applied" : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      reason: "write-failed",
      targetPath: loc.rel,
      wroteFiles: false,
    };
  }
}

export interface WorkspaceAppendStreamOpts {
  actor?: "user" | "ai";
  relativePath: string;
  content: string;
  heading?: string;
  startLine?: number;
  endLine?: number;
  anchorText?: string;
  writebackMode?: string;
}

/**
 * Append a comment-like continuation under a stream entry in Obsidian (1:1 with Desktop).
 */
export function appendStreamEntryToWorkspace(
  kernel: KernelApi,
  workspaceRoot: string,
  contract: Record<string, unknown> | undefined,
  opts: WorkspaceAppendStreamOpts,
): { ok: boolean; path?: string; pending?: boolean; needsConfirm?: boolean; error?: string } {
  const rel = String(opts.relativePath || "").replace(/\\/g, "/");
  const text = String(opts.content || "").trim();
  if (!text) return { ok: false, error: "Content cannot be empty" };

  if (!rel || !isSafeRel(rel)) return { ok: false, error: "unsafe-path" };
  const targetPath = resolveInsideVault(workspaceRoot, rel);
  if (resolvesOutsideVaultSync(workspaceRoot, targetPath)) return { ok: false, error: "unsafe-path" };
  if (!fs.existsSync(targetPath)) {
    return { ok: false, error: `File not found: ${rel}` };
  }

  const raw = fs.readFileSync(targetPath, "utf-8");
  const appendFn =
    typeof kernel.appendToStreamEntryDetailed === "function"
      ? kernel.appendToStreamEntryDetailed.bind(kernel)
      : (body: string, o: unknown) => ({
          body: typeof kernel.appendToStreamEntry === "function" ? kernel.appendToStreamEntry(body, o) : body,
          location: { appendedAt: "end" },
        });

  const { body: next } = appendFn(raw, {
    heading: opts.heading ? String(opts.heading) : undefined,
    content: text,
    date: new Date(),
    startLine: typeof opts.startLine === "number" ? opts.startLine : undefined,
    endLine: typeof opts.endLine === "number" ? opts.endLine : undefined,
    anchorText: typeof opts.anchorText === "string" && opts.anchorText.trim() ? String(opts.anchorText) : undefined,
  });

  if (next === raw) {
    return { ok: false, error: "No changes produced by append" };
  }

  const result = kernel.executeWrite({
    targetPath,
    content: next,
    workspaceRoot,
    contract,
    operation: "update",
    actor: opts.actor || "user",
    confirmed: true,
    skipShadow: true,
    writebackModeOverride: opts.writebackMode === "confirm" ? "confirm" : "auto",
  });

  if (result.pending || result.needsConfirm) {
    // pending is not success — UI must distinguish await-confirm from written.
    return { ok: false, path: rel, pending: true, needsConfirm: true, error: "pending-confirmation" };
  }
  // executeWrite surface evidence sets wroteFiles and does not set `ok`.
  // `if (!result.ok)` treated that successful write as a failure.
  if (result.wroteFiles === false || result.wrote_files === false || result.operation === "skip") {
    return { ok: false, error: String(result.reason || result.note || "Write failed") };
  }
  return { ok: true, path: rel };
}

