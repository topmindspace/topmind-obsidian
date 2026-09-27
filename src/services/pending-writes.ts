/**
 * Pending write queue for confirm-mode (保存前问我 / 删除归档前问我).
 *
 * Durable system plane: `{workspace}/.topmind/pending-writes.json`
 * (Desktop `pending-writes.mjs` parity). Restart must not silently drop
 * stashes the user still needs to accept/reject. When full, new stashes are
 * rejected — never silently dropped. Not content truth.
 */

import fs from "node:fs";
import path from "node:path";

export interface PendingWrite {
  id: string;
  relativePath: string;
  content: string;
  toolName?: string;
  createdAt: string;
}

const MAX_PENDING = 20;

/** Optional workspace root for durable persistence. Tests may omit and use memory-only. */
let workspaceRoot: string | null = null;

export function setPendingWritesWorkspace(root: string | null): void {
  workspaceRoot = root ? String(root) : null;
  if (workspaceRoot) loadFromDisk();
}

function pendingWritesPath(): string | null {
  if (!workspaceRoot) return null;
  return path.join(workspaceRoot, ".topmind", "pending-writes.json");
}

const memory = new Map<string, PendingWrite>();

function loadFromDisk(): void {
  const abs = pendingWritesPath();
  if (!abs) return;
  try {
    if (!fs.existsSync(abs)) return;
    const raw: unknown = JSON.parse(fs.readFileSync(abs, "utf8"));
    const items = raw && typeof raw === "object" && "items" in raw ? (raw as { items?: unknown }).items : undefined;
    const list = Array.isArray(items) ? items : [];
    memory.clear();
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id === "string" && typeof e.relativePath === "string" && typeof e.content === "string") {
        memory.set(e.id, {
          id: e.id,
          relativePath: e.relativePath.replace(/\\/g, "/"),
          content: e.content,
          toolName: typeof e.toolName === "string" ? e.toolName : undefined,
          createdAt: typeof e.createdAt === "string" ? e.createdAt : new Date().toISOString(),
        });
      }
    }
  } catch {
    /* corrupt system-plane file → keep in-memory (fail closed on loss, not crash) */
  }
}

function saveToDisk(): void {
  const abs = pendingWritesPath();
  if (!abs) return;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const payload = {
      items: [...memory.values()].slice(0, MAX_PENDING),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(abs, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* disk write failure must not crash the confirm UI */
  }
}

export function stashPendingWrite(opts: {
  relativePath: string;
  content: string;
  toolName?: string;
}): PendingWrite {
  const id = `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: PendingWrite = {
    id,
    relativePath: String(opts.relativePath || "").replace(/\\/g, "/"),
    content: String(opts.content ?? ""),
    toolName: opts.toolName || "write",
    createdAt: new Date().toISOString(),
  };
  if (!entry.relativePath || !entry.content) {
    throw new Error("stashPendingWrite requires relativePath and content");
  }
  if (memory.size >= MAX_PENDING) {
    // Desktop parity: reject new stashes when full — never silently drop.
    throw new Error("pending-writes queue is full — resolve existing confirms first");
  }
  memory.set(id, entry);
  saveToDisk();
  return entry;
}

export function listPendingWrites(): PendingWrite[] {
  return [...memory.values()];
}

export function takePendingWrite(id: string): PendingWrite | null {
  const e = memory.get(id);
  if (e) {
    memory.delete(id);
    saveToDisk();
  }
  return e || null;
}

export function rejectPendingWrite(id: string): boolean {
  const ok = memory.delete(id);
  if (ok) saveToDisk();
  return ok;
}

/** Put an entry back (accept failed after take). Keeps the original id. */
export function restorePendingWrite(entry: PendingWrite): void {
  if (!entry?.id || !entry.relativePath) return;
  memory.set(entry.id, entry);
  saveToDisk();
}

/** Test-only: drop the queue (memory + disk). */
export function clearPendingWrites(): void {
  memory.clear();
  saveToDisk();
}
