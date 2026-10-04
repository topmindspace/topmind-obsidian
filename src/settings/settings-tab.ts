// ── Settings Tab: Plugin configuration UI ──────────────────────────────────
//
// Obsidian Settings → Topmind Stream.
// Surface order: workspace · stream · **AI (providers / model / keys)** · security.
//
// AI section design (visible on a fresh enable, not buried):
//   - Status card + user-chosen Desktop export import (no home-directory scan)
//   - Provider chooser (a concrete provider is selected even when nothing
//     is saved yet) + model picker + that provider's key or URL
//   - Connection test + writeback policy
//
// Renders through `getSettingDefinitions()` + stock `Setting` rows so
// Obsidian's own setting-group / setting-item CSS applies (native card +
// info|control row look). Credential controls live ON those definition
// rows. Do NOT append sibling Settings into the group list — the host
// drops those extras on first open. Do NOT nest Settings inside another
// Setting's `settingEl` — that is a flex row and squeezes CJK labels.

import {
  PluginSettingTab,
  Setting,
  Notice,
  type App as ObsidianApp,
  type SettingDefinitionItem,
} from "obsidian";
import type TopmindPlugin from "../main";
import { t, detectObsidianLocale } from "../i18n";
import type { WritebackMode, AiManualKeys } from "../types";
import { hasConfiguredProvider, getProviderKey, isAiProviderType } from "../types";
import {
  AI_PROVIDER_PRESETS,
  PROVIDER_KEY_FIELDS,
  PROVIDER_DEFAULT_MODELS,
} from "../constants";
import {
  resolveProviderCatalog,
  applyModelOptions,
  credentialsForProvider,
  clearModelsDevCache,
} from "../services/models-dev";
import { curatedModelsFor } from "#kernel/model-catalog.mjs";
import { reseedWorkspaceContract } from "../services/kernel-workspace-ops";
import { getKernel } from "../bridge/kernel-loader";
import { StreamWorkbenchView } from "../views/stream-workbench-view";
import { SidebarDockView } from "../views/sidebar-dock-view";
import { VIEW_TYPE_STREAM_WORKBENCH, VIEW_TYPE_SIDEBAR_DOCK } from "../constants";
import fs from "node:fs";
import { openExternalUrl } from "../utils";
import { ConfirmModal } from "../views/confirm-modal";

/** Workspace template options (labels resolved via i18n at render time). */
const TEMPLATE_OPTIONS = [
  { value: "stream", labelKey: "template_stream" },
  { value: "balanced", labelKey: "template_balanced" },
  { value: "research", labelKey: "template_research" },
  { value: "periodic", labelKey: "template_periodic" },
] as const;

type DesktopExportAi = {
  sourcePreference?: string;
  defaultModel?: string;
  manual?: Record<string, unknown>;
};

function curatedModelsForSafe(providerId: string): Array<{ id: string; label: string }> {
  try {
    const list = curatedModelsFor(providerId);
    return (list || []).map((m) => ({ id: String(m.id || ""), label: String(m.label || m.id || "") }));
  } catch {
    return [];
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function readDesktopAi(parsed: unknown): DesktopExportAi | null {
  const ai = asRecord(asRecord(parsed)?.ai);
  if (!ai) return null;
  const manualRaw = asRecord(ai.manual) || {};
  const manual: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manualRaw)) manual[k] = v;
  return {
    sourcePreference: asString(ai.sourcePreference),
    defaultModel: asString(ai.defaultModel),
    manual,
  };
}

type DesktopImport = {
  imported: Partial<AiManualKeys>;
  preference: string;
  model: string;
  encrypted: boolean;
};

/** File the user picked. `path` is the Electron path when the host provides one. */
interface ChosenExportFile {
  text: () => Promise<string>;
  path?: string;
}

/**
 * Parse a Desktop AI export the user already chose.
 * Plaintext keys are copied. safeStorage ciphertext is reported, not installed.
 * This function does not look at the filesystem.
 */
