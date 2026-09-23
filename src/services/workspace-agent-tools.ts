// ── Obsidian chat agent tools (pure Kernel + fs; no Obsidian imports) ───────
//
// Behavior contract mirrors Desktop `ai-tools.mjs` / WorkspaceService scan+path
// ops so the agent can discover, write, and organize — not just read/edit.
// All writes go through Kernel `executeWrite` (unique write gate).

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { KernelApi } from "../bridge/kernel-loader.ts";
import { stripFrontmatter, sanitizeFileName } from "../utils.ts";
import { stashPendingWrite } from "./pending-writes.ts";
import { sanitizeAiWriteBody } from "#kernel/ai-content-sanitize.mjs";

export type AgentWriteMode = "auto" | "confirm";

export interface AgentToolContext {
  kernel: KernelApi;
  workspaceRoot: string;
  engineRoot?: string;
  writebackMode?: AgentWriteMode;
  actor?: "ai" | "user";
  /** Vault config folder name (Vault#configDir) — not always ".obsidian". */
  configDir?: string;
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

function walkFiles(root: string, opts: { maxFiles?: number; skipDirs?: Set<string> } = {}): string[] {
  const maxFiles = opts.maxFiles || 4000;
  const skip = opts.skipDirs || new Set([".topmind", ".git", "node_modules", ".obsidian"]); // .obsidian is last-resort fallback
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) break;
      if (name.startsWith(".") || skip.has(name)) continue;
      const abs = path.join(dir, name);
      const st = statSafe(abs);
      if (!st) continue;
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        out.push(abs);
      }
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
  skipDirs.add(ctx.configDir || ".obsidian");
  if (!opts.includeArchive) skipDirs.add(archiveName);

  const results: Array<{ relativePath: string; line: number; preview: string }> = [];
  let filesScanned = 0;
  let truncated = false;

  for (const abs of walkFiles(walkRoot, { skipDirs, maxFiles: 3000 })) {
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
    for (const name of listDirSafe(catDir)) {
      if (name.startsWith(".")) continue;
      const st = statSafe(path.join(catDir, name));
      if (st?.isDirectory()) topicCount += 1;
      else if (st?.isFile()) looseNotes += 1;
    }
    return { ...c, topicCount, looseNotes };
  });

  const inboxDir = resolveInboxDir(ctx.kernel, root, ctx.engineRoot);
  const deliveryDir = resolveDeliveryDir(ctx.kernel, root, ctx.engineRoot);
  const inboxItems = listDirSafe(path.join(root, inboxDir)).filter((n) => n.endsWith(".md"));
  const outputItems = listDirSafe(path.join(root, deliveryDir)).filter((n) => !n.startsWith("."));

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
  if (!statSafe(catDir)?.isDirectory()) {
    return { ok: false, tool: "list_topics", category: cat, error: `category not found: ${cat}`, hint: "Call list_categories or workspace_overview first." };
  }
  const topics: Array<{ id: string; name: string; fileCount: number }> = [];
  const looseNotes: Array<{ name: string; relativePath: string }> = [];
  for (const name of listDirSafe(catDir)) {
    if (name.startsWith(".")) continue;
    const abs = path.join(catDir, name);
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
  if (!statSafe(dir)?.isDirectory()) {
    return { ok: false, tool: "list_topic_files", topicId: id, error: `topic not found: ${id}` };
  }
  const files = listDirSafe(dir)
    .filter((n) => !n.startsWith("."))
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
    ctx.kernel.ensureTodoFile?.(ctx.workspaceRoot);
    // Kernel readTodoList returns `{ items, rawContent, relPath, … } | null`
    // (Desktop pathOps.listTodos parity) — never a bare array.
    const parsed = ctx.kernel.readTodoList(ctx.workspaceRoot);
    const raw = Array.isArray(parsed?.items) ? parsed.items : [];
    const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit) || 50)));
    const all = (raw as Record<string, unknown>[]).map((t) => ({
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

  const targetPath = absOf(ctx.workspaceRoot, rel);
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
        pendingId = stashPendingWrite({ relativePath: rel, content, toolName: tool }).id;
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

export function toggleTodo(ctx: AgentToolContext, opts: { id?: string; text?: string }): AgentToolResult {
  const tool = "toggle_todo";
  try {
    ctx.kernel.ensureTodoFile?.(ctx.workspaceRoot);
    const contract = ctx.kernel.loadContract(ctx.workspaceRoot);
    const parsed = ctx.kernel.readTodoList(ctx.workspaceRoot);
    const list = Array.isArray(parsed?.items) ? (parsed.items as Record<string, unknown>[]) : [];
    let id = opts.id ? String(opts.id) : "";
    if (!id && opts.text) {
      const needle = String(opts.text).trim().toLowerCase();
      const hit = list.find(
        (t) => String(t.text || "").trim().toLowerCase() === needle || String(t.text || "").toLowerCase().includes(needle),
      );
      id = hit?.id ? String(hit.id) : "";
    }
    if (!id) {
      return {
        ok: false,
        tool,
        error: "todo not found",
        hint: "Call list_todos first and pass id= (or an exact text snippet).",
      };
    }
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

/**
 * Route a parsed tool call to a Kernel-backed handler.
 * `read_file` / `edit_file` stay in kernel-workspace-ops (window + unique-span).
 */
export function runAgentTool(
  ctx: AgentToolContext,
  call: Record<string, unknown>,
): AgentToolResult | null {
  const tool = String(call.tool || call.name || "");
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
    case "list_inbox":
      return listInbox(ctx);
    case "list_outputs":
      return listOutputs(ctx);
    case "list_todos":
      return listTodos(ctx, {
        completed: Boolean(call.completed),
        limit: typeof call.limit === "number" ? call.limit : undefined,
      });
    case "save_file":
      return saveFile(ctx, {
        relativePath: String(call.relativePath || ""),
        content: String(call.content ?? ""),
      });
    case "add_todo":
      return addTodo(ctx, {
        text: String(call.text || ""),
        dueDate: typeof call.dueDate === "string" ? call.dueDate : undefined,
      });
    case "toggle_todo":
      return toggleTodo(ctx, {
        id: typeof call.id === "string" ? call.id : undefined,
        text: typeof call.text === "string" ? call.text : undefined,
      });
    default:
      return null;
  }
}

export const AGENT_TOOL_NAMES = Object.freeze([
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
  "add_todo",
  "toggle_todo",
]);

export { contentHash, normalizeRel, isSafeRel, stripFrontmatter, sanitizeFileName };
