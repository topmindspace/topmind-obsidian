// ── Pure Kernel write-path operations (no Obsidian imports) ────────────────
//
// KernelService UI layer calls these. Unit/integration tests call them with a
// real Kernel API + temp workspace — no App/Notice required.

import fs from "node:fs";
import path from "node:path";
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
import { runAgentTool } from "./workspace-agent-tools.ts";
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
      targetPath = path.join(workspaceRoot, relPath);
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
    const absDir = path.join(workspaceRoot, inboxDir);
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
      targetPath: path.join(workspaceRoot, relPath),
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
  const entry = takePendingWrite(id);
  if (!entry) return { ok: false, error: "not-found" };
  try {
    const contract = kernel.loadContract(workspaceRoot);
    const result = kernel.executeWrite({
      targetPath: path.join(workspaceRoot, entry.relativePath),
      content: entry.content,
      workspaceRoot,
      contract,
      operation: "update",
      actor: "user",
      confirmed: true,
      skipShadow: true,
    });
    if (result.pending) {
      restorePendingWrite(entry);
      return { ok: false, error: "pending-confirmation" };
    }
    return { ok: true, path: entry.relativePath };
  } catch (err) {
    restorePendingWrite(entry);
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

export type WorkspaceChatGenerate = (
  prompt: string,
  context?: Record<string, unknown>,
) => Promise<string>;

export interface ChatProgressEvent {
  kind: "step" | "tool" | "continue" | "done";
  step: number;
  maxSteps: number;
  tool?: string;
  autoContinues?: number;
  note?: string;
}

export interface WorkspaceChatTurnOpts {
  configDir?: string;
  userMessage: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  generate: WorkspaceChatGenerate;
  locale?: string;
  writebackMode?: "auto" | "confirm";
  systemExtra?: string;
  maxSteps?: number;
  /** Auto-continue when the step budget is exhausted mid-task (default true). */
  autoContinue?: boolean;
  engineRoot?: string;
  onProgress?: (ev: ChatProgressEvent) => void;
}

/** Desktop parity: 3–80, default 32. Obsidian uses the same agent step budget. */
export const AGENT_STEPS_MIN = 3;
export const AGENT_STEPS_MAX = 80;
export const AGENT_STEPS_DEFAULT = 32;
/** Bounded auto-continue when the step budget is exhausted mid-task. */
export const MAX_AUTO_CONTINUES = 2;

export function clampMaxAgentSteps(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return AGENT_STEPS_DEFAULT;
  return Math.max(AGENT_STEPS_MIN, Math.min(AGENT_STEPS_MAX, v));
}

const KNOWN_TOOLS = new Set([
  "search",
  "workspace_overview",
  "list_categories",
  "list_topics",
  "list_topic_files",
  "list_inbox",
  "list_outputs",
  "list_todos",
  "read_file",
  "save_file",
  "edit_file",
  "capture",
  "add_todo",
  "toggle_todo",
]);

function stripThinking(raw: string): string {
  let s = String(raw || "");
  s = s.replace(/ԇink>[\s\S]*?<\/think>/giu, "\n");
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/giu, "\n");
  s = s.replace(/```(?:thinking|reasoning)\s*[\s\S]*?```/giu, "\n");
  return s.trim();
}

/**
 * Extract a single tool-call JSON from model output.
 * Accepts bare JSON, fenced JSON, or a JSON object embedded in prose.
 * Unknown tool names still return so the loop can feed an error and continue
 * (breaking on them would look like "agent finished").
 */
