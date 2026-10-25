// ── Obsidian chat agent tools (pure Kernel + fs; no Obsidian imports) ───────
//
// Behavior contract mirrors Desktop `ai-tools.mjs` / WorkspaceService scan+path
// ops so the agent can discover, write, and organize — not just read/edit.
// All writes go through Kernel `executeWrite` (unique write gate).

import fs from "node:fs";
import { normalizeAgentToolCall } from "#kernel/agent-tool-catalog.mjs";
import { bundledSkills, bundledSkillResource } from "./skill-resources.ts";
import path from "node:path";
import { createHash } from "node:crypto";
import type { KernelApi } from "../bridge/kernel-loader.ts";
import { stripFrontmatter, sanitizeFileName, isRecord, isUnknownArray } from "../utils.ts";
import { listPendingWrites, stashPendingWrite } from "./pending-writes.ts";
import { sanitizeAiWriteBody } from "#kernel/ai-content-sanitize.mjs";
import {
  ddgSearchUrl,
  parseDdgHtmlLite,
  rankResults,
} from "#kernel/web-search-core.mjs";
import { resolveInsideVault } from "../bridge/vault-bridge.ts";
import {
  isEscapingSymlinkSync,
  isHeavyDirName,
  loadVaultIgnoreSync,
  pathMatchesUserIgnore,
  resolvesOutsideVaultSync,
  shouldSkipVaultDirName,
} from "#kernel/vault-walk.mjs";

export type AgentWriteMode = "auto" | "confirm";

export interface AgentToolContext {
  kernel: KernelApi;
  workspaceRoot: string;
  engineRoot?: string;
  writebackMode?: AgentWriteMode;
  actor?: "ai" | "user";
  /** Vault config folder name from Vault#configDir. */
  configDir?: string;
  /**
   * HTTP fetch for `fetch_url` — must be host-injected (Obsidian `requestUrl`).
   * Never use global fetch in plugin source (guideline compliance).
   */
  fetchPage?: (url: string) => Promise<{ ok: boolean; status?: number; text?: string; error?: string }>;
}

export interface AgentToolResult {
  ok: boolean;
  tool: string;
  [key: string]: unknown;
}

function contentHash(text: string): string {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

function normalizeRel(p: unknown): string {
  return String(p || "").replace(/\\/g, "/").replace(/^\/+|\/+$/gu, "");
}

function isSafeRel(rel: string): boolean {
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) return false;
  if (/(?:^|\/)(?:undefined|period)\.md$/u.test(rel)) return false;
  return true;
}

/**
 * Engine single source: `lib/text-note.mjs` (bundled via esbuild with Kernel).
 * Do not re-implement the inventory here.
 */
import {
  TEXT_NOTE_EXTS,
  isTextNotePath,
} from "#kernel/text-note.mjs";
export { TEXT_NOTE_EXTS, isTextNotePath };

/**
 * GitHub URL semantics (engine single source `lib/github-md.mjs`).
 * fetch_url rewrites markdown blob/raw to raw.githubusercontent + image links.
 */
import {
  parseGithubFileUrl,
  githubRawUrl,
  rewriteGithubMarkdownImages,
} from "#kernel/github-md.mjs";

function absOf(workspaceRoot: string, rel: string): string {
  return path.join(workspaceRoot, rel);
}

function listDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
  } catch {
    return [];
  }
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Escaping link, or any existing path whose real target sits outside the vault. */
function leavesVault(workspaceRoot: string, abs: string): boolean {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(abs);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  // A new target may not exist yet; check each parent before mkdir or a read.
  let candidate = target;
  while (candidate !== root) {
    if (isEscapingSymlinkSync(root, candidate) || resolvesOutsideVaultSync(root, candidate)) return true;
    const parent = path.dirname(candidate);
    if (parent === candidate) return true;
    candidate = parent;
  }
  return false;
}

function resolveCategoryDirs(kernel: KernelApi, workspaceRoot: string, engineRoot?: string): Array<{
  directory: string;
  role?: string;
  specialBehavior?: string;
  hidden?: boolean;
}> {
  try {
    const contract = kernel.loadContract(workspaceRoot);
    const model = kernel.resolveWorkspaceModel({
      workspaceRoot,
      engineRoot: engineRoot || workspaceRoot,
      config: contract,
    });
    return (model.categories || [])
      .filter((c: { ok?: boolean; directory?: string }) => c.ok !== false && c.directory)
      .map((c: {
        directory: string;
        role?: string;
        specialBehavior?: string;
        hidden?: boolean;
      }) => ({
        directory: c.directory,
        role: c.role,
        specialBehavior: c.specialBehavior,
        hidden: Boolean(c.hidden),
      }));
  } catch {
    return listDirSafe(workspaceRoot)
      .filter((name) => /^\d{2}[ -]/u.test(name) && statSafe(path.join(workspaceRoot, name))?.isDirectory())
      .map((directory) => ({ directory }));
  }
}

function resolveInboxDir(kernel: KernelApi, workspaceRoot: string, engineRoot?: string): string {
  const cats = resolveCategoryDirs(kernel, workspaceRoot, engineRoot);
  const buffer = cats.find((c) => c.role === "buffer");
  if (buffer?.directory) return buffer.directory;
  const found = listDirSafe(workspaceRoot).find((n) => /^00[ -]/u.test(n) && statSafe(path.join(workspaceRoot, n))?.isDirectory());
  return found || "00-Inbox";
}

function resolveDeliveryDir(kernel: KernelApi, workspaceRoot: string, engineRoot?: string): string {
  const cats = resolveCategoryDirs(kernel, workspaceRoot, engineRoot);
  const delivery = cats.find((c) => c.role === "delivery");
  if (delivery?.directory) return delivery.directory;
  const found = listDirSafe(workspaceRoot).find((n) => /^88[ -]/u.test(n) && statSafe(path.join(workspaceRoot, n))?.isDirectory());
  return found || "88-交付";
}

function resolveArchiveDir(kernel: KernelApi, workspaceRoot: string, engineRoot?: string): string {
  const cats = resolveCategoryDirs(kernel, workspaceRoot, engineRoot);
  const system = cats.find((c) => c.role === "system");
  if (system?.directory) return system.directory;
  const found = listDirSafe(workspaceRoot).find((n) => /^99[ -]/u.test(n) && statSafe(path.join(workspaceRoot, n))?.isDirectory());
  return found || "99-归档";
}

