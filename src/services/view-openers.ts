// ── Shared view openers (single place for workspace leaf + settings nav) ────
//
// Views and the plugin entry used to copy these three helpers. Keep one
// implementation so "open Stream / open Copilot / open Settings" cannot drift.

import { TFile, type App, type WorkspaceLeaf } from "obsidian";
import {
  VIEW_TYPE_STREAM_WORKBENCH,
  VIEW_TYPE_SIDEBAR_DOCK,
} from "../constants";

/** Open the Stream workbench in a new main-area tab (reveal if already open). */
export async function openStreamWorkbench(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_STREAM_WORKBENCH);
  if (existing.length > 0) {
    await app.workspace.revealLeaf(existing[0]);
    return;
  }
  // New leaf — never replace the tab the user is currently reading.
  const leaf = app.workspace.getLeaf(true);
  await leaf.setViewState({
    type: VIEW_TYPE_STREAM_WORKBENCH,
    active: true,
  });
}

/** Open the AI Copilot sidebar dock (reveal if already open). */
export async function openSidebarDock(app: App): Promise<WorkspaceLeaf | null> {
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_DOCK);
  if (existing.length > 0) {
    await app.workspace.revealLeaf(existing[0]);
    return existing[0];
  }
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) return null;
  await leaf.setViewState({
    type: VIEW_TYPE_SIDEBAR_DOCK,
    active: true,
  });
  await app.workspace.revealLeaf(leaf);
  return leaf;
}

/** Kernel writes the note on disk; wait for Obsidian to index it before opening. */
export async function openCreatedMarkdownNote(app: App, relativePath: string): Promise<void> {
  const indexed = () => {
    const file = app.vault.getAbstractFileByPath(relativePath);
    return file instanceof TFile ? file : null;
  };
  let file = indexed();
  if (!file) {
    file = await new Promise<TFile>((resolve, reject) => {
      let settled = false;
      let ref: ReturnType<typeof app.vault.on> | null = null;
      let timer: number | null = null;
      const finish = (found: TFile | null) => {
        if (settled) return;
        settled = true;
        if (timer !== null) window.clearTimeout(timer);
        if (ref) app.vault.offref(ref);
        if (found) resolve(found);
        else reject(new Error(`Obsidian has not indexed ${relativePath}`));
      };
      ref = app.vault.on("create", created => {
        if (created.path === relativePath && created instanceof TFile) finish(created);
      });
      // Close the race between the first lookup and event subscription.
      const appeared = indexed();
      if (appeared) finish(appeared);
      else timer = window.setTimeout(() => finish(indexed()), 5000);
    });
  }
  const leaf = app.workspace.getLeaf(true);
  await leaf.openFile(file);
  await app.workspace.revealLeaf(leaf);
}

/**
 * Open this plugin's settings tab.
 * Obsidian exposes `app.setting` only via an undocumented runtime shape —
 * isolated here so the cast lives in one place.
 */
export function openPluginSettings(app: App, pluginId: string): void {
  const setting = (
    app as unknown as {
      setting?: { open: () => void; openTabById: (id: string) => void };
    }
  ).setting;
  setting?.open();
  setting?.openTabById(pluginId);
}