function parseDesktopExport(raw: string): DesktopImport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const ai = readDesktopAi(parsed);
  if (!ai) return null;
  const m = ai.manual || {};
  const imported: Partial<AiManualKeys> = {};
  const looksEncrypted = (val: unknown): boolean => {
    const s = asString(val);
    if (!s) return false;
    return (
      s.startsWith("v10:") ||
      (/^[A-Za-z0-9+/=]{40,}$/.test(s) && !s.startsWith("sk-") && !s.startsWith("AI"))
    );
  };
  let encrypted = false;
  const take = (key: keyof AiManualKeys, srcKey: string) => {
    const val = asString(m[srcKey]);
    if (!val) return;
    if (looksEncrypted(val)) {
      encrypted = true;
      return;
    }
    (imported as Record<string, string>)[key] = val;
  };
  const keyFields: Array<keyof AiManualKeys> = [
    "openAiKey", "anthropicKey", "googleKey", "deepseekKey", "moonshotKey", "zhipuKey",
    "minimaxKey", "xaiKey", "groqKey", "mistralKey", "openrouterKey", "qwenKey",
    "doubaoKey", "siliconflowKey", "baiduKey", "hunyuanKey", "customKey",
  ];
  for (const key of keyFields) take(key, key);
  const customBaseUrl = asString(m.customBaseUrl);
  if (customBaseUrl && !looksEncrypted(customBaseUrl)) imported.customBaseUrl = customBaseUrl;
  const ollamaBaseUrl = asString(m.ollamaBaseUrl);
  if (ollamaBaseUrl && !looksEncrypted(ollamaBaseUrl)) imported.ollamaBaseUrl = ollamaBaseUrl;
  return {
    imported,
    preference: ai.sourcePreference || "",
    model: ai.defaultModel || "",
    encrypted,
  };
}

/** Read only the file the user chose. No directory walk, no fixed paths. */
async function readChosenExport(file: ChosenExportFile): Promise<string> {
  const picked = typeof file.path === "string" ? file.path : "";
  if (picked) return fs.readFileSync(picked, "utf-8");
  return file.text();
}

const KEY_PLACEHOLDERS: Record<string, string> = {
  openai: "sk-...",
  anthropic: "sk-ant-...",
  google: "AI...",
  groq: "gsk_...",
  openrouter: "sk-or-...",
  custom: "sk-...",
};

export class TopmindSettingTab extends PluginSettingTab {
  plugin: TopmindPlugin;
  private templateSelect: HTMLSelectElement | null = null;
  private saveTimer: number | null = null;

