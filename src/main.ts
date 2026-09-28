// ── topmind Stream for Obsidian — Plugin Main Entry ────────────────────────
//
// This is the single entry point loaded by Obsidian (manifest.json → main.js).
// It registers views, commands, settings, and ribbon icon.
//
// AI Key Persistence: In addition to Obsidian's data.json, AI keys are backed
// up to {vault}/.topmind/ai-keys-backup.json on every save. On load, if the
// main data has no AI keys but a backup exists, keys are restored from backup.
// This protects against data.json being wiped during plugin updates (BRAT,
// manual install, Obsidian sync conflicts, etc.).

import { Plugin, WorkspaceLeaf, Notice, setIcon } from "obsidian";
import { DEFAULT_SETTINGS, migrateSettings, hasConfiguredProvider, isAiProviderType, type TopmindSettings } from "./types.ts";
import { isRecord, parseJsonUnknown } from "./utils.ts";
import {
  VIEW_TYPE_STREAM_WORKBENCH,
  VIEW_TYPE_SIDEBAR_DOCK,
  VIEW_TYPE_MEMORY_BROWSE,
  CMD_QUICK_CAPTURE,
  CMD_OPEN_WORKBENCH,
  CMD_OPEN_SIDEBAR,
  CMD_ORGANIZE_PERIOD,
  CMD_REFRESH_SUGGESTIONS,
  CMD_MAINTAIN_TODOS,
  CMD_TOPIC_CLASSIFY,
  CMD_MEMORY_ORGANIZE,
  CMD_OPEN_PROFILE,
  CMD_OPEN_INBOX,
} from "./constants.ts";
import { KernelService } from "./services/kernel-service.ts";
import { aiTaskManager, type TaskProgress } from "./services/ai-task-manager.ts";
import { TopmindSettingTab } from "./settings/settings-tab";
import { StreamWorkbenchView } from "./views/stream-workbench-view";
import { SidebarDockView } from "./views/sidebar-dock-view";
import { MemoryBrowseView } from "./views/memory-browse-view";
import { QuickCaptureModal } from "./views/quick-capture-modal";
import { setLocale, t, type LocaleKey } from "./i18n";

// ── AI Key Backup / Restore ───────────────────────────────────────────────
//
// Backup file path relative to vault root.
const AI_KEYS_BACKUP_PATH = ".topmind/ai-keys-backup.json";

/**
 * Extract only the AI-relevant fields for backup (don't backup everything —
 * just the irreplaceable key material that users would have to re-enter).
 */
function extractAiBackup(settings: TopmindSettings): Record<string, unknown> {
  return {
    ai: parseJsonUnknown(JSON.stringify(settings.ai)),
    aiProvider: settings.aiProvider,
    aiApiKey: settings.aiApiKey,
    aiBaseUrl: settings.aiBaseUrl,
    aiModel: settings.aiModel,
    backupVersion: 1,
    backupAt: new Date().toISOString(),
  };
}

/**
 * Merge AI keys from backup into settings (only fills missing keys —
 * never overwrites keys that already exist in the current settings).
 */
function mergeAiBackup(settings: TopmindSettings, backup: Record<string, unknown>): TopmindSettings {
  const merged = { ...settings };
  // Deep-clone ai to avoid mutating the original
  merged.ai = {
    sourcePreference: settings.ai.sourcePreference,
    defaultModel: settings.ai.defaultModel,
    manual: { ...settings.ai.manual },
  };

  const backupAi = isRecord(backup.ai) ? backup.ai : null;
  if (backupAi) {
    const backupManual = isRecord(backupAi.manual) ? backupAi.manual : null;
    if (backupManual) {
      // Fill missing keys from backup (write-through to merged.ai.manual).
      const manualTarget: Record<string, unknown> = merged.ai.manual;
      for (const key of Object.keys(backupManual)) {
        const currentVal = manualTarget[key];
        const backupVal = backupManual[key];
        const currentEmpty = currentVal == null || currentVal === "";
        if (currentEmpty && typeof backupVal === "string" && backupVal) {
          manualTarget[key] = backupVal;
        }
      }
    }
    if (!merged.ai.sourcePreference && typeof backupAi.sourcePreference === "string" && backupAi.sourcePreference) {
      merged.ai.sourcePreference = backupAi.sourcePreference;
    }
    if (!merged.ai.defaultModel && typeof backupAi.defaultModel === "string" && backupAi.defaultModel) {
      merged.ai.defaultModel = backupAi.defaultModel;
    }
  }

  // Also check legacy fields. aiBaseUrl / aiModel defaults are non-empty
  // sentinels — "unset" means "still default", so restore when current is the
  // default AND the backup carries a non-default value (the old
  // `!merged.aiBaseUrl` guard could never fire).
  const LEGACY_BASEURL_DEFAULT = "https://api.deepseek.com/v1";
  const LEGACY_MODEL_DEFAULT = "deepseek-chat";
  if (!merged.aiApiKey && backup.aiApiKey) {
    merged.aiApiKey = String(backup.aiApiKey);
  }
  if (
    merged.aiBaseUrl === LEGACY_BASEURL_DEFAULT &&
    typeof backup.aiBaseUrl === "string" &&
    backup.aiBaseUrl &&
    backup.aiBaseUrl !== LEGACY_BASEURL_DEFAULT
  ) {
    merged.aiBaseUrl = backup.aiBaseUrl;
  }
  if (
    merged.aiModel === LEGACY_MODEL_DEFAULT &&
    typeof backup.aiModel === "string" &&
    backup.aiModel &&
    backup.aiModel !== LEGACY_MODEL_DEFAULT
  ) {
    merged.aiModel = backup.aiModel;
  }
  if (merged.aiProvider === "none" && isAiProviderType(backup.aiProvider) && backup.aiProvider !== "none") {
    merged.aiProvider = backup.aiProvider;
  }

  return merged;
}

/**
 * Check if settings have any AI keys configured.
 */
function settingsHaveAiKeys(settings: TopmindSettings): boolean {
  return hasConfiguredProvider(settings.ai) || Boolean(settings.aiApiKey);
}