function walkFiles(
  root: string,
  opts: { maxFiles?: number; skipDirs?: Set<string>; workspaceRoot?: string } = {},
): string[] {
  const maxFiles = opts.maxFiles || 4000;
  const skip = opts.skipDirs || new Set([".topmind", ".git", "node_modules"]);
  const workspaceRoot = opts.workspaceRoot || "";
  if (workspaceRoot && leavesVault(workspaceRoot, root)) return [];
  if (workspaceRoot && root !== workspaceRoot && isHeavyDirName(path.basename(root))) return [];
  const ignore = workspaceRoot ? loadVaultIgnoreSync(workspaceRoot) : [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const name = entry.name;
      if (skip.has(name) || shouldSkipVaultDirName(name)) continue;
      const abs = path.join(dir, name);
      if (workspaceRoot) {
        const rel = path.relative(workspaceRoot, abs).split(path.sep).join("/");
        if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) continue;
        if (pathMatchesUserIgnore(rel, ignore)) continue;
      }
      // lstat via dirent: never follow a symlink into /Applications or a package.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

/** Controlled read-only grep (Desktop search parity, simplified). */
export function searchWorkspace(
  ctx: AgentToolContext,
  opts: {
    query: string;
    scope?: string;
    maxResults?: number;
    regex?: boolean;
    includeArchive?: boolean;
    context?: number;
  },
): AgentToolResult {
  const tool = "search";
  const query = String(opts.query || "").trim();
  if (!query) return { ok: false, tool, error: "query required" };
  if (query.length > 200) return { ok: false, tool, error: "query too long (max 200)" };

  const maxHits = Math.max(1, Math.min(80, Math.floor(Number(opts.maxResults) || 40)));
  const ctxLines = Math.max(0, Math.min(2, Math.floor(Number(opts.context) || 0)));
  const archiveName = resolveArchiveDir(ctx.kernel, ctx.workspaceRoot, ctx.engineRoot);
  let scopeRel = normalizeRel(opts.scope);
  if (scopeRel.includes("..")) return { ok: false, tool, error: "scope cannot contain .." };
  if (scopeRel.startsWith(archiveName) && !opts.includeArchive) {
    return { ok: true, tool, results: [], count: 0, note: "scope points at Archive (excluded by default); set includeArchive=true" };
  }

  let re: RegExp | null = null;
  const needle = query.toLowerCase();
  if (opts.regex) {
    try {
      re = new RegExp(query, "iu");
    } catch (err) {
      return { ok: false, tool, error: `invalid regex: ${err instanceof Error ? err.message : String(err)}`, hint: "Use regex=false with a plain keyword." };
    }
  }

  const root = ctx.workspaceRoot;
  const walkRoot = scopeRel ? absOf(root, scopeRel) : root;
  if (!statSafe(walkRoot)) {
    return { ok: false, tool, error: `scope not found: ${scopeRel || "."}`, hint: "Use workspace_overview or list_categories to confirm paths." };
  }

  const skipDirs = new Set([".topmind", ".git", "node_modules"]);
  if (ctx.configDir) skipDirs.add(ctx.configDir);
  if (!opts.includeArchive) skipDirs.add(archiveName);

  const results: Array<{ relativePath: string; line: number; preview: string }> = [];
  let filesScanned = 0;
  let truncated = false;

  for (const abs of walkFiles(walkRoot, { skipDirs, maxFiles: 3000, workspaceRoot: root })) {
    if (results.length >= maxHits) {
      truncated = true;
      break;
    }
    if (!/\.(md|txt|markdown)$/iu.test(abs)) continue;
    filesScanned += 1;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/u);
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxHits) {
        truncated = true;
        break;
      }
      const line = lines[i];
      const hit = re ? re.test(line) : line.toLowerCase().includes(needle);
      if (!hit) continue;
      const from = Math.max(0, i - ctxLines);
      const to = Math.min(lines.length, i + ctxLines + 1);
      const preview = lines.slice(from, to).join(" · ").slice(0, 240);
      results.push({
        relativePath: path.relative(root, abs).replace(/\\/g, "/"),
        line: i + 1,
        preview,
      });
    }
  }

  return {
    ok: true,
    tool,
    results,
    count: results.length,
    filesScanned,
    truncated,
    scope: scopeRel || null,
  };
}

export function listCategories(ctx: AgentToolContext): AgentToolResult {
  const categories = resolveCategoryDirs(ctx.kernel, ctx.workspaceRoot, ctx.engineRoot);
  return { ok: true, tool: "list_categories", categories };
}

export function workspaceOverview(ctx: AgentToolContext): AgentToolResult {
  const categories = resolveCategoryDirs(ctx.kernel, ctx.workspaceRoot, ctx.engineRoot);
  const root = ctx.workspaceRoot;
  const withCounts = categories.map((c) => {
    const catDir = path.join(root, c.directory);
    let topicCount = 0;
    let looseNotes = 0;
    if (leavesVault(root, catDir)) {
      return { ...c, topicCount: 0, looseNotes: 0 };
    }
    for (const name of listDirSafe(catDir)) {
      if (shouldSkipVaultDirName(name)) continue;
      const abs = path.join(catDir, name);
      if (leavesVault(root, abs)) continue;
      const st = statSafe(abs);
      if (st?.isDirectory()) topicCount += 1;
      else if (st?.isFile()) looseNotes += 1;
    }
    return { ...c, topicCount, looseNotes };
  });

  const inboxDir = resolveInboxDir(ctx.kernel, root, ctx.engineRoot);
  const deliveryDir = resolveDeliveryDir(ctx.kernel, root, ctx.engineRoot);
  const inboxAbs = path.join(root, inboxDir);
  const deliveryAbs = path.join(root, deliveryDir);
  const inboxItems = leavesVault(root, inboxAbs)
    ? []
    : listDirSafe(inboxAbs).filter((n) => n.endsWith(".md"));
  const outputItems = leavesVault(root, deliveryAbs)
    ? []
    : listDirSafe(deliveryAbs).filter((n) => !n.startsWith("."));

  let streamPeriod: string | null = null;
  try {
    const target = ctx.kernel.resolveStreamTarget({
      workspaceRoot: root,
      engineRoot: ctx.engineRoot || root,
      config: ctx.kernel.loadContract(root),
    });
    streamPeriod = target?.periodRelPath || null;
  } catch {
    streamPeriod = null;
  }

  return {
    ok: true,
    tool: "workspace_overview",
    categories: withCounts,
    inboxCount: inboxItems.length,
    inboxItems: inboxItems.slice(0, 8).map((n) => ({ name: n, relativePath: `${inboxDir}/${n}` })),
    outputCount: outputItems.length,
    outputs: outputItems.slice(0, 8).map((n) => ({ name: n, relativePath: `${deliveryDir}/${n}` })),
    streamPeriod,
  };
}