export function parseToolCall(text: string): Record<string, unknown> | null {
  const cleaned = stripThinking(text);
  if (!cleaned) return null;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const obj = parseJsonUnknown(s);
      if (!isRecord(obj)) return null;
      const tool = String(obj.tool || obj.name || "");
      if (!tool) return null;
      return obj;
    } catch {
      return null;
    }
  };
  const direct = tryParse(cleaned);
  if (direct) return direct;
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fence) {
    const inner = tryParse(fence[1].trim());
    if (inner) return inner;
  }
  // Prefer an object whose "tool" is known; fall back to any tool-shaped object.
  const toolRe = /\{[^{}]*"tool"\s*:\s*"[^"]+"[^{}]*\}/gu;
  const candidates: Array<Record<string, unknown>> = [];
  let m: RegExpExecArray | null;
  while ((m = toolRe.exec(cleaned))) {
    const rec = tryParse(m[0]);
    if (rec) candidates.push(rec);
  }
  if (candidates.length) {
    const known = candidates.find((c) => KNOWN_TOOLS.has(String(c.tool || c.name || "")));
    return known || candidates[0];
  }
  // Balanced-brace scan for nested args (oldText with braces, etc.).
  const start = cleaned.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const rec = tryParse(cleaned.slice(start, i + 1));
          if (rec && (rec.tool || rec.name)) return rec;
          break;
        }
      }
    }
  }
  return null;
}

export function isKnownTool(name: unknown): boolean {
  return KNOWN_TOOLS.has(String(name || ""));
}