/** True when the backup payload carries at least one usable secret/endpoint. */
function backupHasAiKeys(backup: Record<string, unknown>): boolean {
  const ai = isRecord(backup.ai) ? backup.ai : null;
  const manual = ai && isRecord(ai.manual) ? ai.manual : null;
  if (manual) {
    for (const [k, v] of Object.entries(manual)) {
      if (k === "baseUrlOverrides") continue;
      if (typeof v === "string" && v) return true;
    }
  }
  if (typeof backup.aiApiKey === "string" && backup.aiApiKey) return true;
  return false;
}

export default class TopmindPlugin extends Plugin {
  declare settings: TopmindSettings;
  kernelService!: KernelService;
  private statusBarEl: HTMLElement | null = null;
  private suggestCount = 0;
  private aiTaskUnsub: (() => void) | null = null;
  private settingTab: TopmindSettingTab | null = null;
  /** Set in onunload — guards onLayoutReady callbacks that outlive the plugin. */
  private _unloaded = false;

  async onload(): Promise<void> {
    // Two-layer style load:
    // 1) token bootstrap — guarantees --tm-* exists even if styles.css is rejected
    // 2) full styles.css read from disk and injected here — bypasses the host
    //    plugin-CSS loader, which can silently drop or partially apply the sheet.
    await this.injectStyles();

    try {
      await this._onload();
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err);
      console.error("[topmind] onload failed:", err);
      // Show a visible notice so users know what went wrong (esp. on Windows)
      new Notice(`[topmind] ${t("notice_load_failed")}: ${msg.slice(0, 200)}`, 10000);
      throw err; // Re-throw so Obsidian also reports it
    }
  }

  /**
   * Style bootstrap. Obsidian's plugin-CSS pipeline has repeatedly failed to
   * paint this UI (tokens empty, sheets dropped). We therefore:
   *   1) inject tokens
   *   2) inject the real styles.css from disk
   *   3) inject a LAST-WORD layer using CSS system colors that cannot fail
   *      to resolve, plus a visible load marker for diagnostics.
   */
  private async injectStyles(): Promise<void> {
    const parts: string[] = [];

    parts.push([
      ":root{",
      "--tm-radius-sm:4px;--tm-radius-ctl:8px;--tm-radius-card:12px;--tm-radius-pill:999px;",
      "--tm-hit:32px;--tm-hit-sm:28px;--tm-hit-lg:36px;--tm-hit-xs:24px;",
      "--tm-gap-xs:4px;--tm-gap-sm:6px;--tm-gap-md:8px;--tm-gap-lg:12px;",
      "--tm-feed-max-width:46rem;",
      "--tm-bg-page:var(--background-secondary);--tm-bg-card:var(--background-primary);",
      "--tm-bg-soft:var(--interactive-normal);--tm-bg-hover:var(--background-modifier-hover);",
      "--tm-bg-sunken:var(--background-primary-alt);",
      "--tm-line:var(--background-modifier-border);",
      "--tm-line-strong:var(--background-modifier-border-hover,var(--background-modifier-border));",
      "--tm-ink:var(--text-normal);--tm-ink-soft:var(--text-muted);--tm-ink-faint:var(--text-faint);",
      "--tm-accent:var(--interactive-accent);--tm-accent-ink:var(--text-accent,var(--interactive-accent));",
      "--tm-accent-soft:var(--nav-item-background-active,var(--background-modifier-hover));",
      "--tm-accent-softer:var(--nav-item-background-active,var(--background-modifier-hover));",
      "--tm-on-surface:var(--text-normal);--tm-on-surface-var:var(--text-muted);",
      "--tm-state-hover:var(--background-modifier-hover);",
      "--tm-shadow-card:var(--shadow-xs,none);--tm-elev-1:var(--shadow-xs,none);--tm-input-shadow:var(--input-shadow,none);",
      "--tm-type-display:var(--font-ui-large);--tm-type-title:var(--font-ui-medium);",
      "--tm-type-body:var(--font-ui-small);--tm-type-label:var(--font-ui-small);--tm-type-meta:var(--font-ui-smaller);",
      "--tm-lh-body:var(--line-height-normal,1.5);--tm-lh-tight:var(--line-height-tight,1.25);",
      "--tm-transition:120ms ease",
      "}",
    ].join(""));

    const dir = this.manifest.dir;
    let loadedFromDisk = false;
    if (dir) {
      try {
        const raw = await this.app.vault.adapter.read(`${dir}/styles.css`);
        if (raw && raw.length > 100) {
          parts.push(raw);
          loadedFromDisk = true;
        }
      } catch (err) {
        console.error("[topmind] styles.css read failed:", err);
      }
    }

    // LAST WORD — leaf-scoped + !important so host-loaded styles.css cannot
    // overwrite us. Use native Obsidian vars (proven working via mod-cta).
    // System colors were only for diagnosis; now we paint with the theme.
    parts.push([
      ".workspace-leaf-content .tm-page,.workspace-leaf-content .tm-wb-shell{box-sizing:border-box;width:100%;max-width:48rem;margin:0 auto;padding:16px clamp(18px,3vw,36px) 32px;display:flex;flex-direction:column;gap:10px}",
      ".workspace-leaf-content .tm-wb-hero,.workspace-leaf-content .tm-wb-section{gap:8px;margin:0}",
      ".workspace-leaf-content .tm-wb-hero-title{display:flex;align-items:baseline;gap:8px!important;flex-wrap:wrap;font-size:var(--font-ui-medium)!important;font-weight:600!important}",
      ".workspace-leaf-content .tm-wb-hero-title .tm-section-controls{margin-left:auto;display:flex;align-items:center;gap:6px}",
      ".workspace-leaf-content .tm-wb-compose{display:flex;flex-direction:column!important;background:var(--background-primary-alt)!important;border:1px solid var(--background-modifier-border)!important;border-radius:12px!important;padding:12px 14px 10px!important;box-shadow:none!important;gap:6px!important}",
      ".workspace-leaf-content .tm-wb-compose:focus-within{border-color:var(--interactive-accent)!important;box-shadow:0 0 0 3px var(--background-modifier-border-focus,transparent)!important}",
      ".workspace-leaf-content .tm-wb-compose .tm-input-field,.workspace-leaf-content .tm-chat-input{background:transparent!important;border:none!important;box-shadow:none!important;color:var(--text-normal)!important;min-height:44px!important;max-height:160px!important;padding:8px 10px!important}",
      ".workspace-leaf-content .tm-wb-compose-foot{margin-top:0!important;padding-top:4px!important;border-top:none!important;display:flex;align-items:center;gap:8px;flex-wrap:nowrap}",

      /* buttons — ghost / secondary / primary / icon tools */
      ".workspace-leaf-content button{font-family:inherit}",
      ".workspace-leaf-content .tm-toolbar-nav-btn,.workspace-leaf-content .tm-btn-ghost,.workspace-leaf-content .tm-toolbar-btn,.workspace-leaf-content .tm-card-action-btn,.workspace-leaf-content .tm-btn-mini,.workspace-leaf-content .tm-chat-msg-btn,.workspace-leaf-content .tm-chat-clear-btn{background:transparent!important;border:none!important;border-radius:8px!important;box-shadow:none!important;color:var(--text-muted)!important;padding:6px 10px!important;transition:background-color .12s ease,color .12s ease}",
      ".workspace-leaf-content .tm-toolbar-nav-btn:hover,.workspace-leaf-content .tm-btn-ghost:hover,.workspace-leaf-content .tm-toolbar-btn:hover,.workspace-leaf-content .tm-card-action-btn:hover,.workspace-leaf-content .tm-btn-mini:hover,.workspace-leaf-content .tm-chat-msg-btn:hover,.workspace-leaf-content .tm-chat-clear-btn:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}",
      ".workspace-leaf-content .tm-btn-secondary,.workspace-leaf-content .tm-btn-polish,.workspace-leaf-content .tm-btn-open,.workspace-leaf-content .tm-btn-dismiss{background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;border-radius:8px!important;box-shadow:none!important;color:var(--text-normal)!important;padding:6px 12px!important;transition:background-color .12s ease}",
      ".workspace-leaf-content .tm-btn-secondary:hover,.workspace-leaf-content .tm-btn-polish:hover{background:var(--background-modifier-hover)!important;border-color:var(--background-modifier-border-hover,var(--background-modifier-border))!important}",
      ".workspace-leaf-content .tm-submit-btn,.workspace-leaf-content .tm-btn-primary,.workspace-leaf-content .tm-btn-init-workspace,.workspace-leaf-content .mod-cta,.workspace-leaf-content .tm-sidebar-capture-primary{background:var(--interactive-accent)!important;border:none!important;border-radius:8px!important;color:var(--text-on-accent)!important;font-weight:600!important;box-shadow:none!important;padding:8px 16px!important;transition:background-color .12s ease}",
      ".workspace-leaf-content .tm-submit-btn:hover,.workspace-leaf-content .tm-btn-primary:hover,.workspace-leaf-content .mod-cta:hover,.workspace-leaf-content .tm-sidebar-capture-primary:hover{background:var(--interactive-accent-hover)!important;color:var(--text-on-accent)!important}",

      /* tabs: text + underline */
      ".workspace-leaf-content .tm-tab-bar{background:transparent!important;border-bottom:1px solid var(--background-modifier-border)!important;padding:0 8px!important;gap:2px!important}",
      ".workspace-leaf-content .tm-tab-btn{background:transparent!important;border:none!important;border-radius:6px!important;color:var(--text-muted)!important;padding:8px 10px!important;font-weight:500!important;transition:background-color .12s ease,color .12s ease}",
      ".workspace-leaf-content .tm-tab-btn:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}",
      ".workspace-leaf-content .tm-tab-btn.tm-tab-active,.workspace-leaf-content .tm-tab-btn[aria-selected=true]{background:transparent!important;color:var(--text-normal)!important;font-weight:600!important}",
      ".workspace-leaf-content .tm-tab-btn.tm-tab-active::after{content:'';position:absolute;left:50%;bottom:0;translate:-50% 0;width:calc(100% - 16px);height:2px;border-radius:1px;background:var(--interactive-accent)}",

      /* cards */
      ".workspace-leaf-content .tm-wb-card,.workspace-leaf-content .tm-card,.workspace-leaf-content .tm-memory-card{background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;border-radius:10px!important;padding:12px 14px!important;margin:0 0 8px!important;box-shadow:0 1px 2px rgba(0,0,0,.04)!important;display:block!important;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}",
      ".workspace-leaf-content .tm-wb-card:hover,.workspace-leaf-content .tm-card:hover,.workspace-leaf-content .tm-memory-card:hover{background:var(--background-primary)!important;border-color:var(--background-modifier-border-hover,var(--background-modifier-border))!important;box-shadow:0 2px 8px rgba(0,0,0,.06)!important}",
      ".workspace-leaf-content .tm-card-header.tm-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px!important;min-height:22px!important;margin:0 0 4px!important;padding:0!important}",
      ".workspace-leaf-content .tm-card-time,.workspace-leaf-content .tm-day-count{font-size:var(--font-ui-smaller)!important;color:var(--text-faint);flex-shrink:0}",
      ".workspace-leaf-content .tm-card-actions{margin-left:auto!important;opacity:0;transition:opacity .12s ease;display:flex;gap:2px}",
      ".workspace-leaf-content .tm-card:hover .tm-card-actions{opacity:1}",
      ".workspace-leaf-content .tm-card-body{font-size:var(--font-ui-small)!important;line-height:var(--line-height-normal,1.5)!important;color:var(--text-normal)}",
      ".workspace-leaf-content .tm-day-group{display:flex;flex-direction:column;gap:0!important;margin:0 0 18px!important;background:transparent!important;border:0!important;padding:0!important}",
      ".workspace-leaf-content .tm-day-label{font-size:var(--font-ui-medium)!important;font-weight:600!important}",

      /* chips / segment */
      ".workspace-leaf-content button.tm-feed-layout-btn{border:1px solid var(--background-modifier-border)!important;background:var(--background-primary)!important;border-radius:8px!important;color:var(--text-muted)!important;padding:4px 10px!important;transition:background-color .12s ease,color .12s ease}",
      ".workspace-leaf-content button.tm-feed-layout-btn:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}",
      ".workspace-leaf-content button.tm-feed-layout-btn[data-active=true]{background:var(--nav-item-background-active,var(--background-modifier-hover))!important;color:var(--text-normal)!important;font-weight:600!important}",

      /* sidebar */
      ".workspace-leaf-content .tm-sidebar-header-min{min-height:0!important;padding:2px 8px!important;border-bottom:none!important}",
      ".workspace-leaf-content .tm-chat-input-area{flex-direction:column!important;gap:6px!important}",
      ".workspace-leaf-content .tm-chat-input-foot{display:flex!important;align-items:center;gap:8px}",
      ".workspace-leaf-content .tm-chat-input-foot .tm-footer-left{margin-right:auto!important;display:flex!important;align-items:center;gap:8px!important;min-width:0}",
      ".workspace-leaf-content .tm-chat-input-foot .tm-footer-right{margin-left:auto!important;display:flex!important;align-items:center;gap:6px!important;flex-shrink:0}",
      ".workspace-leaf-content .tm-footer-status{width:18px!important;height:18px!important;border-radius:50%!important;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}",
      ".workspace-leaf-content .tm-footer-status .tm-status-dot{width:7px!important;height:7px!important}",
      ".workspace-leaf-content .tm-chat-input-foot .tm-header-model{margin-left:0!important}",
      ".workspace-leaf-content .tm-chat-input-foot .tm-header-model-select{max-width:110px!important;height:24px!important;font-size:var(--font-ui-smaller)!important}",
      ".workspace-leaf-content .tm-sidebar-action-btn{background:transparent!important;border:none!important;border-radius:8px!important;color:var(--text-muted)!important;padding:8px 12px!important;transition:background-color .12s ease}",
      ".workspace-leaf-content .tm-sidebar-action-btn:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}",

      /* chat */
      ".workspace-leaf-content .tm-chat-message.tm-chat-user{background:var(--interactive-accent)!important;color:var(--text-on-accent)!important;border-radius:12px!important;border:none!important}",
      ".workspace-leaf-content .tm-chat-message.tm-chat-ai{background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;border-radius:12px!important;box-shadow:none!important}",
      ".workspace-leaf-content .tm-chat-context-bar{color:var(--text-muted)!important;padding:2px 0!important;gap:6px!important}",
      ".workspace-leaf-content .tm-chip,.workspace-leaf-content .tm-chat-context-chip{background:var(--background-modifier-hover)!important;border:none!important;border-radius:999px!important;padding:3px 10px!important;color:var(--text-muted)!important}",
      ".workspace-leaf-content .tm-feed-chrome{gap:6px!important;margin:8px 0 16px!important;flex-wrap:wrap}",
    
      ".workspace-leaf-content .tm-chat-input{width:100%!important;min-height:56px!important;max-height:140px!important;padding:10px 12px!important;border:1px solid var(--background-modifier-border)!important;border-radius:8px!important;background:var(--background-primary)!important;color:var(--text-normal)!important;font-size:var(--font-ui-small)!important}",
      ".workspace-leaf-content .tm-chat-input:focus{outline:none!important;border-color:var(--interactive-accent)!important;box-shadow:0 0 0 3px var(--background-modifier-border-focus,transparent)!important}",
      ".workspace-leaf-content .tm-suggestion-actions .tm-btn-confirm,.workspace-leaf-content .tm-suggestion-actions .tm-btn-open,.workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss{height:28px!important;min-width:72px!important;padding:0 14px!important;border-radius:8px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;font-size:var(--font-ui-small)!important}",
      ".workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss{background:transparent!important;border:none!important;color:var(--text-muted)!important;width:auto!important}",
      ".workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}",
      ".workspace-leaf-content .tm-chat-role{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}",

      ".workspace-leaf-content .tm-suggestion-card{background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;border-left:3px solid var(--background-modifier-border)!important;border-radius:10px!important;padding:12px 14px!important;margin:0 0 8px!important;box-shadow:none!important}",
      ".workspace-leaf-content .tm-suggestion-card:hover{background:var(--background-modifier-hover)!important}",
      ".workspace-leaf-content .tm-todo-item{display:flex!important;align-items:flex-start;gap:8px!important;padding:8px 10px!important;border-radius:8px!important;transition:background-color .12s ease}",
      ".workspace-leaf-content .tm-todo-item:hover{background:var(--background-modifier-hover)!important}",
      ".workspace-leaf-content .tm-todo-item.tm-completed{opacity:.55!important}",
      ".workspace-leaf-content .tm-history-item{display:flex!important;align-items:center;gap:8px!important;padding:8px 10px!important;border-radius:8px!important;transition:background-color .12s ease}",
      ".workspace-leaf-content .tm-history-item:hover{background:var(--background-modifier-hover)!important}",
      ".workspace-leaf-content .tm-empty-state{padding:28px 16px!important;text-align:center!important;color:var(--text-muted)!important}",
      ".workspace-leaf-content .tm-empty-title{font-size:var(--font-ui-medium)!important;font-weight:600!important;color:var(--text-normal)!important;margin-bottom:4px}",
      ".workspace-leaf-content .tm-empty-hint{font-size:var(--font-ui-smaller)!important;color:var(--text-faint)!important;max-width:32ch;margin:0 auto}",

      ".workspace-leaf-content .tm-chat-role,.workspace-leaf-content .tm-task-progress-inline span,.workspace-leaf-content .tm-suggestion-summary,.workspace-leaf-content .tm-empty-title,.workspace-leaf-content .tm-empty-hint{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}",
      ".workspace-leaf-content .tm-task-progress-inline{display:flex!important;align-items:center!important;gap:8px!important;width:100%!important;min-width:0!important}",
      ".workspace-leaf-content .tm-header-model{min-width:0!important;max-width:100%!important;overflow:hidden!important;flex:0 1 auto!important}",
      ".workspace-leaf-content .tm-header-model-select{max-width:96px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}",
      ".workspace-leaf-content .tm-footer-left{min-width:0!important;overflow:hidden!important;flex:1 1 auto!important}",
      ".workspace-leaf-content .tm-footer-right{flex-shrink:0!important;gap:6px!important}",

      ".workspace-leaf-content,.workspace-leaf-content *{writing-mode:horizontal-tb!important;text-orientation:mixed!important}",
      ".workspace-leaf-content .tm-chat-role,.workspace-leaf-content .tm-task-progress-inline span,.workspace-leaf-content .tm-suggestion-summary,.workspace-leaf-content .tm-empty-title,.workspace-leaf-content .tm-empty-hint,.workspace-leaf-content .tm-tab-label,.workspace-leaf-content .tm-day-label{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;writing-mode:horizontal-tb!important;transform:none!important}",

      ".workspace-leaf-content .tm-header-model-select{width:96px!important;min-width:96px!important;max-width:96px!important;font-family:var(--font-interface)!important;font-size:var(--font-ui-smaller)!important;line-height:1.2!important;height:24px!important;padding:0 2px!important;box-sizing:border-box!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;background:transparent!important;border:none!important;color:var(--text-muted)!important}",
      ".workspace-leaf-content .tm-header-model-static{width:72px!important;min-width:72px!important;max-width:72px!important;font-family:var(--font-interface)!important;font-size:var(--font-ui-smaller)!important;line-height:1.2!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;display:inline-block!important}",
      ".workspace-leaf-content .tm-header-model{display:flex!important;align-items:center!important;gap:4px!important;min-width:0!important;max-width:200px!important;overflow:hidden!important;flex:0 1 auto!important}",
      ".workspace-leaf-content .tm-footer-left{display:flex!important;align-items:center!important;gap:8px!important;min-width:0!important;overflow:hidden!important;flex:1 1 auto!important;margin-right:auto!important}",
      ".workspace-leaf-content .tm-footer-right{display:flex!important;align-items:center!important;gap:6px!important;flex-shrink:0!important;margin-left:auto!important}",
      ".workspace-leaf-content .tm-chat-input-foot{display:flex!important;align-items:center!important;gap:8px!important;width:100%!important;min-height:32px!important}",
      ".workspace-leaf-content .tm-chat-input-foot button{flex-shrink:0!important}",

      ".tm-loading-spinner,.tm-loading-spinner-sm{display:inline-block!important;width:14px!important;height:14px!important;flex-shrink:0!important;border-radius:50%!important;border:2px solid var(--background-modifier-border)!important;border-top-color:var(--interactive-accent)!important;animation:tm-spin .7s linear infinite!important}",
      ".tm-loading-spinner *,.tm-loading-spinner-sm *{animation:none!important;transform:none!important}",
      ".workspace-leaf-content .tm-chat-input-area{display:flex!important;flex-direction:column!important;gap:6px!important}",
      ".workspace-leaf-content .tm-chat-input-foot{display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:space-between!important;gap:8px!important;width:100%!important;min-height:32px!important;flex-wrap:nowrap!important}",
      ".workspace-leaf-content .tm-footer-left{display:flex!important;flex-direction:row!important;align-items:center!important;gap:8px!important;min-width:0!important;overflow:hidden!important;flex:1 1 auto!important}",
      ".workspace-leaf-content .tm-footer-right{display:flex!important;flex-direction:row!important;align-items:center!important;gap:6px!important;flex:0 0 auto!important;flex-shrink:0!important}",
      ".workspace-leaf-content .tm-header-model{display:flex!important;flex-direction:row!important;align-items:center!important;gap:4px!important;min-width:0!important;max-width:180px!important;overflow:hidden!important;flex:0 1 auto!important}",
      ".workspace-leaf-content .tm-header-model-model{width:96px!important;min-width:96px!important;max-width:96px!important}",
      ".workspace-leaf-content .tm-header-model-select{box-sizing:border-box!important;font-family:var(--font-interface)!important;font-size:var(--font-ui-smaller)!important;line-height:1.2!important;height:24px!important;padding:0 2px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;background:transparent!important;border:none!important;color:var(--text-muted)!important}",

      ".workspace-leaf-content .tm-suggestion-summary{color:var(--text-normal)!important;font-size:var(--font-ui-smaller)!important;font-weight:600!important}",
      ".workspace-leaf-content .tm-suggestion-count-badge{background:var(--interactive-accent)!important;color:var(--text-on-accent)!important;border-radius:999px!important;padding:2px 8px!important;font-size:var(--font-ui-smaller)!important;font-weight:600!important}",
      ".workspace-leaf-content .tm-suggestion-actions .tm-btn-open,.workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss{height:28px!important;min-width:72px!important;padding:0 14px!important;border-radius:8px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;font-size:var(--font-ui-small)!important;background:var(--background-primary)!important;border:1px solid var(--background-modifier-border)!important;color:var(--text-normal)!important;font-weight:550!important}",
      ".workspace-leaf-content .tm-suggestion-actions .tm-btn-open:hover,.workspace-leaf-content .tm-suggestion-actions .tm-btn-dismiss:hover{background:var(--background-modifier-hover)!important;border-color:var(--background-modifier-border-hover,var(--background-modifier-border))!important}",
      ".workspace-leaf-content .tm-header-model-model{width:120px!important;min-width:120px!important;max-width:120px!important}",
      ".workspace-leaf-content .tm-header-model-select{height:auto!important;min-height:24px!important;line-height:1.3!important;padding:2px 4px!important}",
      ".workspace-leaf-content .tm-header-model-select option{height:auto!important;min-height:24px!important;line-height:1.3!important;padding:4px 8px!important;font-size:var(--font-ui-small)!important}",
      ".workspace-leaf-content .tm-task-progress-inline{display:flex!important;align-items:center!important;gap:8px!important;width:100%!important;min-width:0!important;flex-direction:row!important}",
      ".workspace-leaf-content .tm-task-progress-inline span{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;flex:1 1 auto!important;min-width:0!important;color:var(--text-muted)!important;font-size:var(--font-ui-smaller)!important}",

      ".tm-task-progress-inline{display:flex!important;align-items:center!important;gap:8px!important;position:relative!important;padding-left:22px!important;flex-direction:row!important}",
      ".tm-task-progress-inline::before{content:''!important;position:absolute!important;left:0!important;top:50%!important;translate:0 -50%!important;width:12px!important;height:12px!important;border-radius:50%!important;border:2px solid var(--background-modifier-border)!important;border-top-color:var(--interactive-accent)!important;animation:tm-spin .7s linear infinite!important;flex-shrink:0!important}",
      ".tm-task-progress-inline > *{animation:none!important;transform:none!important;writing-mode:horizontal-tb!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}",

      ".workspace-leaf-content[data-type=\"topmind-stream-workbench\"] .tm-stream-workbench,.workspace-leaf-content[data-type=\"topmind-memory-browse\"] .tm-memory-browse,.workspace-leaf-content[data-type=\"topmind-sidebar-dock\"] .tm-sidebar-dock{background:var(--background-secondary)!important;background-image:linear-gradient(180deg,color-mix(in srgb,var(--color-blue,var(--interactive-accent)) 6%,var(--background-secondary)) 0%,color-mix(in srgb,var(--color-cyan,var(--color-blue,var(--interactive-accent))) 4%,var(--background-primary-alt)) 48%,var(--background-primary) 100%)!important;background-attachment:fixed!important}",
      ".workspace-leaf-content[data-type=\"topmind-stream-workbench\"] .tm-page,.workspace-leaf-content[data-type=\"topmind-stream-workbench\"] .tm-wb-shell,.workspace-leaf-content[data-type=\"topmind-memory-browse\"] .tm-page{background:transparent!important}"
    ].join("\n"));

    const style = document.createElement("style");
    style.id = "topmind-stream-style";
    style.textContent = parts.join("\n");
    document.head.appendChild(style);
    this.register(() => style.remove());
    console.info(`[topmind] styles injected (fromDisk=${loadedFromDisk}, parts=${parts.length}, bytes=${style.textContent.length})`);
  }

  private async _onload(): Promise<void> {
    // ── Load settings (with migration from old single-provider model) ──
    await this.loadSettings();

    // ── i18n ──
    const appWithLocale: unknown = this.app;
    const obsLocale = (isRecord(appWithLocale) && typeof appWithLocale.locale === "string" && appWithLocale.locale) || "zh-CN";
    const locale = this.settings.localeOverride || (obsLocale.startsWith("en") ? "en-US" : "zh-CN");
    setLocale(locale);

    // ── Kernel Service ──
    this.kernelService = new KernelService(this.app, this, this.settings);
    // Display cache only: operational writeback is topmind.yaml
    this.kernelService.hydrateWritebackModeFromContract();

    // ── Register views ──
    this.registerView(
      VIEW_TYPE_STREAM_WORKBENCH,
      (leaf: WorkspaceLeaf) => new StreamWorkbenchView(leaf, this),
    );
    this.registerView(
      VIEW_TYPE_SIDEBAR_DOCK,
      (leaf: WorkspaceLeaf) => new SidebarDockView(leaf, this),
    );
    this.registerView(
      VIEW_TYPE_MEMORY_BROWSE,
      (leaf: WorkspaceLeaf) => new MemoryBrowseView(leaf, this),
    );

    // ── Ribbon icon: quick capture (pen) ──
    // Obsidian stacks later-registered ribbon icons on top.
    // Register waves first so it sits LAST; pencil second so it sits FIRST.
    this.addRibbonIcon("waves", t("sidebar_open_workbench"), () => {
      void this.openWorkbench();
    });
    this.addRibbonIcon("pencil", t("quick_capture_title"), () => {
      this.openQuickCapture();
    });

    // ── Commands ──
    this.addCommand({
      id: CMD_QUICK_CAPTURE,
      name: t("cmd_quick_capture"),
      callback: () => this.openQuickCapture(),
    });

    this.addCommand({
      id: CMD_OPEN_WORKBENCH,
      name: t("cmd_open_workbench"),
      callback: () => { void this.openWorkbench(); },
    });

    this.addCommand({
      id: CMD_OPEN_SIDEBAR,
      name: t("cmd_open_sidebar"),
      callback: () => { void this.openSidebar(); },
    });

    this.addCommand({
      id: CMD_ORGANIZE_PERIOD,
      name: t("cmd_organize_period"),
      callback: () => { void this.organizePeriod(); },
    });

    this.addCommand({
      id: CMD_REFRESH_SUGGESTIONS,
      name: t("cmd_refresh_suggestions"),
      callback: () => { void this.refreshSuggestions(); },
    });

    this.addCommand({
      id: CMD_MAINTAIN_TODOS,
      name: t("cmd_maintain_todos"),
      callback: () => this.maintainTodos(),
    });

    this.addCommand({
      id: CMD_TOPIC_CLASSIFY,
      name: t("cmd_topic_classify"),
      callback: () => this.classifyTopics(),
    });

    this.addCommand({
      id: CMD_MEMORY_ORGANIZE,
      name: t("cmd_memory_organize"),
      callback: () => this.organizeMemory(),
    });

    this.addCommand({
      id: CMD_OPEN_PROFILE,
      name: t("cmd_open_profile"),
      callback: () => { void this.openMemoryBrowse(); },
    });

    this.addCommand({
      id: CMD_OPEN_INBOX,
      name: t("cmd_open_inbox"),
      callback: () => { void this.openInbox(); },
    });

    // ── Settings tab ──
    this.settingTab = new TopmindSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // ── Status bar entry — AI task state + one-click copilot open ──
    this.initStatusBarItem();

    // ── Auto-open workbench + sidebar on startup ──
    if (this.settings.autoOpenWorkbench) {
      this.app.workspace.onLayoutReady(() => {
        // onLayoutReady is not auto-disposed — skip if the plugin already unloaded.
        if (this._unloaded) return;
        void this.openWorkbench();
        // Also open sidebar for unified AI access
        void this.openSidebar();
      });
    }

    // ── Auto-maintain todos if enabled ──
    if (this.settings.autoMaintainTodos && this.kernelService.isWorkspaceReady()) {
      this.app.workspace.onLayoutReady(() => {
        if (this._unloaded) return;
        // Queued (not direct) so the task badge/history observes boot work too
        void this.enqueueAiOperation("todo_maintain", "op_label_todo_maintain", "notice_todo_done", "sidebar", true);
      });
    }
  }

  onunload(): void {
    this._unloaded = true;
    // Flush any debounced settings keystrokes before tearing down.
    this.settingTab?.flushPending();
    this.settingTab = null;
    this.aiTaskUnsub?.();
    this.aiTaskUnsub = null;
    this.kernelService?.dispose();
  }

  // ── Settings ──────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const loaded: unknown = await this.loadData();
    const raw = isRecord(loaded) ? loaded : null;
    if (raw) {
      this.settings = migrateSettings(raw);
    } else {
      // Deep clone: a shallow copy shares the `ai` object reference with the
      // module-level DEFAULT_SETTINGS constant — editing keys in the settings
      // tab would mutate the constant for the rest of the session.
      this.settings = structuredClone(DEFAULT_SETTINGS);
    }

    // ── AI Key Restore: if data.json had no AI keys, try backup ──
    // Also run when backup has keys and data is partial — mergeAiBackup only
    // fills blanks, so a half-wiped data.json recovers the missing fields.
    try {
      const backup = await this.loadAiKeysBackup();
      if (backup && backupHasAiKeys(backup)) {
        const before = settingsHaveAiKeys(this.settings);
        this.settings = mergeAiBackup(this.settings, backup);
        if (!before && settingsHaveAiKeys(this.settings)) {
          await this.saveData(this.settings);
        }
      }
    } catch (err) {
      console.warn("[topmind] AI keys backup restore failed:", err);
    }
  }

  async saveSettings(): Promise<void> {
    // Defensive: never persist a settings object whose `ai` bag is missing —
    // that is how a partial in-memory reset used to hit disk.
    if (!this.settings?.ai?.manual) {
      console.warn("[topmind] saveSettings skipped: ai.manual missing (refusing to wipe keys)");
      return;
    }
    await this.saveData(this.settings);
    this.kernelService?.updateSettings(this.settings);
    // Write backup in background (non-blocking — main data.json is already saved)
    void this.saveAiKeysBackup().catch((err) => {
      console.warn("[topmind] AI keys backup save failed:", err);
    });
  }

  /**
   * Save AI keys backup to vault's .topmind/ directory.
   * This survives plugin updates even if data.json is wiped.
   *
   * CRITICAL: never overwrite a non-empty backup with empty keys. A transient
   * settings reset (plugin reload race, settings re-render) used to clobber
   * both data.json AND the backup in one save — that is how keys "kept
   * disappearing". The backup is last-known-good, not a mirror of current.
   */
  private async saveAiKeysBackup(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const backupData = extractAiBackup(this.settings);
    if (!backupHasAiKeys(backupData)) {
      // Current snapshot is empty — keep any existing non-empty backup.
      const existing = await this.loadAiKeysBackup();
      if (existing && backupHasAiKeys(existing)) return;
    }
    const json = JSON.stringify(backupData, null, 2);
    // Only write inside an existing system plane: a random vault where the
    // plugin is merely enabled must not grow a `.topmind/` machine dir.
    // After workspace init (topmind.yaml exists) the dir may be created.
    const dir = ".topmind";
    const dirExists = await adapter.exists(dir);
    if (!dirExists && !this.kernelService?.isWorkspaceReady()) return;
    try {
      if (!dirExists) {
        await adapter.mkdir(dir);
      }
    } catch {
      // Directory may already exist — ignore
    }
    await adapter.write(AI_KEYS_BACKUP_PATH, json);
  }

  /**
   * Load AI keys backup from vault's .topmind/ directory.
   * Returns null if backup doesn't exist or is invalid.
   */
  private async loadAiKeysBackup(): Promise<Record<string, unknown> | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (!await adapter.exists(AI_KEYS_BACKUP_PATH)) return null;
      const json = await adapter.read(AI_KEYS_BACKUP_PATH);
      const parsed = parseJsonUnknown(json);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // ── View openers ──────────────────────────────────────────────────────

  openQuickCapture(): void {
    new QuickCaptureModal(this.app, this).open();
  }

  async openWorkbench(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_STREAM_WORKBENCH);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    // New leaf — never replace the tab the user is currently reading.
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_STREAM_WORKBENCH,
      active: true,
    });
  }

  async openSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_DOCK);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({
      type: VIEW_TYPE_SIDEBAR_DOCK,
      active: true,
    });
  }

  /** Open the dock's 建议 tab (status-bar chip / stream strip). */
  async openSidebarSuggestions(): Promise<void> {
    await this.openSidebar();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_DOCK);
    if (leaves.length === 0) return;
    const view = leaves[0].view as unknown as { revealTab?: (tab: "suggestions") => void };
    view.revealTab?.("suggestions");
  }

  // ── Command handlers ──────────────────────────────────────────────────

  private async organizePeriod(): Promise<void> {
    if (!this.kernelService.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return;
    }

    const ctx = await this.kernelService.getStreamContext();
    if (ctx.current) {
      this.kernelService.reconcilePeriod(ctx.current.relPath);
    }

    if (this.settings.autoMaintainTodos) {
      // Queued quiet — badge/history observes it; reconcile itself is sync-scheduled
      void this.enqueueAiOperation("todo_maintain", "op_label_todo_maintain", "notice_todo_done", "sidebar", true);
    }

    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_STREAM_WORKBENCH);
    for (const leaf of leaves) {
      if (leaf.view instanceof StreamWorkbenchView) {
        await leaf.view.refreshAll();
      }
    }
  }

  private async refreshSuggestions(): Promise<void> {
    if (!this.kernelService.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return;
    }
    await this.kernelService.generateSuggestions({ force: true });
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_STREAM_WORKBENCH);
    for (const leaf of leaves) {
      if (leaf.view instanceof StreamWorkbenchView) {
        await leaf.view.refreshSuggestions();
      }
    }
  }

  private maintainTodos(): void {
    if (!this.kernelService.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return;
    }
    new Notice(t("notice_todo_running"));
    void this.enqueueAiOperation("todo_maintain", "op_label_todo_maintain", "notice_todo_done", "sidebar");
  }

  private classifyTopics(): void {
    if (!this.kernelService.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return;
    }
    new Notice(t("notice_classify_running"));
    void this.enqueueAiOperation("topic_classify", "op_label_topic_classify", "notice_classify_done", "suggest");
  }

  private organizeMemory(): void {
    if (!this.kernelService.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return;
    }
    new Notice(t("notice_memory_running"));
    void this.enqueueAiOperation("memory_organize", "op_label_memory_organize", "notice_memory_done", "all");
  }

  // ── Shared AI operation lane ──────────────────────────────────────────

  /**
   * Enqueue an AI operation on the shared serial lane. Command palette, boot
   * auto-maintain, and sidebar buttons all route through the same queue so
   * the task badge + history observe every AI pass (Desktop parity: its
   * background lane is the single writer).
   *
   * @param quiet suppress per-result Notices (boot/background callers) — the
   *              badge/history still observe the task.
   */
  enqueueAiOperation(
    operation: "todo_maintain" | "topic_classify" | "memory_organize",
    labelKey: LocaleKey,
    doneKey: LocaleKey,
    refresh: "sidebar" | "suggest" | "all",
    opts: boolean | { quiet?: boolean; force?: boolean } = false,
  ): void {
    const normalized = typeof opts === "boolean" ? { quiet: opts } : opts;
    const quiet = normalized.quiet === true;
    // Background/boot (quiet) respects processedHashes; explicit user commands re-analyze.
    const force = normalized.force ?? !quiet;
    const label = t(labelKey);
    if (aiTaskManager.isOperationActive(operation)) {
      if (!quiet) new Notice(`${label} ${t("task_running")}`);
      return;
    }
    aiTaskManager.enqueue(operation, label, async () => {
      const result = await this.kernelService.runOperation(operation, { force });
      if (!quiet) {
        if (result.ok) {
          new Notice(result.summary || t(doneKey));
        } else {
          new Notice(`${t("task_result_failed")}: ${result.summary}`);
        }
      }
      this.refreshPluginViews(refresh);
      return result;
    });
  }

  private refreshPluginViews(scope: "sidebar" | "suggest" | "all"): void {
    const sideLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_DOCK);
    for (const leaf of sideLeaves) {
      if (leaf.view instanceof SidebarDockView) {
        void leaf.view.refresh();
      }
    }
    if (scope === "sidebar") return;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_STREAM_WORKBENCH);
    for (const leaf of leaves) {
      if (leaf.view instanceof StreamWorkbenchView) {
        void (scope === "all" ? leaf.view.refreshAll() : leaf.view.refreshSuggestions());
      }
    }
  }

  // ── Status bar entry ──────────────────────────────────────────────────

  /**
   * Persistent Obsidian status bar item (entry-point parity with Desktop's
   * statusbar task toggle): quiet sparkles when idle, spinner + active task
   * label while the AI lane runs. Click opens/reveals the AI copilot sidebar.
   */
  private initStatusBarItem(): void {
    const el = this.addStatusBarItem();
    el.addClass("tm-status-bar-item");
    el.setAttribute("aria-label", t("statusbar_tip"));
    el.setAttribute("data-tooltip-position", "top");
    // Plugin.registerDomEvent — cleaned up automatically on unload.
    this.registerDomEvent(el, "click", () => void this.openSidebar());
    this.statusBarEl = el;
    this.aiTaskUnsub = aiTaskManager.subscribe((progress) => this.updateStatusBarItem(progress));
    this.updateStatusBarItem(aiTaskManager.getProgress());
  }

  private updateStatusBarItem(progress: TaskProgress): void {
    const el = this.statusBarEl;
    if (!el) return;
    el.empty();
    const active = progress.active;
    if (active) {
      el.addClass("tm-status-bar-running");
      el.createSpan({ cls: "tm-status-bar-spinner", attr: { "aria-hidden": "true" } });
      el.createSpan({ text: active.label, cls: "tm-status-bar-label" });
    } else {
      el.removeClass("tm-status-bar-running");
      setIcon(el.createSpan({ cls: "tm-status-bar-icon" }), "sparkles");
      if (progress.queued.length > 0) {
        el.createSpan({
          text: t("task_queued_count", { count: progress.queued.length }),
          cls: "tm-status-bar-label",
        });
      }
    }
    // Global "work waiting" signal (Desktop showSuggestCountChip parity).
    if (this.suggestCount > 0) {
      const chip = el.createEl("button", {
        cls: "tm-status-badge",
        text: t("sidebar_suggestions_count", { count: this.suggestCount }),
        attr: {
          type: "button",
          "aria-label": t("suggestions_open_confirm"),
          title: t("suggestions_open_confirm"),
        },
      });
      this.registerDomEvent(chip, "click", (e: MouseEvent) => {
        e.stopPropagation();
        void this.openSidebarSuggestions();
      });
    }
  }

  /** Called when the suggestion surface refreshes — drives the status-bar chip. */
  setSuggestionCount(count: number): void {
    if (this.suggestCount === count) return;
    this.suggestCount = Math.max(0, count);
    this.updateStatusBarItem(aiTaskManager.getProgress());
  }

  async openMemoryBrowse(): Promise<void> {
    if (!this.kernelService.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return;
    }
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMORY_BROWSE);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      const view = existing[0].view;
      if (view instanceof MemoryBrowseView) await view.refresh();
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_MEMORY_BROWSE, active: true });
  }

  private async openInbox(): Promise<void> {
    if (!this.kernelService.isWorkspaceReady()) {
      new Notice(t("notice_workspace_not_ready"));
      return;
    }
    const model = this.kernelService.getResolvedModel();
    const buffer = model.categories.find((c) => c.role === "buffer");
    if (!buffer) {
      new Notice(t("notice_no_inbox"));
      return;
    }
    // Reveal the inbox folder in Obsidian's file explorer (left sidebar)
    try {
      const adapter = this.app.vault.adapter;
      const inboxPath = buffer.directory;
      if (!await adapter.exists(inboxPath)) {
        await adapter.mkdir(inboxPath);
      }
      const fileItem = this.app.vault.getAbstractFileByPath(inboxPath);
      if (fileItem) {
        const explorer = this.app as { explorer?: { revealFile?: (file: unknown) => void } };
        explorer.explorer?.revealFile?.(fileItem);
      }
    } catch {
      // Fallback: just show a notice
      new Notice(t("notice_no_inbox"));
    }
  }
}