  constructor(app: ObsidianApp, plugin: TopmindPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Declarative settings surface (Obsidian 1.13+). `display()` is deprecated
   * and must not be overridden when this returns a non-empty array — the
   * community scanner flags `obsidianmd/settings-tab/no-deprecated-display`.
   * Simple rows bind through `getControlValue`/`setControlValue`; custom
   * rows paint via a `render` callback.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    this.hydrateWriteback();
    this.templateSelect = null;
    const s = this.plugin.settings;

    return [
      {
        type: "group",
        heading: t("settings_workspace"),
        items: [
          {
            name: t("workspace_status"),
            desc: t("settings_workspace_status_desc"),
            render: (setting) => this.renderWorkspaceStatusRow(setting),
          },
          {
            name: t("workspace_contract_doctor"),
            desc: t("workspace_contract_doctor_desc"),
            render: (setting) => this.renderContractDoctorRow(setting),
          },
          {
            name: t("init_workspace"),
            desc: t("init_workspace_desc"),
            render: (setting) => this.renderInitWorkspaceRow(setting),
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_stream"),
        items: [
          {
            name: t("settings_auto_open"),
            desc: t("settings_auto_open_desc"),
            control: { type: "toggle", key: "autoOpenWorkbench", defaultValue: s.autoOpenWorkbench },
          },
          {
            name: t("settings_timeline_order"),
            desc: t("settings_timeline_order_desc"),
            control: {
              type: "dropdown",
              key: "timelineOrder",
              defaultValue: s.timelineOrder,
              options: { desc: t("timeline_desc"), asc: t("timeline_asc") },
            },
          },
          {
            name: t("settings_auto_tag"),
            desc: t("settings_auto_tag_desc"),
            control: { type: "toggle", key: "autoTag", defaultValue: s.autoTag },
          },
          {
            name: t("settings_locale_override"),
            desc: t("settings_locale_override_desc"),
            render: (setting) => this.renderLocaleOverrideRow(setting),
          },
          {
            name: t("settings_feed_layout"),
            desc: t("settings_feed_layout_desc"),
            control: {
              type: "dropdown",
              key: "feedLayout",
              defaultValue: s.feedLayout,
              options: { list: t("feed_layout_list"), card: t("feed_layout_card") },
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_ai"),
        items: [
          {
            name: t("settings_ai_status"),
            desc: t("settings_ai_status_desc"),
            render: (setting) => this.renderAiStatusRow(setting),
          },
          {
            name: t("settings_ai_import"),
            desc: t("settings_ai_import_desc"),
            render: (setting) => this.renderAiImportRow(setting),
          },
          {
            // Real definition rows. A concrete provider is selected even when
            // sourcePreference is empty, so the key/URL control is on screen
            // before anything has been saved. Do not gate these on
            // hasConfiguredProvider, and do not paint extra rows into the
            // group list — the host drops those on first open.
            name: t("settings_ai_provider"),
            desc: t("settings_ai_provider_desc"),
            render: (setting) => this.renderProviderChooser(setting),
          },
          {
            name: t("settings_ai_model"),
            desc: t("settings_ai_model_desc"),
            render: (setting) => this.renderModelPicker(setting),
          },
          {
            name: t("settings_ai_key"),
            desc: t("settings_security_note"),
            render: (setting) => this.renderCredentialRow(setting),
          },
          {
            name: t("settings_ai_test"),
            desc: t("settings_ai_test_desc"),
            render: (setting) => this.renderConnectionTestRow(setting),
          },
          {
            name: t("settings_writeback_mode"),
            desc: t("settings_writeback_mode_desc"),
            control: {
              type: "dropdown",
              key: "writebackMode",
              defaultValue: s.writebackMode,
              options: { auto: t("writeback_auto"), confirm: t("writeback_confirm") },
            },
          },
          {
            name: t("settings_max_agent_steps"),
            desc: t("settings_max_agent_steps_desc"),
            control: {
              type: "slider",
              key: "maxAgentSteps",
              defaultValue: s.maxAgentSteps || 32,
              min: 3,
              max: 80,
              step: 1,
            },
          },
          {
            name: t("settings_auto_suggest"),
            desc: t("settings_auto_suggest_desc"),
            control: { type: "toggle", key: "autoSuggest", defaultValue: s.autoSuggest },
          },
          {
            name: t("settings_auto_maintain_todos"),
            desc: t("settings_auto_maintain_todos_desc"),
            control: { type: "toggle", key: "autoMaintainTodos", defaultValue: s.autoMaintainTodos },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_security"),
        items: [
          {
            name: t("settings_backup_keep"),
            desc: t("settings_backup_keep_desc"),
            control: { type: "slider", key: "backupKeep", defaultValue: s.backupKeep, min: 0, max: 10, step: 1 },
          },
          {
            name: t("settings_receipt_keep"),
            desc: t("settings_receipt_keep_desc"),
            control: { type: "slider", key: "receiptKeep", defaultValue: s.receiptKeep, min: 10, max: 200, step: 10 },
          },
          {
            name: t("settings_backup_ai_keys"),
            desc: t("settings_backup_ai_keys_desc"),
            control: { type: "toggle", key: "backupAiKeysToVault", defaultValue: s.backupAiKeysToVault },
          },
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    return s[key];
  }

  override setControlValue(key: string, value: unknown): void {
    // Guard the AI bag: declarative settings must never replace `ai` wholesale
    // (a reset/re-render writing `ai: {}` is how keys used to vanish).
    if (key === "ai" || key === "aiApiKey" || key === "aiProvider" || key === "aiBaseUrl" || key === "aiModel") {
      console.warn(`[topmind] setControlValue ignored for protected key: ${key}`);
      return;
    }
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    s[key] = value;
    if (key === "writebackMode") {
      this.plugin.kernelService.mirrorWritebackMode(value as WritebackMode);
    }
    void this.save();
    if (key === "localeOverride") {
      void (async () => {
        const { detectObsidianLocale } = await import("../i18n");
        const override = typeof value === "string" ? value : "";
        this.plugin.applyLocale(override || detectObsidianLocale());
        this.update();
        // Re-render open views so chrome text switches immediately.
        this.refreshViews();
      })();
    }
    if (key === "feedLayout" || key === "timelineOrder") {
      this.refreshViews();
    }
  }

  /** Declarative settings hydrate writeback before first paint. */
  private hydrateWriteback(): void {
    const prevWritebackMode = this.plugin.settings.writebackMode;
    this.plugin.kernelService.hydrateWritebackModeFromContract();
    if (this.plugin.settings.writebackMode !== prevWritebackMode) {
      void this.plugin.saveSettings();
    }
  }

  private obsLocale(): string {
    // Public API: getLanguage() via detectObsidianLocale (app.locale is
    // undocumented and missing on current hosts).
    return detectObsidianLocale();
  }

  // ── Row painters (one native Setting row each) ─────────────────────────

  /** Workspace readiness badges into the status row's control column. */
  private renderWorkspaceStatusRow(setting: Setting): void {
    const isReady = this.plugin.kernelService.isWorkspaceReady();
    if (!isReady) {
      setting.controlEl.createSpan({
        cls: "tm-status-badge tm-status-warning",
        text: t("workspace_not_ready"),
      });
      setting.setDesc(t("workspace_not_ready"));
      return;
    }
    try {
      const model = this.plugin.kernelService.getResolvedModel();
      const categories = model.categories || [];
      const categoryCount = categories.filter((c) => !(c as { hidden?: boolean }).hidden).length;
      setting.setDesc(t("workspace_categories_count", { count: categoryCount }));
      const badgeContainer = setting.controlEl.createDiv({ cls: "tm-status-badges" });
      badgeContainer.createSpan({ cls: "tm-status-badge tm-status-ok", text: t("workspace_ready") });
      badgeContainer.createSpan({
        cls: "tm-status-badge tm-status-info",
        text: t("workspace_contract_valid"),
      });
    } catch {
      setting.setDesc(t("workspace_no_categories"));
    }
  }

  /** Diagnose / reseed contract actions. */
  private renderContractDoctorRow(setting: Setting): void {
    setting
      .addButton((btn) =>
        btn.setButtonText(t("workspace_contract_doctor")).onClick(() => {
          try {
            const kernel = getKernel();
            const workspaceRoot = this.plugin.kernelService.getVaultPath();
            const inspect = kernel.inspectContract?.(workspaceRoot);
            if (!inspect) {
              new Notice(t("workspace_contract_doctor_failed"));
              return;
            }
            if (inspect.onDiskValid) {
              new Notice(t("workspace_contract_doctor_ok"));
            } else {
              const ensured = kernel.ensureContract?.(workspaceRoot, {});
              if (ensured?.onDiskValid) {
                new Notice(t("workspace_contract_doctor_fixed"));
                this.plugin.kernelService.invalidateCache();
                this.update();
              } else {
                new Notice(`${t("workspace_contract_doctor_failed")}: ${inspect.errors?.[0] || ""}`);
              }
            }
          } catch (err) {
            new Notice(
              `${t("workspace_contract_doctor_failed")}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t("workspace_contract_reseed")).setDestructive().onClick(() => {
          new ConfirmModal(
            this.app,
            t("workspace_contract_reseed"),
            t("workspace_contract_reseed_confirm"),
            () => {
              try {
                const result = reseedWorkspaceContract(
                  getKernel(),
                  this.plugin.kernelService.getVaultPath(),
                );
                if (result.ok) {
                  new Notice(t("workspace_contract_reseed_ok"));
                  this.plugin.kernelService.invalidateCache();
                  this.update();
                } else {
                  new Notice(`${t("workspace_contract_reseed_failed")}: ${result.error || ""}`);
                }
              } catch (err) {
                new Notice(
                  `${t("workspace_contract_reseed_failed")}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            },
          );
        }),
      );
  }

  /** Template picker + initialize action. */
  private renderInitWorkspaceRow(setting: Setting): void {
    setting.addDropdown((dd) => {
      for (const opt of TEMPLATE_OPTIONS) dd.addOption(opt.value, t(opt.labelKey));
      dd.setValue("stream");
      this.templateSelect = dd.selectEl;
    });
    setting.addButton((btn) =>
      btn.setButtonText(t("init_workspace")).onClick(() => {
        const templateId = this.templateSelect?.value || "stream";
        new ConfirmModal(this.app, t("init_workspace"), t("init_workspace_confirm"), () => {
          const result = this.plugin.kernelService.initWorkspace(templateId);
          if (result.ok) {
            new Notice(t("init_workspace_success"));
            this.update();
          } else {
            new Notice(`${t("init_workspace_failed")}: ${result.error}`);
          }
        });
      }),
    );
  }

  /** Locale override — switches app language immediately. */
  private renderLocaleOverrideRow(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addDropdown((dd) =>
      dd
        .addOption("", t("locale_auto"))
        .addOption("zh-CN", t("locale_zh"))
        .addOption("en-US", t("locale_en"))
        .setValue(s.localeOverride)
        .onChange(async (v) => {
          s.localeOverride = v;
          await this.save();
          const { detectObsidianLocale } = await import("../i18n");
          this.plugin.applyLocale(v || detectObsidianLocale());
          this.update();
          this.refreshViews();
        }),
    );
  }

  /** AI configured status pill. */
  private renderAiStatusRow(setting: Setting): void {
    const aiReady = hasConfiguredProvider(this.plugin.settings.ai);
    const statusText = aiReady ? t("settings_ai_ready") : t("settings_ai_not_configured");
    setting.addText((text) => {
      text.setValue(statusText).setDisabled(true);
      text.inputEl.addClass(aiReady ? "tm-status-input" : "tm-status-input tm-status-input-dim");
    });
    if (aiReady && !this.plugin.settings.ai.defaultModel) {
      setting.infoEl.addClass("tm-setting-hint-accent");
      setting.setDesc(t("settings_ai_model_select_hint_desc"));
    }
  }

  /** Desktop key import — the user picks one file; only that file is read. */
  private renderAiImportRow(setting: Setting): void {
    setting.addButton((btn) =>
      btn.setButtonText(t("settings_ai_import")).onClick(() => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.addEventListener("change", () => {
          const file = input.files?.item(0);
          if (!file) return;
          const pathValue = "path" in file ? (file as { path?: unknown }).path : undefined;
          const chosen: ChosenExportFile = {
            text: () => file.text(),
            path: typeof pathValue === "string" ? pathValue : undefined,
          };
          void this.importChosenExport(chosen);
        });
        input.click();
      }),
    );
  }

  private async importChosenExport(file: ChosenExportFile): Promise<void> {
    const s = this.plugin.settings;
    let raw = "";
    try {
      raw = await readChosenExport(file);
    } catch {
      new Notice(t("settings_ai_import_not_found"));
      return;
    }
    const result = parseDesktopExport(raw);
    if (!result) {
      new Notice(t("settings_ai_import_not_found"));
      return;
    }
    if (result.encrypted && Object.keys(result.imported).length === 0) {
      new Notice(t("settings_ai_import_encrypted"));
      return;
    }
    const m = s.ai.manual as unknown as Record<string, string>;
    let count = 0;
    for (const [key, val] of Object.entries(result.imported)) {
      if (key === "baseUrlOverrides") continue;
      if (typeof val === "string" && val && !m[key]) {
        m[key] = val;
        count++;
      }
    }
    if (result.preference && !s.ai.sourcePreference && isAiProviderType(result.preference)) {
      s.ai.sourcePreference = result.preference;
      s.aiProvider = result.preference;
    }
    if (result.model && !s.ai.defaultModel) s.ai.defaultModel = result.model;
    if (count > 0) {
      await this.save();
      new Notice(t("settings_ai_import_success", { count }));
      this.update();
    } else if (result.encrypted) {
      new Notice(t("settings_ai_import_encrypted"));
    } else {
      new Notice(t("settings_ai_import_nothing"));
    }
  }

  /** Live connection probe. */
  private renderConnectionTestRow(setting: Setting): void {
    setting.addButton((btn) =>
      btn.setButtonText(t("settings_ai_test")).onClick(async () => {
        if (!hasConfiguredProvider(this.plugin.settings.ai)) {
          new Notice(t("settings_ai_not_configured"));
          return;
        }
        btn.setDisabled(true);
        const prev = btn.buttonEl.textContent || "";
        btn.setButtonText(t("settings_ai_testing"));
        try {
          const provider = this.plugin.kernelService.testAiConnection();
          const reply = await provider.generate("ping", { maxTokens: 4 });
          if (reply && reply.trim().length > 0) new Notice(t("settings_ai_test_success"));
          else new Notice(`${t("settings_ai_test_failed")}: empty response`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`${t("settings_ai_test_failed")}: ${msg}`);
        } finally {
          btn.setDisabled(false);
          btn.setButtonText(prev);
        }
      }),
    );
  }

  // ── AI provider board (imperative rows inside the AI group) ────────────

  private isProviderConfigured(pid: string): boolean {
    const s = this.plugin.settings;
    if (pid === "custom") return Boolean(s.ai.manual.customBaseUrl && s.ai.manual.customKey);
    if (pid === "ollama") return Boolean(s.ai.manual.ollamaBaseUrl);
    const field = PROVIDER_KEY_FIELDS[pid];
    return field ? Boolean(getProviderKey(pid, s.ai.manual)) : false;
  }

  /**
   * Provider the chooser and credential row show.
   * Saved preference wins, then the first configured provider, then the
   * first preset — so a fresh install still has a key or URL field.
   */
  private activeProviderId(): string {
    const s = this.plugin.settings;
    const all = Object.keys(AI_PROVIDER_PRESETS);
    const pref = s.ai.sourcePreference;
    if (pref && AI_PROVIDER_PRESETS[pref]) return pref;
    const configured = all.find((id) => this.isProviderConfigured(id));
    if (configured) return configured;
    return all[0] || "openai";
  }

  /** Persist the provider the user is actually editing. */
  private rememberActiveProvider(): void {
    const pid = this.activeProviderId();
    const s = this.plugin.settings;
    if (s.ai.sourcePreference === pid) return;
    s.ai.sourcePreference = pid;
    if (isAiProviderType(pid)) s.aiProvider = pid;
  }

  private renderProviderChooser(setting: Setting): void {
    const s = this.plugin.settings;
    const active = this.activeProviderId();
    setting.addDropdown((dd) => {
      for (const pid of Object.keys(AI_PROVIDER_PRESETS)) {
        const meta = AI_PROVIDER_PRESETS[pid];
        const mark = this.isProviderConfigured(pid) ? " ✓" : "";
        dd.addOption(pid, `${meta.label}${mark}`);
      }
      dd.setValue(active).onChange(async (v) => {
        s.ai.sourcePreference = v;
        if (isAiProviderType(v)) s.aiProvider = v;
        await this.save();
        clearModelsDevCache();
        this.update();
      });
    });
  }

  private renderModelPicker(setting: Setting): void {
    const s = this.plugin.settings;
    const activeProvider = this.activeProviderId();
    const preset = AI_PROVIDER_PRESETS[activeProvider];
    const providerLabel = preset?.label || activeProvider;
    setting.setDesc(`${t("settings_ai_model_desc")} (${providerLabel})`);

    let modelSelectEl: HTMLSelectElement | null = null;
    setting.addDropdown((dd) => {
      dd.addOption("", t("settings_ai_model_default"));
      if (preset?.model) {
        dd.addOption(preset.model, `${preset.model} (${t("settings_ai_model_default")})`);
      }
      const fallback = PROVIDER_DEFAULT_MODELS[activeProvider] || curatedModelsForSafe(activeProvider);
      for (const m of fallback) {
        if (m.id !== preset?.model) dd.addOption(m.id, m.label);
      }
      if (
        s.ai.defaultModel &&
        s.ai.defaultModel !== preset?.model &&
        !fallback.some((m) => m.id === s.ai.defaultModel)
      ) {
        dd.addOption(s.ai.defaultModel, s.ai.defaultModel);
      }
      dd.setValue(s.ai.defaultModel || "").onChange(async (v) => {
        s.ai.defaultModel = v;
        s.aiModel = v;
        await this.save();
      });
      modelSelectEl = dd.selectEl;
    });

    setting.addText((text) => {
      text.setPlaceholder(t("settings_ai_model_enter_custom") || "custom-model-id").setValue(s.ai.defaultModel || "");
      text.inputEl.addClass("tm-model-custom-input");
      text.onChange(async (v) => {
        const trimmed = v.trim();
        if (trimmed && trimmed !== s.ai.defaultModel) {
          s.ai.defaultModel = trimmed;
          s.aiModel = trimmed;
          await this.save();
        }
      });
    });

    setting.addExtraButton((btn) => {
      btn.setIcon("refresh-cw").setTooltip(t("settings_ai_refresh_models")).onClick(async () => {
        if (!modelSelectEl) return;
        btn.setDisabled(true);
        btn.setIcon("loader");
        try {
          const result = await this.loadDynamicModels(activeProvider, modelSelectEl, true);
          const count = String(result.models.length);
          if (result.source === "official") new Notice(t("notice_models_official", { count }));
          else if (result.source === "community") new Notice(t("notice_models_community", { count }));
          else new Notice(t("notice_models_fallback"));
        } finally {
          btn.setDisabled(false);
          btn.setIcon("refresh-cw");
        }
      });
    });

    if (modelSelectEl) void this.loadDynamicModels(activeProvider, modelSelectEl, false);
  }

  /**
   * Key / URL for the active provider, painted onto this definition's Setting.
   * Ollama is a base URL. Custom is base URL plus key. Everyone else is an
   * API key plus an optional base-URL override.
   */
  private renderCredentialRow(setting: Setting): void {
    const pid = this.activeProviderId();
    const meta = AI_PROVIDER_PRESETS[pid];
    if (!meta) return;
    const s = this.plugin.settings;

    if (pid === "ollama") {
      setting.setName(t("settings_ai_ollama_url")).setDesc(meta.baseUrl);
      setting.addText((text) => {
        text.setPlaceholder("http://127.0.0.1:11434/v1").setValue(s.ai.manual.ollamaBaseUrl || "");
        text.inputEl.type = "url";
        text.inputEl.addClass("tm-baseurl-input");
        text.onChange(async (v) => {
          s.ai.manual.ollamaBaseUrl = v.trim().replace(/\/+$/u, "");
          this.rememberActiveProvider();
          await this.save();
        });
      });
      return;
    }

    if (pid === "custom") {
      setting.setName(t("settings_base_url")).setDesc(t("settings_security_note"));
      setting.addText((text) => {
        text.setPlaceholder("https://api.example.com/v1").setValue(s.ai.manual.customBaseUrl || "");
        text.inputEl.type = "url";
        text.inputEl.addClass("tm-baseurl-input");
        text.onChange(async (v) => {
          s.ai.manual.customBaseUrl = v.trim().replace(/\/+$/u, "");
          this.rememberActiveProvider();
          await this.save();
        });
      });
      const current = s.ai.manual.customKey || "";
      setting.addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(KEY_PLACEHOLDERS.custom).setValue(current);
        text.onChange(async (v) => {
          if (v === current) return;
          if (!v && current) return;
          s.ai.manual.customKey = v;
          this.rememberActiveProvider();
          await this.save();
        });
      });
      setting.addExtraButton((btn) => {
        btn.setIcon("x").setTooltip(t("settings_ai_clear_key")).onClick(async () => {
          s.ai.manual.customKey = "";
          await this.save();
          this.update();
        });
      });
      return;
    }

    const keyField = PROVIDER_KEY_FIELDS[pid];
    setting.setName(t("settings_ai_key")).setDesc(t("settings_security_note"));
    if (keyField) {
      const current = String((s.ai.manual as unknown as Record<string, string>)[keyField] || "");
      setting.addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(KEY_PLACEHOLDERS[pid] || "sk-...").setValue(current);
        text.onChange(async (v) => {
          if (v === current) return;
          if (!v && current) return;
          const wasConfigured = hasConfiguredProvider(s.ai);
          (s.ai.manual as unknown as Record<string, string>)[keyField] = v;
          this.rememberActiveProvider();
          await this.save();
          if (!wasConfigured && hasConfiguredProvider(s.ai) && !s.ai.defaultModel) {
            clearModelsDevCache();
            new Notice(t("settings_ai_model_select_hint"));
          }
        });
      });
      setting.addExtraButton((btn) => {
        btn.setIcon("x").setTooltip(t("settings_ai_clear_key")).onClick(async () => {
          (s.ai.manual as unknown as Record<string, string>)[keyField] = "";
          await this.save();
          this.update();
        });
      });
      setting.addExtraButton((btn) => {
        btn.setIcon("external-link").setTooltip(meta.helpUrl).onClick(() => {
          openExternalUrl(meta.helpUrl);
        });
      });
    }

    setting.addText((text) => {
      text
        .setPlaceholder(meta.baseUrl || "https://…")
        .setValue(s.ai.manual.baseUrlOverrides?.[pid] || "");
      text.inputEl.type = "url";
      text.inputEl.addClass("tm-baseurl-input");
      text.onChange(async (v) => {
        const raw = v.trim().replace(/\/+$/u, "");
        const bag = { ...(s.ai.manual.baseUrlOverrides || {}) };
        if (raw) bag[pid] = raw;
        else delete bag[pid];
        s.ai.manual.baseUrlOverrides = bag;
        this.rememberActiveProvider();
        await this.save();
      });
    });
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private async save(): Promise<void> {
    // In-memory + kernel apply immediately (keeps the AI test button coherent);
    // disk write + view refresh are debounced — API-key fields fire onChange
    // per keystroke. Flushed on hide() and plugin unload.
    this.plugin.kernelService.updateSettings(this.plugin.settings);
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, 400);
  }

  /** Public flush — plugin onunload calls this so a pending keystroke is not lost. */
  flushPending(): void {
    if (this.saveTimer !== null) void this.flushSave();
  }

  private async flushSave(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.plugin.saveSettings();
    this.refreshViews();
  }

  override hide(): void {
    void this.flushSave();
  }

  private refreshViews(): void {
    const leaves = [
      ...this.app.workspace.getLeavesOfType(VIEW_TYPE_STREAM_WORKBENCH),
      ...this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_DOCK),
    ];
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof StreamWorkbenchView) {
        void view.refresh();
      } else if (view instanceof SidebarDockView) {
        void view.refresh();
      }
    }
  }

  private async loadDynamicModels(
    providerId: string,
    selectEl: HTMLSelectElement,
    force = false,
  ): Promise<{ models: { id: string; label: string }[]; source: string; live: boolean }> {
    const creds = credentialsForProvider(providerId, this.plugin.settings.ai.manual);
    const result = await resolveProviderCatalog(providerId, { force, ...creds });
    const currentValue = this.plugin.settings.ai.defaultModel || selectEl.value || "";
    const preset = AI_PROVIDER_PRESETS[providerId];
    applyModelOptions(selectEl, result.models, {
      currentValue,
      presetModel: preset?.model || null,
      defaultLabel: t("settings_ai_model_default"),
    });
    return result;
  }
}