function toolResultForModel(result: unknown): string {
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Same mapping as Desktop `resolvePromptLocale`: `en*` → English, else Chinese.
 * UI chrome only (tool-guide). Durable answer language is `resolveChatDurableLocale`.
 */
export function resolveChatPromptLocale(locale?: string | null): "zh" | "en" {
  if (locale == null || locale === "") return "zh";
  return String(locale).startsWith("en") ? "en" : "zh";
}

/**
 * Kernel 3-tier durable locale for chat answers / edit_file newText.
 * Explicit request → source script → workspace locale. UI chrome is not a tier.
 */
export function resolveChatDurableLocale(
  kernel: KernelApi,
  workspaceRoot: string,
  userMessage: string,
): "zh" | "en" {
  try {
    const contract = kernel.loadContract(workspaceRoot);
    if (typeof kernel.resolveAgentOutputLanguage === "function") {
      const loc = kernel.resolveAgentOutputLanguage({
        userText: userMessage,
        contract,
      });
      return loc === "en" ? "en" : "zh";
    }
  } catch {
    /* incomplete workspace in tests */
  }
  return "zh";
}

const CHAT_PROFILE_MAX_CHARS = 2000;

/**
 * Active profile facts for Obsidian chat. History is collapsed to a count —
 * never slice raw profile.md (archived lines look like current truth).
 */
export function loadChatProfileContext(
  kernel: KernelApi,
  workspaceRoot: string,
  locale?: string | null,
): string {
  try {
    const loc = resolveChatPromptLocale(locale);
    let collapsed = "";
    if (typeof kernel.readProfileActiveBody === "function") {
      collapsed = kernel.readProfileActiveBody(workspaceRoot, { locale: loc }) || "";
    }
    if (!collapsed && typeof kernel.collapseProfileHistoryBody === "function") {
      const rel = typeof kernel.globalProfileRelPath === "function"
        ? kernel.globalProfileRelPath(workspaceRoot)
        : "memory/profile.md";
      const abs = path.join(workspaceRoot, rel);
      if (fs.existsSync(abs)) {
        collapsed = kernel.collapseProfileHistoryBody(fs.readFileSync(abs, "utf8"), {
          locale: loc,
          profileRel: rel,
        });
      }
    }
    if (!collapsed) return "";
    const body = stripFrontmatter(collapsed).trim();
    if (!body) return "";
    return body.length > CHAT_PROFILE_MAX_CHARS
      ? `${body.slice(0, CHAT_PROFILE_MAX_CHARS)}\n…`
      : body;
  } catch {
    return "";
  }
}

export function durableChatAnswerGuide(locale: "zh" | "en"): string {
  return locale === "en"
    ? "User-visible answer language: English (unless this turn explicitly asked otherwise). Do not follow the UI chrome language for the answer or for edit_file newText."
    : "用户可见回答语言：中文（除非本轮明确要求其他语言）。回答和 edit_file 的 newText 不要跟 UI 界面语言走。";
}

/**
 * Chat tool + writeback/protection/edit + multi-step autonomy instructions.
 * Aligned with Desktop agent contract (tools → work until done → path receipt).
 */
export function buildObsidianChatToolGuide(
  locale?: string | null,
  writebackMode?: "auto" | "confirm",
): string {
  const lang = resolveChatPromptLocale(locale);
  const confirm = writebackMode === "confirm";
  // Keep writeback policy copy aligned with Desktop
  // `describeWritebackModeForPrompt` (graded confirm; locked editable + task snapshot).
  if (lang === "en") {
    const writeback = confirm
      ? "Writeback: graded ask-before-save — content create/update/edit land immediately; delete/archive enter pending confirmation and run only after the user accepts (delete has no auto-accept path); locked notes are editable with a one-time task snapshot; permanent locked/core delete is user-only; when files must change, you must call tools — never only rewrite verbally without tools."
      : "Writeback: auto-save — you may freely call write tools inside the workspace; locked notes are editable (not forbidden): the first overwrite in this task takes a one-time snapshot + receipt; further edits in the same task update in place; locked/core delete/archive is recoverable (trash/destination + receipt) and allowed in auto; irreversible permanent delete of locked/core is user-only; open notes write immediately (path receipt only, no YAML backup); multi-file turns summarize path receipts.";
    return [
      "You are a CONTINUOUS workspace agent, not a one-shot chatbot. For any task that reads, edits, creates, or organizes notes: call tools repeatedly until the goal is fully done, THEN write the final user-visible answer. Never stop after a plan or a single thought.",
      "When calling a tool, emit a single JSON object and nothing else:",
      '{"tool":"search","query":"keyword","scope":"20-专题","maxResults":20,"regex":false,"includeArchive":false,"context":1}',
      '{"tool":"workspace_overview"}',
      '{"tool":"list_categories"}',
      '{"tool":"list_topics","category":"20-专题"}',
      '{"tool":"list_topic_files","topicId":"20-专题/2026-主题"}',
      '{"tool":"list_inbox"}',
      '{"tool":"list_outputs"}',
      '{"tool":"list_todos","completed":false,"limit":20}',
      '{"tool":"read_file","relativePath":"10-动态/2026-W33.md","around":"unique phrase","limit":80}',
      '{"tool":"save_file","relativePath":"20-专题/2026-主题/note.md","content":"full markdown or text body"}',
      '{"tool":"edit_file","relativePath":"…","oldText":"unique span","newText":"replacement","startLine":12,"endLine":20,"expectedHash":"<optional contentHash>","replaceAll":false,"heading":"Optional section"}',
      '{"tool":"capture","content":"note body","target":"stream"|"inbox","title":"optional"}',
      '{"tool":"add_todo","text":"…","dueDate":"YYYY-MM-DD"}',
      '{"tool":"toggle_todo","id":"…" | "text":"unique todo text"}',
      "Discovery first (workspace_overview / search / list_*), then act. Prefer save_file for new files or multi-section rewrites; edit_file for unique-span edits (match ladder: exact → newline/trailing-space → loose lines). Writable: text notes (.md/.txt/.json/.yaml/.csv/code/config) — not binaries. Multi-step edits: follow postEditWindow + contentHash as expectedHash. No bash or shell.",
      writeback,
      "User profile context is active facts only (history collapsed to a count). Prefer capture/add_todo over inventing memory tools; memory writes are proposed in the answer and applied via the Suggest tab — never invent append_core_memory / update_core_memory / retire_core_memory.",
      "If steps run out mid-task, continue from the latest tool results and path receipts toward the original goal. When done, write only the user-visible answer with paths — no chain-of-thought, <think>, or reasoning fences.",
    ].join("\n");
  }
  const writeback = confirm
    ? "写回: 分级「删除/归档前问我」— 内容新建/更新/编辑直接落盘；删除/归档进入待确认，需用户接受后才执行（删除没有自动接受路径）；锁定笔记可编辑（任务内首写快照一次）；永久删除 locked/core 仅用户；需要改文件时必须调用工具，禁止只做口头改写而不走工具。"
    : "写回: 自动保存 — 工作区内可自由调用 write 工具；锁定笔记可编辑（不是禁区）：本任务对该文件的首次覆盖会做一次快照+回执，同任务后续编辑原地更新；锁定/核心笔记的删除与归档在 auto 下允许，走可恢复 trash/归档目的地+回执；永久删除仅用户；开放笔记直接写入（仅路径回执，无 YAML 备份）；多文件轮次汇总路径回执。";
  return [
    "你是持续工作的智能体，不是一次性问答。凡是要读/改/新建/整理笔记的任务：连续调用工具直到目标真正完成，再写用户可见结论。禁止只输出计划或一次思考就结束。",
    "调用工具时，只输出一个 JSON 对象（不要夹杂其他文字）：",
    '{"tool":"search","query":"关键词","scope":"20-专题","maxResults":20,"regex":false,"includeArchive":false,"context":1}',
    '{"tool":"workspace_overview"}',
    '{"tool":"list_categories"}',
    '{"tool":"list_topics","category":"20-专题"}',
    '{"tool":"list_topic_files","topicId":"20-专题/2026-主题"}',
    '{"tool":"list_inbox"}',
    '{"tool":"list_outputs"}',
    '{"tool":"list_todos","completed":false,"limit":20}',
    '{"tool":"read_file","relativePath":"10-动态/2026-W33.md","around":"唯一短语","limit":80}',
    '{"tool":"save_file","relativePath":"20-专题/2026-主题/note.md","content":"完整 markdown 正文"}',
    '{"tool":"edit_file","relativePath":"…","oldText":"原文唯一片段","newText":"替换","startLine":12,"endLine":20,"expectedHash":"<可选 contentHash>","replaceAll":false,"heading":"可选小节标题"}',
    '{"tool":"capture","content":"正文","target":"stream"|"inbox","title":"可选"}',
    '{"tool":"add_todo","text":"…","dueDate":"YYYY-MM-DD"}',
    '{"tool":"toggle_todo","id":"…" | "text":"待办原文片段"}',
    "先发现（workspace_overview / search / list_*），再动手。新建或多段重写首选 save_file；小改用 edit_file 唯一片段编辑（匹配阶梯：精确 → 换行/行尾空白 → 行级宽松）。可写文本类（.md/.txt/.json/.yaml/.csv/代码/配置），不写二进制。多步编辑跟 postEditWindow + contentHash 作 expectedHash。没有 bash / shell。",
    writeback,
    "用户画像上下文仅为活跃事实（历史已折叠为计数）。记一下/待办用 capture/add_todo，不要编造 append_core_memory / update_core_memory / retire_core_memory；记忆写入在回答中建议，由用户在「建议」tab 确认。",
    "步数将尽时基于最近工具结果与路径回执继续完成原目标。完成后只写用户可见结论（含路径），不要输出思考过程、<think> 或推理围栏。",
  ].join("\n");
}

const CHAT_CONTINUE_PROMPT_ZH =
  "[系统] 上一轮步数用尽，任务可能未完成。请基于最近的工具结果与路径回执，继续完成用户原始目标；若已完成则给出简短结论与路径。";
const CHAT_CONTINUE_PROMPT_EN =
  "[System] Step budget was exhausted; the task may be incomplete. Continue from the latest tool results and path receipts toward the user's original goal; if finished, give a short conclusion with paths.";

/**
 * Bounded multi-step read/search/write/edit agent loop (Obsidian chat).
 * Same Kernel matcher + writeback as Desktop; generate() is the host provider.
 * Auto-continues (max 2) when the step budget is exhausted mid-task.
 */
export async function runWorkspaceChatTurn(
  kernel: KernelApi,
  workspaceRoot: string,
  opts: WorkspaceChatTurnOpts,
): Promise<{
  body: string;
  reasoning: string;
  edits: Array<Record<string, unknown>>;
  steps: number;
  toolCalls: Array<{ tool: string; ok: boolean; summary?: string }>;
  autoContinues: number;
  stepLimitHit: boolean;
}> {
  const durable = resolveChatDurableLocale(kernel, workspaceRoot, opts.userMessage);
  const chromeZh = resolveChatPromptLocale(opts.locale) === "zh";
  // Settings use clampMaxAgentSteps (3–80). Explicit opts.maxSteps is trusted
  // (tests / callers may pin a short budget).
  const maxSteps = opts.maxSteps != null
    ? Math.max(1, Math.min(AGENT_STEPS_MAX, Math.floor(Number(opts.maxSteps) || 1)))
    : clampMaxAgentSteps(undefined);
  // Contract is truth. Never force a default override that could fork topmind.yaml
  // when the contract fails to load — leave writebackMode undefined then.
  const contractMode = resolveContractWritebackMode(kernel, workspaceRoot);
  const modeHint = contractMode || opts.writebackMode || "auto";
  const toolGuide = buildObsidianChatToolGuide(opts.locale, modeHint);
  const answerGuide = durableChatAnswerGuide(durable);
  const agentCtx = {
    kernel,
    workspaceRoot,
    engineRoot: opts.engineRoot,
    writebackMode: contractMode || opts.writebackMode,
    actor: "ai" as const,
    configDir: opts.configDir,
  };

  const conversation: string[] = [];
  for (const msg of (opts.history || []).slice(-10)) {
    conversation.push(`${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`);
  }
  conversation.push(`User: ${opts.userMessage}`);

  const edits: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ tool: string; ok: boolean; summary?: string }> = [];
  let lastRaw = "";
  let stepCount = 0;
  let autoContinues = 0;
  let stepLimitHit = false;
  let finished = false;

  const emit = (ev: ChatProgressEvent) => {
    try {
      opts.onProgress?.(ev);
    } catch {
      /* progress must not break the agent */
    }
  };

  const execOneTool = (call: Record<string, unknown>): string | null => {
    const tool = String(call.tool || call.name || "");
    if (!isKnownTool(tool)) {
      return toolResultForModel({
        ok: false,
        error: `unknown tool: ${tool}`,
        hint: `Use only: ${[...KNOWN_TOOLS].join(", ")}. Re-emit a single JSON tool call.`,
      });
    }
    if (tool === "read_file") {
      const read = readWorkspaceWindow(kernel, workspaceRoot, {
        relativePath: String(call.relativePath || ""),
        offset: typeof call.offset === "number" ? call.offset : undefined,
        limit: typeof call.limit === "number" ? call.limit : 80,
        around: typeof call.around === "string" ? call.around : undefined,
        heading: typeof call.heading === "string" ? call.heading : undefined,
      });
      toolCalls.push({ tool, ok: Boolean(read.ok), summary: String(call.relativePath || "") });
      return toolResultForModel(
        read.ok
          ? { ...read.window, content: read.window?.numbered || read.window?.content, contentHash: read.contentHash }
          : read,
      );
    }
    if (tool === "edit_file") {
      const edited = preciseEditWorkspace(kernel, workspaceRoot, {
        relativePath: String(call.relativePath || ""),
        oldText: String(call.oldText || ""),
        newText: String(call.newText ?? ""),
        replaceAll: Boolean(call.replaceAll),
        startLine: typeof call.startLine === "number" ? call.startLine : undefined,
        endLine: typeof call.endLine === "number" ? call.endLine : undefined,
        heading: typeof call.heading === "string" ? call.heading : undefined,
        expectedHash: typeof call.expectedHash === "string" ? call.expectedHash : undefined,
        actor: "ai",
        // Content edit always lands (graded-confirm Desktop parity).
        confirmed: true,
        writebackMode: contractMode || opts.writebackMode,
      });
      edits.push({ ...edited, tool: "edit_file", relativePath: call.relativePath });
      toolCalls.push({ tool, ok: Boolean(edited.ok), summary: String(call.relativePath || "") });
      let editNote = toolResultForModel(edited);
      if (edited.reason === "hash-mismatch" || edited.error === "hash-mismatch") {
        editNote += `\nHINT: file changed since last read — call read_file around= to refresh contentHash/oldText, then retry edit_file with the new expectedHash.`;
      } else if (edited.reason === "no-match" || edited.reason === "ambiguous") {
        editNote += `\nHINT: use nearby/context from the diagnostic, or read_file around= the phrase, then retry with exact oldText + expectedHash.`;
      }
      return editNote;
    }
    if (tool === "capture") {
      const captured = captureToWorkspace(kernel, workspaceRoot, opts.engineRoot || workspaceRoot, String(call.content || ""), {
        target: call.target === "inbox" ? "inbox" : "stream",
        writebackMode: contractMode || opts.writebackMode,
      });
      toolCalls.push({ tool, ok: Boolean(captured.ok), summary: captured.path });
      return toolResultForModel({ ...captured, tool });
    }
    const result = runAgentTool(agentCtx, call);
    if (!result) {
      return toolResultForModel({ ok: false, tool, error: "tool not dispatched", hint: "Re-emit a single JSON tool call." });
    }
    toolCalls.push({ tool, ok: Boolean(result.ok), summary: String(result.relativePath || result.count || "") });
    return toolResultForModel(result);
  };

  // Transient generate failures must not kill the whole turn (Desktop parity:
  // one in-loop retry, then surface the error as the answer). This is a root
  // cause of "AI 功能总是断" — a single network blip used to abort mid-task.
  let generateFailures = 0;
  const MAX_GENERATE_FAILURES = 2;

  for (;;) {
    let brokeOnFinalText = false;
    for (let step = 0; step < maxSteps; step++) {
      stepCount += 1;
      emit({ kind: "step", step: stepCount, maxSteps, autoContinues });
      const prompt = conversation.join("\n\n");
      let raw: unknown;
      try {
        raw = await opts.generate(prompt, {
          operation: "chat",
          systemPrompt: `${opts.systemExtra || ""}\n\n${answerGuide}\n\n${toolGuide}`.trim(),
          maxOutputTokens: 8192,
          temperature: 0.4,
        });
        generateFailures = 0;
      } catch (err) {
        generateFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        emit({ kind: "step", step: stepCount, maxSteps, tool: "retry", autoContinues });
        if (generateFailures >= MAX_GENERATE_FAILURES) {
          lastRaw = chromeZh
            ? `模型请求连续失败（${msg}）。已执行的工具结果与路径回执见上文；请稍后重试或检查服务商配置。`
            : `Model request failed repeatedly (${msg}). Tool results and path receipts above; retry later or check provider settings.`;
          finished = true;
          brokeOnFinalText = true;
          break;
        }
        conversation.push(
          chromeZh
            ? `[系统] 上一步模型请求失败：${msg}。请基于已有工具结果继续完成原目标；若无法继续，用简短中文说明卡点与已完成路径。`
            : `[System] Previous model call failed: ${msg}. Continue from existing tool results; if stuck, reply briefly with the blocker and completed paths.`,
        );
        continue;
      }
      lastRaw = String(raw || "");
      if (!lastRaw.trim()) {
        // Empty completion — treat as soft failure and re-prompt once.
        generateFailures += 1;
        if (generateFailures >= MAX_GENERATE_FAILURES) {
          finished = true;
          brokeOnFinalText = true;
          break;
        }
        conversation.push(
          chromeZh
            ? "[系统] 上一轮回复为空。请继续完成原目标，或给出简短结论。"
            : "[System] Previous reply was empty. Continue the original goal or give a short conclusion.",
        );
        continue;
      }
      const call = parseToolCall(lastRaw);
      if (!call) {
        brokeOnFinalText = true;
        finished = true;
        break;
      }

      const tool = String(call.tool || call.name || "");
      emit({ kind: "tool", step: stepCount, maxSteps, tool, autoContinues });
      conversation.push(`Assistant: ${lastRaw}`);
      const toolNote = execOneTool(call);
      conversation.push(`Tool result (${tool}):\n${toolNote || ""}`);
    }

    if (finished || brokeOnFinalText) break;

    // Callers that pin maxSteps can opt out of auto-continue (tests / one-shot).
    if (opts.autoContinue === false) {
      stepLimitHit = true;
      break;
    }

    // Step budget exhausted while still in tool-call mode → auto-continue (bounded).
    if (autoContinues >= MAX_AUTO_CONTINUES) {
      stepLimitHit = true;
      break;
    }
    const lastBody = stripThinking(lastRaw);
    // Skip continue when the last payload already looks like a real finish.
    if (!parseToolCall(lastRaw) && lastBody.length > 80) {
      finished = true;
      break;
    }
    autoContinues += 1;
    stepLimitHit = true;
    emit({ kind: "continue", step: stepCount, maxSteps, autoContinues });
    conversation.push(`User: ${chromeZh ? CHAT_CONTINUE_PROMPT_ZH : CHAT_CONTINUE_PROMPT_EN}`);
  }

  const split = typeof kernel.splitAssistantVisible === "function"
    ? kernel.splitAssistantVisible(lastRaw)
    : { body: String(lastRaw || "").trim(), reasoning: "" };
  let body = split.body;
  if (parseToolCall(lastRaw)) {
    const pending = edits.some((e) => e.pending || e.needsConfirm) || toolCalls.some((t) => t.summary === "pending");
    const applied = edits.some((e) => e.ok) || toolCalls.some((t) => t.ok);
    if (chromeZh) {
      body = pending
        ? "写入已挂起，请在侧栏「建议」中接受或拒绝。"
        : applied
          ? `已完成文件操作（${toolCalls.filter((t) => t.ok).length} 步工具调用${stepLimitHit ? "，步数用尽" : ""}）。`
          : stepLimitHit
            ? "步数用尽且修改未完成，请缩小目标或提高工具步数上限后重试。"
            : "未能完成修改，请根据工具返回的 nearby/context 再试。";
    } else {
      body = pending
        ? "Write is pending — accept or reject it in the sidebar Suggest tab."
        : applied
          ? `Finished workspace operations (${toolCalls.filter((t) => t.ok).length} tool steps${stepLimitHit ? ", step budget exhausted" : ""}).`
          : stepLimitHit
            ? "Step budget exhausted and the edit did not complete. Narrow the goal or raise max tool steps and retry."
            : "Edit did not apply. Use the nearby/context from the tool result and retry.";
    }
  }
  emit({ kind: "done", step: stepCount, maxSteps, autoContinues });
  return {
    body,
    reasoning: split.reasoning,
    edits,
    steps: stepCount,
    toolCalls,
    autoContinues,
    stepLimitHit,
  };
}

export interface WorkspaceAppendStreamOpts {
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

  const targetPath = path.join(workspaceRoot, rel);
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
    actor: "user",
    confirmed: true,
    skipShadow: true,
    writebackModeOverride: opts.writebackMode === "confirm" ? "confirm" : "auto",
  });

  if (result.pending || result.needsConfirm) {
    // pending is not success — UI must distinguish await-confirm from written.
    return { ok: false, path: rel, pending: true, needsConfirm: true, error: "pending-confirmation" };
  }
  if (!result.ok) {
    return { ok: false, error: String(result.reason || "Write failed") };
  }
  return { ok: true, path: rel };
}