export function listTopics(ctx: AgentToolContext, category: string): AgentToolResult {
  const cat = normalizeRel(category);
  if (!isSafeRel(cat)) return { ok: false, tool: "list_topics", error: "invalid category" };
  const catDir = absOf(ctx.workspaceRoot, cat);
  if (leavesVault(ctx.workspaceRoot, catDir) || !statSafe(catDir)?.isDirectory()) {
    return { ok: false, tool: "list_topics", category: cat, error: `category not found: ${cat}`, hint: "Call list_categories or workspace_overview first." };
  }
  const topics: Array<{ id: string; name: string; fileCount: number }> = [];
  const looseNotes: Array<{ name: string; relativePath: string }> = [];
  for (const name of listDirSafe(catDir)) {
    if (shouldSkipVaultDirName(name)) continue;
    const abs = path.join(catDir, name);
    if (leavesVault(ctx.workspaceRoot, abs)) continue;
    const st = statSafe(abs);
    if (st?.isDirectory()) {
      const fileCount = listDirSafe(abs).filter((f) => statSafe(path.join(abs, f))?.isFile()).length;
      topics.push({ id: `${cat}/${name}`, name, fileCount });
    } else if (st?.isFile()) {
      looseNotes.push({ name, relativePath: `${cat}/${name}` });
    }
  }
  return { ok: true, tool: "list_topics", category: cat, topics, looseNotes };
}

export function listTopicFiles(ctx: AgentToolContext, topicId: string): AgentToolResult {
  const id = normalizeRel(topicId);
  if (!isSafeRel(id) || !id.includes("/")) {
    return { ok: false, tool: "list_topic_files", error: "topicId must be 类别/专题名 (category/topic)" };
  }
  const dir = absOf(ctx.workspaceRoot, id);
  const topicName = id.split("/").pop() || "";
  if (shouldSkipVaultDirName(topicName) || leavesVault(ctx.workspaceRoot, dir) || !statSafe(dir)?.isDirectory()) {
    return { ok: false, tool: "list_topic_files", topicId: id, error: `topic not found: ${id}` };
  }
  const files = listDirSafe(dir)
    .filter((n) => !shouldSkipVaultDirName(n))
    .filter((n) => !leavesVault(ctx.workspaceRoot, path.join(dir, n)))
    .map((n) => {
      const abs = path.join(dir, n);
      const st = statSafe(abs);
      return {
        name: n,
        relativePath: `${id}/${n}`,
        isDirectory: Boolean(st?.isDirectory()),
        size: st?.size ?? 0,
        mtime: st ? new Date(st.mtimeMs).toISOString() : null,
      };
    });
  return { ok: true, tool: "list_topic_files", topicId: id, files };
}

export function listInbox(ctx: AgentToolContext): AgentToolResult {
  const inboxDir = resolveInboxDir(ctx.kernel, ctx.workspaceRoot, ctx.engineRoot);
  const dir = absOf(ctx.workspaceRoot, inboxDir);
  if (leavesVault(ctx.workspaceRoot, dir)) {
    return { ok: true, tool: "list_inbox", inboxDir, items: [], count: 0 };
  }
  const items = listDirSafe(dir)
    .filter((n) => n.endsWith(".md") && !n.startsWith("."))
    .map((n) => {
      const abs = path.join(dir, n);
      const st = statSafe(abs);
      let title: string | null = null;
      try {
        const head = fs.readFileSync(abs, "utf8").slice(0, 800);
        const m = head.match(/^#\s+(.+)$/mu);
        title = m ? m[1].trim() : null;
      } catch {
        /* ignore */
      }
      return {
        name: n,
        title,
        relativePath: `${inboxDir}/${n}`,
        mtime: st ? new Date(st.mtimeMs).toISOString() : null,
      };
    })
    .sort((a, b) => String(b.mtime || "").localeCompare(String(a.mtime || "")));
  return { ok: true, tool: "list_inbox", inboxDir, items, count: items.length };
}

export function listOutputs(ctx: AgentToolContext): AgentToolResult {
  const deliveryDir = resolveDeliveryDir(ctx.kernel, ctx.workspaceRoot, ctx.engineRoot);
  const dir = absOf(ctx.workspaceRoot, deliveryDir);
  if (leavesVault(ctx.workspaceRoot, dir)) {
    return { ok: true, tool: "list_outputs", deliveryDir, items: [], count: 0 };
  }
  const items = listDirSafe(dir)
    .filter((n) => !n.startsWith("."))
    .map((n) => {
      const abs = path.join(dir, n);
      const st = statSafe(abs);
      return {
        name: n,
        relativePath: `${deliveryDir}/${n}`,
        isDirectory: Boolean(st?.isDirectory()),
        mtime: st ? new Date(st.mtimeMs).toISOString() : null,
      };
    });
  return { ok: true, tool: "list_outputs", deliveryDir, items, count: items.length };
}

export function listTodos(ctx: AgentToolContext, opts: { completed?: boolean; limit?: number } = {}): AgentToolResult {
  try {
    // Kernel readTodoList returns `{ items, rawContent, relPath, … } | null`
    // (Desktop pathOps.listTodos parity) — never a bare array.
    const parsed = ctx.kernel.readTodoList(ctx.workspaceRoot);
    const raw = isUnknownArray(parsed?.items) ? parsed.items.filter(isRecord) : [];
    const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit) || 50)));
    const all = raw.map((t) => ({
      id: t.id,
      text: t.text,
      done: Boolean(t.done),
      dueDate: t.dueDate || null,
      source: t.source || null,
    }));
    const items = (opts.completed ? all : all.filter((t) => !t.done)).slice(0, limit);
    return {
      ok: true,
      tool: "list_todos",
      items,
      totalCount: all.length,
      activeCount: all.filter((t) => !t.done).length,
      completedCount: all.filter((t) => t.done).length,
      // Keep legacy keys for older prompt snippets.
      total: all.length,
      open: all.filter((t) => !t.done).length,
      done: all.filter((t) => t.done).length,
      targetPath: parsed?.relPath || "memory/todo.md",
    };
  } catch (err) {
    return { ok: false, tool: "list_todos", error: err instanceof Error ? err.message : String(err) };
  }
}

