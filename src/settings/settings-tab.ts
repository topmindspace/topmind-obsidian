// ── Settings Tab: Plugin configuration UI ──────────────────────────────────
//
// Obsidian Settings → Topmind Stream.
// Surface order: workspace · stream · **AI (providers / model / keys)** · security.
//
// AI section design (visible, not buried):
//   - Status card + Desktop import
//   - Full provider board: International / Domestic / Local — every provider
//     shows its key (or URL) field at once, with configured ✓ and default ★
//   - Model picker (official list-models → models.dev → curated) + custom ID
//   - Connection test + writeback policy
//
// Uses Obsidian 1.13 declarative settings (`getSettingDefinitions`) so every
// control is searchable in Settings. Complex surfaces (workspace status, AI
// provider board, Desktop import) render imperatively via `SettingDefinitionRender`
// while still advertising name/desc for search.

import {
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  type App as ObsidianApp,
  type SettingDefinitionItem,
} from "obsidian";
import type TopmindPlugin from "../main";
import { t } from "../i18n";
import type { WritebackMode, AiManualKeys } from "../types";
import { hasConfiguredProvider, getProviderKey } from "../types";
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
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { openExternalUrl } from "../utils";

/** Workspace template options */
const TEMPLATE_OPTIONS = [
  { value: "stream", label: "Stream" },
  { value: "balanced", label: "Balanced" },
  { value: "research", label: "Research" },
  { value: "periodic", label: "Periodic" },
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

/**
 * Import AI provider keys from Desktop.
 * Source 1: obsidian-key-export.json (plaintext export, preferred).
 * Source 2: app-settings.json (only when keys are plaintext / safeStorage off).
 */
function tryImportDesktopSettings(): {
  imported: Partial<AiManualKeys>;
  preference: string;
  model: string;
  encrypted: boolean;
} | null {
  const home = os.homedir();

  const exportCandidates = [
    path.join(home, "topmind", "topmind-desktop", "state", "obsidian-key-export.json"),
    path.join(home, "topmind-desktop", "state", "obsidian-key-export.json"),
  ];
  for (const exportPath of exportCandidates) {
    if (!fs.existsSync(exportPath)) continue;
    try {
      const raw = fs.readFileSync(exportPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const ai = readDesktopAi(parsed);
      if (!ai) continue;
      const m = ai.manual || {};
      const imported: Partial<AiManualKeys> = {};
      const take = (key: keyof AiManualKeys, srcKey: string) => {
        const val = asString(m[srcKey]);
        if (val) (imported as Record<string, string>)[key] = val;
      };
      take("openAiKey", "openAiKey");
      take("anthropicKey", "anthropicKey");
      take("googleKey", "googleKey");
      take("deepseekKey", "deepseekKey");
      take("moonshotKey", "moonshotKey");
      take("zhipuKey", "zhipuKey");
      take("minimaxKey", "minimaxKey");
      take("xaiKey", "xaiKey");
      take("customBaseUrl", "customBaseUrl");
      take("customKey", "customKey");
      take("ollamaBaseUrl", "ollamaBaseUrl");
      return {
        imported,
        preference: ai.sourcePreference || "",
        model: ai.defaultModel || "",
        encrypted: false,
      };
    } catch {
      // continue to next source
    }
  }

  const candidates = [
    path.join(home, "topmind", "topmind-desktop", "state", "app-settings.json"),
    path.join(home, "topmind-desktop", "state", "app-settings.json"),
  ];

  for (const settingsPath of candidates) {
    if (!fs.existsSync(settingsPath)) continue;
    try {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
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
      const takeEncrypted = (key: keyof AiManualKeys, srcKey: string) => {
        const val = asString(m[srcKey]);
        if (!val) return;
        (imported as Record<string, string>)[key] = val;
        if (looksEncrypted(val)) encrypted = true;
      };
      const keyFields: Array<keyof AiManualKeys> = [
        "openAiKey", "anthropicKey", "googleKey", "deepseekKey", "moonshotKey", "zhipuKey",
        "minimaxKey", "xaiKey", "groqKey", "mistralKey", "openrouterKey", "qwenKey",
        "doubaoKey", "siliconflowKey", "baiduKey", "hunyuanKey", "customKey",
      ];
      for (const key of keyFields) takeEncrypted(key, key);
      const customBaseUrl = asString(m.customBaseUrl);
      if (customBaseUrl) imported.customBaseUrl = customBaseUrl;
      const ollamaBaseUrl = asString(m.ollamaBaseUrl);
      if (ollamaBaseUrl) imported.ollamaBaseUrl = ollamaBaseUrl;

      return {
        imported,
        preference: ai.sourcePreference || "",
        model: ai.defaultModel || "",
        encrypted,
      };
    } catch {
      continue;
    }
  }
  return null;
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
   * Native 1.13 declarative settings. Groups give each section a real heading
   * and each row its own `.setting-item` flex layout (the old one-row paint
   * squeezed every nested Setting into a horizontal flex line — CJK labels
   * stacked one character per line).
   *
   * Simple toggles/dropdowns/sliders are declarative controls (searchable via
   * `getControlValue`/`setControlValue`). Complex surfaces (workspace status,
   * AI provider board) render imperatively into their own row or sub-page.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    this.hydrateWriteback();

    return [
      {
        type: "group",
        heading: t("settings_workspace"),
        items: [
          {
            name: t("workspace_status"),
            desc: t("settings_workspace_status_desc"),
            aliases: ["workspace", "契约", "contract", "status"],
            render: (setting: Setting) => {
              this.renderWorkspaceStatusRow(setting);
            },
          },
          {
            name: t("workspace_contract_doctor"),
            desc: t("workspace_contract_doctor_desc"),
            aliases: ["doctor", "诊断", "契约", "reseed"],
            render: (setting: Setting) => {
              this.renderContractDoctorRow(setting);
            },
          },
          {
            name: t("init_workspace"),
            desc: t("init_workspace_desc"),
            aliases: ["init", "初始化", "template"],
            render: (setting: Setting) => {
              this.renderInitWorkspaceRow(setting);
            },
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
            control: { type: "toggle", key: "autoOpenWorkbench", defaultValue: false },
          },
          {
            name: t("settings_timeline_order"),
            desc: t("settings_timeline_order_desc"),
            control: {
              type: "dropdown",
              key: "timelineOrder",
              defaultValue: "desc",
              options: { desc: t("timeline_desc"), asc: t("timeline_asc") },
            },
          },
          {
            name: t("settings_auto_tag"),
            desc: t("settings_auto_tag_desc"),
            control: { type: "toggle", key: "autoTag", defaultValue: true },
          },
          {
            name: t("settings_locale_override"),
            desc: t("settings_locale_override_desc"),
            render: (setting: Setting) => {
              this.renderLocaleOverrideRow(setting);
            },
          },
          {
            name: t("settings_feed_layout"),
            desc: t("settings_feed_layout_desc"),
            control: {
              type: "dropdown",
              key: "feedLayout",
              defaultValue: "list",
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
            aliases: ["AI", "provider", "密钥", "key"],
            render: (setting: Setting) => {
              this.renderAiStatusRow(setting);
            },
          },
          {
            name: t("settings_ai_import"),
            desc: t("settings_ai_import_desc"),
            aliases: ["Desktop", "import", "导入"],
            render: (setting: Setting) => {
              this.renderAiImportRow(setting);
            },
          },
          {
            name: t("settings_ai_preference"),
            desc: t("settings_ai_preference_desc"),
            render: (setting: Setting) => {
              this.renderProviderPreference(setting);
            },
          },
          {
            name: t("settings_ai_model"),
            desc: t("settings_ai_model_desc"),
            render: (setting: Setting) => {
              this.renderModelPicker(setting);
            },
          },
          {
            name: t("settings_ai_board"),
            desc: t("settings_ai_provider_desc"),
            aliases: ["API", "key", "board", "密钥"],
            render: (setting: Setting) => {
              // Multi-row credential surface — host is a vertical stack so the
              // nested provider/key/URL rows keep native Setting layout.
              setting.settingEl.addClass("tm-settings-host");
              setting.infoEl.empty();
              setting.controlEl.empty();
              this.renderProviderBoard(setting.settingEl);
            },
          },
          {
            name: t("settings_ai_test"),
            desc: t("settings_security_note"),
            render: (setting: Setting) => {
              this.renderConnectionTestRow(setting);
            },
          },
          {
            name: t("settings_writeback_mode"),
            desc: t("settings_writeback_mode_desc"),
            control: {
              type: "dropdown",
              key: "writebackMode",
              defaultValue: "auto",
              options: { auto: t("writeback_auto"), confirm: t("writeback_confirm") },
            },
          },
          {
            name: t("settings_max_agent_steps"),
            desc: t("settings_max_agent_steps_desc"),
            control: {
              type: "slider",
              key: "maxAgentSteps",
              defaultValue: 32,
              min: 3,
              max: 80,
              step: 1,
            },
          },
          {
            name: t("settings_auto_suggest"),
            desc: t("settings_auto_suggest_desc"),
            control: { type: "toggle", key: "autoSuggest", defaultValue: true },
          },
          {
            name: t("settings_auto_maintain_todos"),
            desc: t("settings_auto_maintain_todos_desc"),
            control: { type: "toggle", key: "autoMaintainTodos", defaultValue: false },
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
            control: { type: "slider", key: "backupKeep", defaultValue: 3, min: 0, max: 10, step: 1 },
          },
          {
            name: t("settings_receipt_keep"),
            desc: t("settings_receipt_keep_desc"),
            control: { type: "slider", key: "receiptKeep", defaultValue: 50, min: 10, max: 200, step: 10 },
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
        const { setLocale } = await import("../i18n");
        const obsLocale = (this.app as unknown as { locale?: string }).locale || "zh-CN";
        const override = typeof value === "string" ? value : "";
        setLocale(override || (obsLocale.startsWith("en") ? "en-US" : "zh-CN"));
        this.update();
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
    return (this.app as unknown as { locale?: string }).locale || "zh-CN";
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
      for (const opt of TEMPLATE_OPTIONS) dd.addOption(opt.value, opt.label);
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
        .addOption("zh-CN", "简体中文")
        .addOption("en-US", "English")
        .setValue(s.localeOverride)
        .onChange(async (v) => {
          s.localeOverride = v;
          await this.save();
          const { setLocale } = await import("../i18n");
          const obsLocale = (this.app as unknown as { locale?: string }).locale || "zh-CN";
          setLocale(v || (obsLocale.startsWith("en") ? "en-US" : "zh-CN"));
          this.update();
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

  /** Desktop key import (user-initiated only). */
  private renderAiImportRow(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addButton((btn) =>
      btn.setButtonText(t("settings_ai_import")).onClick(() => {
        const result = tryImportDesktopSettings();
        if (!result) {
          new Notice(t("settings_ai_import_not_found"));
          return;
        }
        if (result.encrypted) {
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
        if (result.preference && !s.ai.sourcePreference) s.ai.sourcePreference = result.preference;
        if (result.model && !s.ai.defaultModel) s.ai.defaultModel = result.model;
        if (count > 0) {
          void this.save();
          new Notice(t("settings_ai_import_success", { count }));
          this.update();
        } else {
          new Notice(t("settings_ai_import_nothing"));
        }
      }),
    );
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

  private renderProviderPreference(setting: Setting): void {
    const s = this.plugin.settings;
    const allPids = Object.keys(AI_PROVIDER_PRESETS);
    setting.addDropdown((dd) => {
      dd.addOption("", t("settings_ai_auto"));
      for (const gid of allPids) {
        const p = AI_PROVIDER_PRESETS[gid];
        const star = s.ai.sourcePreference === gid ? " ★" : this.isProviderConfigured(gid) ? " ✓" : "";
        dd.addOption(gid, `${p.label}${star}`);
      }
      dd.setValue(s.ai.sourcePreference || "").onChange(async (v) => {
        s.ai.sourcePreference = v;
        s.aiProvider = (v || "none") as TopmindPlugin["settings"]["aiProvider"];
        await this.save();
        clearModelsDevCache();
        this.update();
      });
    });
  }

  private renderModelPicker(setting: Setting): void {
    const s = this.plugin.settings;
    const activeProvider =
      s.ai.sourcePreference ||
      Object.keys(AI_PROVIDER_PRESETS).find((id) => this.isProviderConfigured(id)) ||
      "openai";
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
   * Credential surface — ONE provider at a time via dropdown.
   * The old board expanded every provider at once (huge, noisy). Standard
   * settings UX: pick provider → only its key / model / endpoint show.
   */
  private renderProviderBoard(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const allPids = Object.keys(AI_PROVIDER_PRESETS);

    // Active provider: explicit sourcePreference → first configured → first.
    let activePid =
      s.ai.sourcePreference ||
      allPids.find((id) => this.isProviderConfigured(id)) ||
      allPids[0] ||
      "openai";

    const header = new Setting(containerEl)
      .setName(t("settings_ai_provider"))
      .setDesc(t("settings_ai_provider_desc"));
    header.addDropdown((dd) => {
      for (const pid of allPids) {
        const meta = AI_PROVIDER_PRESETS[pid];
        const mark = this.isProviderConfigured(pid) ? " ✓" : "";
        dd.addOption(pid, `${meta.label}${mark}`);
      }
      dd.setValue(activePid);
      dd.onChange((v) => {
        activePid = v;
        // Persist as the active provider so model picker / calls follow it.
        s.ai.sourcePreference = v;
        s.aiProvider = v as TopmindPlugin["settings"]["aiProvider"];
        void this.save().then(() => {
          clearModelsDevCache();
          this.update();
        });
      });
    });

    this.renderActiveProviderFields(containerEl, activePid);
  }

  /** Key / URL / default-star fields for a single provider. */
  private renderActiveProviderFields(containerEl: HTMLElement, pid: string): void {
    const s = this.plugin.settings;
    const meta = AI_PROVIDER_PRESETS[pid];
    if (!meta) return;

    if (pid === "ollama") {
      new Setting(containerEl)
        .setName(t("settings_ai_ollama_url"))
        .setDesc(meta.baseUrl)
        .addText((text) => {
          text.setPlaceholder("http://127.0.0.1:11434/v1").setValue(s.ai.manual.ollamaBaseUrl || "");
          text.inputEl.type = "url";
          text.inputEl.addClass("tm-baseurl-input");
          text.onChange(async (v) => {
            s.ai.manual.ollamaBaseUrl = v.trim().replace(/\/+$/u, "");
            await this.save();
          });
        });
      return;
    }

    if (pid === "custom") {
      new Setting(containerEl)
        .setName(t("settings_base_url"))
        .setDesc(t("settings_ai_provider_desc"))
        .addText((text) => {
          text.setPlaceholder("https://api.example.com/v1").setValue(s.ai.manual.customBaseUrl || "");
          text.inputEl.type = "url";
          text.inputEl.addClass("tm-baseurl-input");
          text.onChange(async (v) => {
            s.ai.manual.customBaseUrl = v.trim().replace(/\/+$/u, "");
            await this.save();
          });
        });
      new Setting(containerEl)
        .setName(t("settings_ai_key"))
        .setDesc(t("settings_security_note"))
        .addText((text) => {
          text.inputEl.type = "password";
          const current = s.ai.manual.customKey || "";
          text.setPlaceholder(KEY_PLACEHOLDERS.custom).setValue(current);
          text.onChange(async (v) => {
            if (v === current) return;
            if (!v && current) return;
            s.ai.manual.customKey = v;
            await this.save();
          });
        })
        .addExtraButton((btn) => {
          btn.setIcon("x").setTooltip(t("settings_ai_clear_key")).onClick(async () => {
            s.ai.manual.customKey = "";
            await this.save();
            this.update();
          });
        });
      return;
    }

    // Regular provider: API key + optional base-URL override
    const keyField = PROVIDER_KEY_FIELDS[pid];
    if (keyField) {
      const current = String((s.ai.manual as unknown as Record<string, string>)[keyField] || "");
      new Setting(containerEl)
        .setName(t("settings_ai_key"))
        .setDesc(t("settings_security_note"))
        .addText((text) => {
          text.inputEl.type = "password";
          text.setPlaceholder(KEY_PLACEHOLDERS[pid] || "sk-...").setValue(current);
          text.onChange(async (v) => {
            if (v === current) return;
            if (!v && current) return;
            const wasConfigured = hasConfiguredProvider(s.ai);
            (s.ai.manual as unknown as Record<string, string>)[keyField] = v;
            await this.save();
            if (!wasConfigured && hasConfiguredProvider(s.ai) && !s.ai.defaultModel) {
              clearModelsDevCache();
              new Notice(t("settings_ai_model_select_hint"));
            }
          });
        })
        .addExtraButton((btn) => {
          btn.setIcon("x").setTooltip(t("settings_ai_clear_key")).onClick(async () => {
            (s.ai.manual as unknown as Record<string, string>)[keyField] = "";
            await this.save();
            this.update();
          });
        })
        .addExtraButton((btn) => {
          btn.setIcon("external-link").setTooltip(meta.helpUrl).onClick(() => {
            openExternalUrl(meta.helpUrl);
          });
        });
    }

    new Setting(containerEl)
      .setName(t("settings_base_url"))
      .setDesc(meta.baseUrl)
      .addText((text) => {
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

/** Minimal confirm gate for irreversible/dangerous settings actions. */
class ConfirmModal extends Modal {
  constructor(
    app: ObsidianApp,
    private title: string,
    private body: string,
    private onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.body });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = buttons.createEl("button", { text: t("dialog_cancel") });
    cancelBtn.addEventListener("click", () => this.close());
    const confirmBtn = buttons.createEl("button", {
      text: t("dialog_confirm"),
      cls: "mod-warning",
    });
    confirmBtn.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
