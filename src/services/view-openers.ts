// ── Shared view openers (single place for workspace leaf + settings nav) ────
//
// Views and the plugin entry used to copy these three helpers. Keep one
// implementation so "open Stream / open Copilot / open Settings" cannot drift.

import { type App, type WorkspaceLeaf } from "obsidian";
import {
  VIEW_TYPE_STREAM_WORKBENCH,
  VIEW_TYPE_SIDEBAR_DOCK,
} from "../constants";

/** Open the Stream workbench in a new main-area tab (reveal if already open). */
export async function openStreamWorkbench(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_STREAM_WORKBENCH);
  if (existing.length > 0) {
    void app.workspace.revealLeaf(existing[0]);
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
    void app.workspace.revealLeaf(existing[0]);
    return existing[0];
  }
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) return null;
  await leaf.setViewState({
    type: VIEW_TYPE_SIDEBAR_DOCK,
    active: true,
  });
  return leaf;
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