export function saveFile(
  ctx: AgentToolContext,
  opts: { relativePath: string; content: string; heading?: string },
): AgentToolResult {
  const tool = "save_file";
  const rel = normalizeRel(opts.relativePath);
  let content = String(opts.content ?? "");
  if (!isSafeRel(rel)) return { ok: false, tool, error: "invalid relativePath" };
  if (!isTextNotePath(rel)) {
    return {
      ok: false,
      tool,
      error: "only text files are writable (.md / .txt / .json / code / config)",
      relativePath: rel,
    };
  }
  // Strip thinking/meta and block JSON/thinking dumps before Kernel writeback.
  const allowJson = /\.(?:json|jsonc|ya?ml|toml|ini|cfg|conf)$/iu.test(rel);
  const sanitized = sanitizeAiWriteBody(content, { allowJson });
  if (!sanitized.ok) {
    return {
      ok: false,
      tool,
      relativePath: rel,
      error: `write-blocked:${sanitized.reason}`,
      note: "Write blocked: payload looked like AI thinking/JSON dump. Reply with the real body only.",
    };
  }
  content = sanitized.text;
  if (!content.trim()) return { ok: false, tool, error: "content cannot be empty", relativePath: rel };

  // Containment BEFORE any fs side effect — mkdir must never run on an
  // escaping path (e.g. `../../evil/x.md`) even if executeWrite later rejects.
  let targetPath: string;
  try {
    targetPath = resolveInsideVault(ctx.workspaceRoot, rel);
  } catch {
    return {
      ok: false,
      tool,
      relativePath: rel,
      error: "path-escapes-workspace",
      note: "Write blocked: path resolves outside the workspace.",
    };
  }
  if (leavesVault(ctx.workspaceRoot, targetPath)) return { ok: false, tool, error: "path-escapes-workspace" };
  const isUpdate = fs.existsSync(targetPath);
  try {
    const contract = ctx.kernel.loadContract(ctx.workspaceRoot);
    // Ensure parent dir exists for creates (writeback does not mkdir).
    if (!isUpdate) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    }
    const result = ctx.kernel.executeWrite({
      targetPath,
      content,
      workspaceRoot: ctx.workspaceRoot,
      contract,
      operation: isUpdate ? "update" : "create",
      actor: ctx.actor || "ai",
      // Content writes always land (graded-confirm Desktop parity).
      confirmed: true,
      skipShadow: true,
      writebackModeOverride: ctx.writebackMode,
    });
    if (result.pending) {
      let pendingId: string | undefined;
      try {
        pendingId = stashPendingWrite({ workspaceRoot: ctx.workspaceRoot, relativePath: rel, content, toolName: tool }).id;
      } catch {
        pendingId = undefined;
      }
      return {
        ok: false,
        tool,
        pending: true,
        needsConfirm: true,
        pendingId,
        relativePath: rel,
        error: "pending-confirmation",
        reason: "pending",
        wroteFiles: false,
      };
    }
    return {
      ok: true,
      tool,
      relativePath: rel,
      path: rel,
      created: !isUpdate,
      contentHash: contentHash(content),
      wroteFiles: result.wroteFiles !== false,
    };
  } catch (err) {
    return { ok: false, tool, relativePath: rel, error: err instanceof Error ? err.message : String(err) };
  }
}

export function addTodo(ctx: AgentToolContext, opts: { text: string; dueDate?: string }): AgentToolResult {
  const tool = "add_todo";
  const text = String(opts.text || "").trim();
  if (!text) return { ok: false, tool, error: "text required" };
  try {
    if (typeof ctx.kernel.addTodoItem !== "function") {
      return { ok: false, tool, error: "kernel.addTodoItem unavailable" };
    }
    ctx.kernel.ensureTodoFile?.(ctx.workspaceRoot);
    // Kernel addTodoItem returns { ok, item, items, targetPath, reason?, pending? }.
    const result = ctx.kernel.addTodoItem(ctx.workspaceRoot, text, {
      dueDate: opts.dueDate || undefined,
      source: "ai",
      actor: ctx.actor || "ai",
      // Content writes always land (graded-confirm Desktop parity).
      confirmed: true,
      writebackModeOverride: ctx.writebackMode,
    });
    if (result?.pending) {
      return {
        ok: false,
        tool,
        pending: true,
        needsConfirm: true,
        error: "pending-confirmation",
        reason: "pending",
        targetPath: result.targetPath,
      };
    }
    if (!result?.ok) {
      return {
        ok: false,
        tool,
        error: result?.reason === "duplicate" ? "duplicate todo" : result?.reason === "dismissed" ? "todo was dismissed by user" : "add_todo failed",
        reason: result?.reason,
        hint: result?.reason === "duplicate" ? "Todo already exists — use list_todos / toggle_todo instead." : undefined,
      };
    }
    return {
      ok: true,
      tool,
      item: result.item,
      targetPath: result.targetPath,
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

export function toggleTodo(ctx: AgentToolContext, opts: { id?: string; text?: string; completed?: boolean }): AgentToolResult {
  const tool = "toggle_todo";
  try {
    ctx.kernel.ensureTodoFile?.(ctx.workspaceRoot);
    const contract = ctx.kernel.loadContract(ctx.workspaceRoot);
    const parsed = ctx.kernel.readTodoList(ctx.workspaceRoot);
    const list = isUnknownArray(parsed?.items) ? parsed.items.filter(isRecord) : [];
    let id = opts.id ? String(opts.id) : "";
    if (!id && opts.text) {
      const needle = String(opts.text).trim().toLowerCase();
      const exact = list.filter(t => String(t.id || "") === opts.text || String(t.text || "").trim().toLowerCase() === needle);
      const hits = exact.length ? exact : list.filter(t => String(t.text || "").toLowerCase().includes(needle));
      if (hits.length > 1) return { ok: false, tool, error: "ambiguous-todo", hint: "Use the exact id from list_todos." };
      id = hits[0]?.id ? String(hits[0].id) : "";
    }
    if (!id) {
      return {
        ok: false,
        tool,
        error: "todo not found",
        hint: "Call list_todos first and pass id= (or an exact text snippet).",
      };
    }
    const existing = list.find(item => item.id === id);
    if (!existing) return { ok: false, tool, error: "todo-not-found" };
    if (typeof opts.completed === "boolean" && Boolean(existing.done) === opts.completed) return { ok: true, tool, id, unchanged: true };
    const updated = ctx.kernel.toggleTodoItem(ctx.workspaceRoot, id, contract, {
      actor: ctx.actor || "ai",
      // Content writes always land (graded-confirm Desktop parity).
      confirmed: true,
      writebackModeOverride: ctx.writebackMode,
    });
    return { ok: Boolean(updated?.ok), tool, item: updated?.items, targetPath: updated?.targetPath, id };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read topic.md home (Desktop get_topic parity). */
export function getTopic(ctx: AgentToolContext, topicId: string): AgentToolResult {
  const tool = "get_topic";
  try {
    const rel = normalizeRel(topicId);
    if (!rel) return { ok: false, tool, error: "topicId required" };
    const homeRel = rel.endsWith("topic.md") ? rel : `${rel.replace(/\/+$/, "")}/topic.md`;
    const abs = absOf(ctx.workspaceRoot, homeRel);
    if (leavesVault(ctx.workspaceRoot, abs)) return { ok: false, tool, error: `outside vault: ${homeRel}` };
    if (!fs.existsSync(abs)) return { ok: false, tool, error: `not found: ${homeRel}` };
    const body = fs.readFileSync(abs, "utf8");
    return {
      ok: true,
      tool,
      summary: homeRel,
      relativePath: homeRel,
      content: body.slice(0, 12000),
      truncated: body.length > 12000,
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/** List files under a workspace-relative directory. */
export function listFiles(ctx: AgentToolContext, opts: { relativePath?: string; limit?: number } = {}): AgentToolResult {
  const tool = "list_files";
  try {
    const rel = normalizeRel(opts.relativePath || ".");
    const abs = !rel || rel === "." ? ctx.workspaceRoot : absOf(ctx.workspaceRoot, rel);
    if (leavesVault(ctx.workspaceRoot, abs)) {
      return { ok: false, tool, error: `outside vault: ${rel}` };
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return { ok: false, tool, error: `not found: ${rel}` };
    }
    const limit = Math.min(Math.max(opts.limit || 200, 1), 500);
    const ignore = loadVaultIgnoreSync(ctx.workspaceRoot);
    const files: string[] = [];
    for (const entry of dirents) {
      if (files.length >= limit) break;
      if (shouldSkipVaultDirName(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = !rel || rel === "." ? entry.name : `${rel}/${entry.name}`;
      if (pathMatchesUserIgnore(childRel, ignore)) continue;
      if (entry.isSymbolicLink() && isEscapingSymlinkSync(ctx.workspaceRoot, childAbs)) continue;
      files.push(childRel);
    }
    return {
      ok: true,
      tool,
      summary: `${rel} (${files.length})`,
      files,
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Stat a path (existence / size / mtime). */
export function statPath(ctx: AgentToolContext, relativePath: string): AgentToolResult {
  const tool = "stat_path";
  try {
    const rel = normalizeRel(relativePath);
    if (!rel) return { ok: false, tool, error: "relativePath required" };
    const abs = absOf(ctx.workspaceRoot, rel);
    if (leavesVault(ctx.workspaceRoot, abs)) return { ok: false, tool, error: `outside vault: ${rel}` };
    const st = statSafe(abs);
    if (!st) return { ok: false, tool, error: `not found: ${rel}` };
    return {
      ok: true,
      tool,
      summary: rel,
      relativePath: rel,
      size: st.size,
      isDirectory: st.isDirectory(),
      mtime: st.mtime.toISOString(),
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Lightweight workspace health (contract + top-level roles). */
export function workspaceHealth(ctx: AgentToolContext): AgentToolResult {
  const tool = "workspace_health";
  try {
    const issues: string[] = [];
    const yamlPath = path.join(ctx.workspaceRoot, "topmind.yaml");
    if (!fs.existsSync(yamlPath)) issues.push("missing topmind.yaml");
    else {
      try {
        const contract = ctx.kernel.loadContract(ctx.workspaceRoot);
        if (!contract) issues.push("contract unreadable");
      } catch {
        issues.push("contract load failed");
      }
    }
    for (const dir of ["00-Inbox", "memory"]) {
      if (!fs.existsSync(path.join(ctx.workspaceRoot, dir))) issues.push(`missing ${dir}/`);
    }
    return { ok: issues.length === 0, tool, summary: issues.length ? `${issues.length} issue(s)` : "ok", issues };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Lifecycle delete via Kernel executeDelete (graded confirm).
 * Content writes stay auto; only delete/rename become pending in confirm mode.
 */
export function deletePath(
  ctx: AgentToolContext,
  opts: { relativePath: string; confirmed?: boolean },
): AgentToolResult {
  const tool = "delete_path";
  try {
    const rel = normalizeRel(opts.relativePath);
    if (!rel || !isSafeRel(rel)) return { ok: false, tool, error: "invalid relativePath" };
    const abs = absOf(ctx.workspaceRoot, rel);
    if (leavesVault(ctx.workspaceRoot, abs)) return { ok: false, tool, error: "path-escapes-workspace" };
    if (!fs.existsSync(abs)) return { ok: false, tool, error: `not found: ${rel}` };
    const mode = ctx.writebackMode === "confirm" ? "confirm" : "auto";
    // LIFECYCLE: AI never self-confirms. Only an explicit host/user confirm
    // (opts.confirmed === true from a user RPC) may skip the confirm gate.
    const confirmed = opts.confirmed === true;
    const kernel = ctx.kernel as KernelApi & {
      executeDelete?: (o: Record<string, unknown>) => Record<string, unknown>;
    };
    if (typeof kernel.executeDelete !== "function") {
      return { ok: false, tool, error: "executeDelete unavailable in kernel" };
    }
    const contract = kernel.loadContract(ctx.workspaceRoot);
    const r = kernel.executeDelete({
      targetPath: abs,
      workspaceRoot: ctx.workspaceRoot,
      contract,
      actor: ctx.actor || "ai",
      confirmed,
      writebackModeOverride: mode,
    });
    const pendingId = r?.pending ? stashPendingWrite({ workspaceRoot: ctx.workspaceRoot, relativePath: rel, toolName: tool, operation: "delete", content: isTextNotePath(rel) ? fs.readFileSync(abs, "utf8").slice(0, 20000) : "" }).id : undefined;
    const reversible = Boolean(r?.backupPath);
    return {
      ok: r?.wroteFiles !== false && !r?.pending,
      tool,
      summary: rel,
      relativePath: rel,
      reversible,
      pendingId,
      pending: Boolean(r?.pending),
      needsConfirm: Boolean(r?.needsConfirm || r?.pending),
      note: r?.note
        || (reversible
          ? "Deleted with trash copy (locked/core — recoverable from Archive)."
          : "Deleted ordinary open note (no trash copy)."),
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * In-place rename via the Kernel write gate (Desktop path-ops parity).
 * evaluateWritePermission + executeWrite to the new path, then unlink old —
 * never a raw fs.rename that skips writeback.
 */
export function renamePath(
  ctx: AgentToolContext,
  opts: { relativePath: string; newPath: string; confirmed?: boolean },
): AgentToolResult {
  const tool = "rename_path";
  try {
    const rel = normalizeRel(opts.relativePath);
    const dest = normalizeRel(opts.newPath);
    if (!rel || !dest || !isSafeRel(rel) || !isSafeRel(dest)) {
      return { ok: false, tool, error: "invalid path" };
    }
    const abs = absOf(ctx.workspaceRoot, rel);
    const destAbs = absOf(ctx.workspaceRoot, dest);
    if (leavesVault(ctx.workspaceRoot, abs) || leavesVault(ctx.workspaceRoot, destAbs)) return { ok: false, tool, error: "path-escapes-vault" };
    if (!fs.existsSync(abs)) return { ok: false, tool, error: `not found: ${rel}` };
    if (fs.existsSync(destAbs)) return { ok: false, tool, error: `dest exists: ${dest}` };
    const content = fs.readFileSync(abs, "utf8");
    const kernel = ctx.kernel as KernelApi & {
      evaluateWritePermission?: (o: Record<string, unknown>) => { allowed: boolean; reason?: string };
    };
    const contract = kernel.loadContract(ctx.workspaceRoot);
    const mode = ctx.writebackMode || "auto";
    // Desktop path-ops: rename is a content-class write. AI cannot self-confirm
    // in confirm mode — only a user RPC may pass confirmed:true.
    const confirmed = ctx.actor === "user" ? true : opts.confirmed === true;
    if (typeof kernel.evaluateWritePermission === "function") {
      const perm = kernel.evaluateWritePermission({
        contract,
        targetPath: abs,
        workspaceRoot: ctx.workspaceRoot,
        role: "deep-work",
        actor: ctx.actor || "ai",
        writebackModeOverride: mode,
      });
      if (!perm?.allowed) {
        return { ok: false, tool, error: `write denied: ${perm?.reason || ""}` };
      }
    }
    const ev = kernel.executeWrite({
      targetPath: destAbs,
      content,
      workspaceRoot: ctx.workspaceRoot,
      contract,
      role: "deep-work",
      operation: "create",
      actor: ctx.actor || "ai",
      confirmed,
      writebackModeOverride: mode === "confirm" ? "confirm" : "auto",
    });
    if (ev?.pending) {
      return {
        ok: false,
        tool,
        summary: rel,
        relativePath: rel,
        pending: true,
        needsConfirm: true,
        note: "rename pending — accept in Suggest",
      };
    }
    // A refused or failed destination write must never delete the source.
    if (ev?.wroteFiles === false || ev?.wrote_files === false || ev?.operation === "skip" ||
        !fs.existsSync(destAbs) || fs.readFileSync(destAbs, "utf8") !== content) {
      return { ok: false, tool, relativePath: rel, error: "destination-write-not-verified" };
    }
    if (fs.readFileSync(abs, "utf8") !== content) return { ok: false, tool, relativePath: rel, error: "source-changed-during-move" };
    fs.unlinkSync(abs);
    return {
      ok: true,
      tool,
      summary: `${rel} → ${dest}`,
      relativePath: dest,
      from: rel,
      affectedFiles: ev?.affectedFiles || [dest],
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Glob-like name match (simple * / ** on relative paths; no shell). */
export function globFiles(ctx: AgentToolContext, opts: { pattern?: string; limit?: number; scope?: string; includeArchive?: boolean } = {}): AgentToolResult {
  const tool = "glob_files";
  try {
    const pattern = String(opts.pattern || "").trim();
    if (!pattern) return { ok: false, tool, error: "pattern required" };
    const limit = Math.min(Math.max(opts.limit || 100, 1), 500);
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const rxSource = "^" + esc.split("**/").join("\u0001").split("**").join("\u0000").split("*").join("[^/]*").split("\u0000").join(".*").split("\u0001").join("(?:.*/)?") + "$";
    const rx = new RegExp(rxSource, "u");
    const scope = normalizeRel(opts.scope || "");
    if (scope && !isSafeRel(scope)) return { ok: false, tool, error: "invalid scope" };
    const skipDirs = new Set([".topmind", ".git", "node_modules"]);
    if (!opts.includeArchive) skipDirs.add(resolveArchiveDir(ctx.kernel, ctx.workspaceRoot, ctx.engineRoot));
    const hits = walkFiles(ctx.workspaceRoot, { maxFiles: 4000, workspaceRoot: ctx.workspaceRoot, skipDirs })
      .map(absolute => path.relative(ctx.workspaceRoot, absolute).replace(/\\/gu, "/"))
      .filter((rel) => (!scope || rel.startsWith(`${scope}/`)) && rx.test(rel))
      .slice(0, limit);
    return { ok: true, tool, summary: `${hits.length} match(es)`, files: hits };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}


/**
 * web_search via host-injected HTTP — DDG HTML + shared ranker (Desktop parity).
 * Returns scored shortlist so the model can fetch_url the best hits.
 */
export async function webSearch(
  ctx: AgentToolContext,
  opts: { query?: string; limit?: number } = {},
): Promise<AgentToolResult> {
  const tool = "web_search";
  const query = String(opts.query || "").trim();
  if (!query) return { ok: false, tool, error: "query is required" };
  if (typeof ctx.fetchPage !== "function") {
    return { ok: false, tool, error: "fetchPage not provided by host" };
  }
  const limit = Math.max(1, Math.min(Number(opts.limit) || 6, 8));
  try {
    const r = await ctx.fetchPage(ddgSearchUrl(query));
    if (!r.ok) {
      return {
        ok: false,
        tool,
        error: r.error || `search HTTP ${r.status}`,
        hint: "搜索服务暂不可用。可稍后重试，或用 fetch_url 打开已知网址。",
      };
    }
    const results = rankResults(parseDdgHtmlLite(r.text || ""), { limit });
    return {
      ok: true,
      tool,
      summary: `${results.length} hits for "${query}"`,
      query,
      count: results.length,
      results,
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/** fetch_url via host-injected HTTP (Obsidian requestUrl). http(s) only. */
export async function fetchUrl(
  ctx: AgentToolContext,
  opts: { url?: string; maxLen?: number },
): Promise<AgentToolResult> {
  const tool = "fetch_url";
  const url = String(opts.url || "").trim();
  if (!/^https?:\/\//iu.test(url)) {
    return { ok: false, tool, error: "only http(s) URLs are allowed" };
  }
  if (typeof ctx.fetchPage !== "function") {
    return { ok: false, tool, error: "fetchPage not provided by host" };
  }
  // GitHub markdown → raw.githubusercontent (clean MD + relative image rewrite).
  // README targets still fall through to HTML (host has no multi-ref probe).
  let fetchTarget = url;
  const githubRef = parseGithubFileUrl(url);
  if (githubRef) {
    fetchTarget = githubRawUrl(githubRef);
  }
  try {
    const r = await ctx.fetchPage(fetchTarget);
    let text = String(r.text || "");
    if (r.ok && githubRef) {
      text = rewriteGithubMarkdownImages(text, githubRef);
    }
    const maxLen = Math.max(1, Math.min(50000, opts.maxLen || 12000));
    const clipped = text.slice(0, maxLen);
    return {
      ok: Boolean(r.ok),
      tool,
      summary: githubRef ? `${url} → raw` : url,
      url,
      status: r.status,
      content: clipped,
      truncated: text.length > maxLen,
      error: r.error,
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Create topic home `{category}/{YYYY-name}/topic.md` (Desktop create_topic parity). */
export function createTopic(
  ctx: AgentToolContext,
  opts: { category?: string; name?: string; title?: string; content?: string },
): AgentToolResult {
  const tool = "create_topic";
  try {
    const category = normalizeRel(opts.category);
    const name = String(opts.name || "").trim();
    if (!category || !isSafeRel(category) || !name) return { ok: false, tool, error: "category and name required" };
    const year = new Date().getFullYear();
    const topicDir = `${category}/${year}-${sanitizeFileName(name)}`;
    const homeRel = `${topicDir}/topic.md`;
    const abs = absOf(ctx.workspaceRoot, homeRel);
    if (leavesVault(ctx.workspaceRoot, abs)) return { ok: false, tool, error: "path-escapes-vault" };
    if (fs.existsSync(abs)) return { ok: false, tool, error: `topic exists: ${homeRel}` };
    const body =
      String(opts.content || "") ||
      `---\ntopic: ${name}\ncategory: ${category}\n---\n\n# ${opts.title || name}\n`;
    const kernel = ctx.kernel;
    const contract = kernel.loadContract(ctx.workspaceRoot);
    const mode = ctx.writebackMode || "auto";
    const ev = kernel.executeWrite({
      targetPath: abs,
      content: (() => {
        const sanitized = sanitizeAiWriteBody(body);
        return sanitized && typeof sanitized === "object" && "text" in sanitized
          ? String(sanitized.text || "")
          : body;
      })(),
      workspaceRoot: ctx.workspaceRoot,
      contract,
      role: "topic",
      operation: "create",
      actor: ctx.actor || "ai",
      confirmed: true,
      writebackModeOverride: mode === "confirm" ? "confirm" : "auto",
    });
    return {
      ok: ev?.wroteFiles !== false && !ev?.pending,
      tool,
      summary: homeRel,
      relativePath: homeRel,
      topicId: topicDir,
      pending: Boolean(ev?.pending),
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Move a note into a topic directory (Desktop move_to_topic parity, simplified). */
export function moveToTopic(
  ctx: AgentToolContext,
  opts: { relativePath?: string; targetTopicId?: string },
): AgentToolResult {
  const rel = normalizeRel(opts.relativePath);
  const topicId = normalizeRel(opts.targetTopicId);
  if (!isSafeRel(rel) || !isSafeRel(topicId)) return { ok: false, tool: "move_to_topic", error: "invalid path" };
  const base = path.basename(rel);
  const moved = renamePath(ctx, { relativePath: rel, newPath: `${topicId}/${base}`, confirmed: false });
  return { ...moved, tool: "move_to_topic", topicId };
}

/** Publish a delivery snapshot into the delivery role dir (Desktop publish_to_outputs parity). */
export function publishToOutputs(
  ctx: AgentToolContext,
  opts: { relativePath?: string },
): AgentToolResult {
  const tool = "publish_to_outputs";
  try {
    const rel = normalizeRel(opts.relativePath);
    if (!rel || !isSafeRel(rel)) return { ok: false, tool, error: "relativePath required" };
    const abs = absOf(ctx.workspaceRoot, rel);
    if (leavesVault(ctx.workspaceRoot, abs)) return { ok: false, tool, error: "path-escapes-vault" };
    if (!fs.existsSync(abs)) return { ok: false, tool, error: `not found: ${rel}` };
    const delivery = resolveDeliveryDir(ctx.kernel, ctx.workspaceRoot, ctx.engineRoot);
    const base = rel.split("/").pop() || rel;
    const dest = `${delivery.replace(/\/+$/, "")}/${base}`;
    const destAbs = absOf(ctx.workspaceRoot, dest);
    if (leavesVault(ctx.workspaceRoot, destAbs)) return { ok: false, tool, error: "path-escapes-vault" };
    if (fs.existsSync(destAbs)) return { ok: false, tool, error: `dest exists: ${dest}` };
    const content = fs.readFileSync(abs, "utf8");
    const kernel = ctx.kernel;
    const contract = kernel.loadContract(ctx.workspaceRoot);
    const mode = ctx.writebackMode || "auto";
    const ev = kernel.executeWrite({
      targetPath: destAbs,
      content,
      workspaceRoot: ctx.workspaceRoot,
      contract,
      role: "delivery",
      operation: "create",
      actor: ctx.actor || "ai",
      confirmed: true,
      writebackModeOverride: mode === "confirm" ? "confirm" : "auto",
    });
    return {
      ok: ev?.wroteFiles !== false && !ev?.pending,
      tool,
      summary: dest,
      relativePath: dest,
      source: rel,
      pending: Boolean(ev?.pending),
    };
  } catch (err) {
    return { ok: false, tool, error: err instanceof Error ? err.message : String(err) };
  }
}


/** Discovery returns compact metadata; bodies and linked references are loaded on demand. */
export function listSkills(_ctx: AgentToolContext): AgentToolResult {
  const skills = bundledSkills();
  return { tool: "list_skills", ok: true, summary: `${skills.length} skill(s)`, skills };
}

export function loadSkill(_ctx: AgentToolContext, opts: { skillId?: string }): AgentToolResult {
  const id = String(opts.skillId || "");
  const content = bundledSkillResource("SKILL.md", id);
  return content === null
    ? { tool: "load_skill", ok: false, error: `skill not found: ${id}` }
    : { tool: "load_skill", ok: true, skillId: id, content, truncated: false };
}

/**
 * Route a parsed tool call to a Kernel-backed handler.
 * `read_file` / `edit_file` stay in kernel-workspace-ops (window + unique-span).
 */
export async function runAgentTool(
  ctx: AgentToolContext,
  call: Record<string, unknown>,
): Promise<AgentToolResult | null> {
  call = normalizeAgentToolCall(call);
  const tool = String(call.tool);
  switch (tool) {
    case "search":
      return searchWorkspace(ctx, {
        query: String(call.query || ""),
        scope: typeof call.scope === "string" ? call.scope : undefined,
        maxResults: typeof call.maxResults === "number" ? call.maxResults : undefined,
        regex: Boolean(call.regex),
        includeArchive: Boolean(call.includeArchive),
        context: typeof call.context === "number" ? call.context : undefined,
      });
    case "list_categories":
      return listCategories(ctx);
    case "workspace_overview":
      return workspaceOverview(ctx);
    case "list_topics":
      return listTopics(ctx, String(call.category || ""));
    case "list_topic_files":
      return listTopicFiles(ctx, String(call.topicId || ""));
    case "get_topic":
      return getTopic(ctx, String(call.topicId || call.relativePath || ""));
    case "list_files":
      return listFiles(ctx, {
        relativePath: typeof call.relativePath === "string" ? call.relativePath : undefined,
        limit: typeof call.limit === "number" ? call.limit : undefined,
      });
    case "stat_path":
      return statPath(ctx, String(call.relativePath || ""));
    case "glob_files":
      return globFiles(ctx, {
        pattern: typeof call.pattern === "string" ? call.pattern : undefined,
        limit: typeof call.maxResults === "number" ? call.maxResults : undefined,
        scope: typeof call.scope === "string" ? call.scope : undefined,
        includeArchive: call.includeArchive === true,
      });
    case "web_search":
      return webSearch(ctx, {
        query: typeof call.query === "string" ? call.query : undefined,
        limit: typeof call.limit === "number" ? call.limit : undefined,
      });
    case "fetch_url":
      return fetchUrl(ctx, { url: typeof call.url === "string" ? call.url : undefined, maxLen: typeof call.maxLen === "number" ? call.maxLen : undefined });
    case "create_topic":
      return createTopic(ctx, {
        category: typeof call.category === "string" ? call.category : undefined,
        name: typeof call.name === "string" ? call.name : undefined,
        title: typeof call.title === "string" ? call.title : undefined,
        content: typeof call.content === "string" ? call.content : undefined,
      });
    case "move_to_topic":
      return moveToTopic(ctx, {
        relativePath: typeof call.relativePath === "string" ? call.relativePath : typeof call.inboxRelativePath === "string" ? call.inboxRelativePath : undefined,
        targetTopicId: typeof call.targetTopicId === "string" ? call.targetTopicId : undefined,
      });
    case "publish_to_outputs":
      return publishToOutputs(ctx, {
        relativePath: typeof call.relativePath === "string" ? call.relativePath : undefined,
      });
    case "workspace_health":
      return workspaceHealth(ctx);
    case "list_skills":
      return listSkills(ctx);
    case "load_skill":
      return loadSkill(ctx, { skillId: typeof call.skillId === "string" ? call.skillId : undefined });
    case "load_skill_resource": {
      const content = bundledSkillResource(String(call.path || call.relativePath || ""), typeof call.skillId === "string" ? call.skillId : undefined);
      return content === null ? { tool, ok: false, error: "skill-resource-not-found" } : { tool, ok: true, content, truncated: false };
    }
    case "delete_path":
      // Never accept model-supplied confirmed — AI cannot self-approve deletes.
      return deletePath(ctx, {
        relativePath: String(call.relativePath || ""),
        confirmed: false,
      });
    case "rename_path":
      return renamePath(ctx, {
        relativePath: String(call.relativePath || ""),
        newPath: String(call.newPath || call.destRelativePath || (call.newName && !/[\\/]/u.test(String(call.newName)) ? path.join(path.dirname(String(call.relativePath || "")), String(call.newName)) : "")),
        confirmed: false,
      });
    case "list_inbox":
      return listInbox(ctx);
    case "list_outputs":
      return listOutputs(ctx);
    case "list_todos":
      return listTodos(ctx, {
        completed: Boolean(call.completed),
        limit: typeof call.limit === "number" ? call.limit : undefined,
      });
    case "save_note":
      return saveFile(ctx, { relativePath: `${String(call.topicId || "")}/${String(call.filename || "")}`, content: String(call.content ?? "") });
    case "save_file":
      return saveFile(ctx, {
        relativePath: String(call.relativePath || ""),
        content: String(call.content ?? ""),
      });
    case "add_todo":
      if (Array.isArray(call.items)) {
        if (!call.items.length || call.items.length > 20 || call.items.some(item => typeof item !== "string" || !item.trim())) return { tool, ok: false, error: "invalid-todo-batch" };
        const results = call.items.map(item => addTodo(ctx, { text: String(item), dueDate: typeof call.dueDate === "string" ? call.dueDate : undefined }));
        return { tool, ok: results.every(result => result.ok), results, count: results.filter(result => result.ok).length, relativePath: ctx.kernel.resolveTodoRelPath?.(ctx.workspaceRoot) || "memory/todo.md" };
      }
      return addTodo(ctx, {
        text: String(call.text || ""),
        dueDate: typeof call.dueDate === "string" ? call.dueDate : undefined,
      });
    case "update_todo":
    case "set_todo_due":
    case "delete_todo": {
      const needle = String(call.idOrText || "").trim();
      const parsed = ctx.kernel.readTodoList(ctx.workspaceRoot);
      const items = (parsed?.items || []).filter(isRecord);
      const exact = items.filter(item => item.id === needle || String(item.text || "").toLowerCase() === needle.toLowerCase());
      const matches = exact.length ? exact : items.filter(item => needle && String(item.text || "").toLowerCase().includes(needle.toLowerCase()));
      if (matches.length > 1) return { ok: false, tool, error: "ambiguous-todo", hint: "Use the exact id from list_todos." };
      const id = String(matches[0]?.id || "");
      if (!id) return { ok: false, tool, error: "todo-not-found", hint: "Call list_todos and use its exact id." };
      const contract = ctx.kernel.loadContract(ctx.workspaceRoot);
      const options = { actor: ctx.actor || "ai" as const, confirmed: true, writebackModeOverride: ctx.writebackMode };
      let result;
      if (tool === "delete_todo") result = ctx.kernel.deleteTodoItem?.(ctx.workspaceRoot, id, contract, options);
      else if (tool === "set_todo_due") {
        if (call.dueDate === "") call.dueDate = null;
        if (call.dueDate !== null && (typeof call.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(call.dueDate))) return { ok: false, tool, error: "dueDate-must-be-ISO-date-or-null" };
        result = ctx.kernel.setTodoDueDate?.(ctx.workspaceRoot, id, call.dueDate as string | null, contract, options);
      } else {
        const text = String(call.newText || call.text || "").trim();
        if (!text) return { ok: false, tool, error: "newText-required" };
        // Kernel update clears absent due dates; explicitly preserve the live date.
        const existing = items.find(item => item.id === id);
        const dueDate = call.dueDate === null || typeof call.dueDate === "string" ? call.dueDate : typeof existing?.dueDate === "string" ? existing.dueDate : null;
        result = ctx.kernel.updateTodoItem?.(ctx.workspaceRoot, id, text, contract, { ...options, dueDate });
      }
      return { tool, ok: result?.ok === true, items: result?.items, relativePath: result?.targetPath, error: result ? undefined : "kernel-tool-unavailable" };
    }
    case "list_pending_writes":
      return { tool, ok: true, items: listPendingWrites(ctx.workspaceRoot).map(({ content: _content, ...item }) => item) };
    case "list_recent_memories":
      return { tool, ok: true, content: (ctx.kernel.readProfileActiveBody?.(ctx.workspaceRoot) || "").slice(0, 6000), truncated: true };
    case "list_recent_stream": {
      const periods = await ctx.kernel.listStreamPeriods({ workspaceRoot: ctx.workspaceRoot, engineRoot: ctx.engineRoot, limit: typeof call.limit === "number" ? Math.max(1, Math.min(50, call.limit)) : 8 });
      return { tool, ok: true, periods, hint: "Use read_file on a returned relPath to read entries." };
    }
    case "toggle_todo":
      return toggleTodo(ctx, {
        id: typeof call.id === "string" ? call.id : undefined,
        text: String(call.idOrText || ""),
        completed: typeof call.completed === "boolean" ? call.completed : undefined,
      });
    default:
      return null;
  }
}

export { contentHash, normalizeRel, isSafeRel, stripFrontmatter, sanitizeFileName };
