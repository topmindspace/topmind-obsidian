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
// Uses the classic PluginSettingTab.display() path. We intentionally do NOT
// override getSettingDefinitions() — an empty definitions array has been
// observed to suppress display() on some Obsidian 1.13 builds, which is how
// the AI board previously vanished from Settings.

import {
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  type App as ObsidianApp,
} from "obsidian";
import type TopmindPlugin from "../main";
import { t } from "../i18n";
import type { WritebackMode, TimelineOrder, AiManualKeys } from "../types";
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
      const ai = readDesktopAi(JSON.parse(raw));
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
      const ai = readDesktopAi(JSON.parse(raw));
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

  display(): void {
    const { containerEl } = this;
    const prevWritebackMode = this.plugin.settings.writebackMode;
    this.plugin.kernelService.hydrateWritebackModeFromContract();
    if (this.plugin.settings.writebackMode !== prevWritebackMode) {
      void this.plugin.saveSettings();
    }

    containerEl.empty();
    this.templateSelect = null;

    this.renderWorkspaceSection(containerEl);
    this.renderStreamSection(containerEl);
    this.renderAiSection(containerEl);
    this.renderSecuritySection(containerEl);
  }

  // ── Workspace ───────────────────────────────────────────────────────────

  private renderWorkspaceSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings_workspace")).setHeading();
    this.renderWorkspaceStatus(containerEl);

    new Setting(containerEl)
      .setName(t("init_workspace"))
      .setDesc(t("init_workspace_desc"))
      .addDropdown((dd) => {
        for (const opt of TEMPLATE_OPTIONS) dd.addOption(opt.value, opt.label);
        dd.setValue("stream");
        this.templateSelect = dd.selectEl;
      })
      .addButton((btn) =>
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

  // ── Stream ──────────────────────────────────────────────────────────────

  private renderStreamSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName(t("settings_stream")).setHeading();

    new Setting(containerEl)
      .setName(t("settings_auto_open"))
      .setDesc(t("settings_auto_open_desc"))
      .addToggle((toggle) =>
        toggle.setValue(s.autoOpenWorkbench).onChange(async (v) => {
          s.autoOpenWorkbench = v;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings_timeline_order"))
      .setDesc(t("settings_timeline_order_desc"))
      .addDropdown((dd) =>
        dd
          .addOption("desc", t("timeline_desc"))
          .addOption("asc", t("timeline_asc"))
          .setValue(s.timelineOrder)
          .onChange(async (v) => {
            s.timelineOrder = v as TimelineOrder;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings_auto_tag"))
      .setDesc(t("settings_auto_tag_desc"))
      .addToggle((toggle) =>
        toggle.setValue(s.autoTag).onChange(async (v) => {
          s.autoTag = v;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings_locale_override"))
      .setDesc(t("settings_locale_override_desc"))
      .addDropdown((dd) =>
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

  // ── AI (full provider board) ────────────────────────────────────────────

  private renderAiSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName(t("settings_ai")).setHeading();

    // Status
    const aiReady = hasConfiguredProvider(s.ai);
    const statusText = aiReady ? t("settings_ai_ready") : t("settings_ai_not_configured");
    new Setting(containerEl)
      .setName(t("settings_ai_status"))
      .setDesc(t("settings_ai_status_desc"))
      .addText((text) => {
        text.setValue(statusText).setDisabled(true);
        text.inputEl.addClass(aiReady ? "tm-status-input" : "tm-status-input tm-status-input-dim");
      });

    if (aiReady && !s.ai.defaultModel) {
      const hintSetting = new Setting(containerEl)
        .setName(t("settings_ai_model_select_hint"))
        .setDesc(t("settings_ai_model_select_hint_desc"));
      hintSetting.infoEl.addClass("tm-setting-hint-accent");
    }

    // Import from Desktop
    new Setting(containerEl)
      .setName(t("settings_ai_import"))
      .setDesc(t("settings_ai_import_desc"))
      .addButton((btn) =>
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

    // Preferred provider ("" = auto)
    this.renderProviderPreference(containerEl);

    // Model selection — always visible
    this.renderModelPicker(containerEl);

    // Full provider credential board (all groups, all keys at once)
    this.renderProviderBoard(containerEl);

    // Connection test
    this.renderConnectionTest(containerEl);

    // Writeback + AI ops policy
    new Setting(containerEl)
      .setName(t("settings_writeback_mode"))
      .setDesc(t("settings_writeback_mode_desc"))
      .addDropdown((dd) =>
        dd
          .addOption("auto", t("writeback_auto"))
          .addOption("confirm", t("writeback_confirm"))
          .setValue(s.writebackMode)
          .onChange(async (v) => {
            const mode = v as WritebackMode;
            s.writebackMode = mode;
            this.plugin.kernelService.mirrorWritebackMode(mode);
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings_max_agent_steps"))
      .setDesc(t("settings_max_agent_steps_desc"))
      .addSlider((slider) =>
        slider
          .setLimits(3, 80, 1)
          .setValue(s.maxAgentSteps || 32)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.maxAgentSteps = v;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings_auto_suggest"))
      .setDesc(t("settings_auto_suggest_desc"))
      .addToggle((toggle) =>
        toggle.setValue(s.autoSuggest).onChange(async (v) => {
          s.autoSuggest = v;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings_auto_maintain_todos"))
      .setDesc(t("settings_auto_maintain_todos_desc"))
      .addToggle((toggle) =>
        toggle.setValue(s.autoMaintainTodos).onChange(async (v) => {
          s.autoMaintainTodos = v;
          await this.save();
        }),
      );
  }

  private isProviderConfigured(pid: string): boolean {
    const s = this.plugin.settings;
    if (pid === "custom") return Boolean(s.ai.manual.customBaseUrl && s.ai.manual.customKey);
    if (pid === "ollama") return Boolean(s.ai.manual.ollamaBaseUrl);
    const field = PROVIDER_KEY_FIELDS[pid];
    return field ? Boolean(getProviderKey(pid, s.ai.manual)) : false;
  }

  private renderProviderPreference(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const allPids = Object.keys(AI_PROVIDER_PRESETS);
    new Setting(containerEl)
      .setName(t("settings_ai_preference"))
      .setDesc(t("settings_ai_preference_desc"))
      .addDropdown((dd) => {
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

  private renderModelPicker(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const activeProvider =
      s.ai.sourcePreference ||
      Object.keys(AI_PROVIDER_PRESETS).find((id) => this.isProviderConfigured(id)) ||
      "openai";
    const preset = AI_PROVIDER_PRESETS[activeProvider];
    const providerLabel = preset?.label || activeProvider;

    const modelSetting = new Setting(containerEl)
      .setName(t("settings_ai_model"))
      .setDesc(`${t("settings_ai_model_desc")} (${providerLabel})`);

    let modelSelectEl: HTMLSelectElement | null = null;
    modelSetting.addDropdown((dd) => {
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

    modelSetting.addText((text) => {
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

    modelSetting.addExtraButton((btn) => {
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
   * Full credential board — every provider visible at once, grouped.
   * This is the primary AI settings surface (not a one-at-a-time picker).
   */
  private renderProviderBoard(containerEl: HTMLElement): void {
    const groups: Array<{ id: "international" | "domestic" | "local"; label: string }> = [
      { id: "international", label: t("settings_ai_international") },
      { id: "domestic", label: t("settings_ai_domestic") },
      { id: "local", label: t("settings_ai_local") },
    ];

    for (const group of groups) {
      const groupSetting = new Setting(containerEl).setName(group.label).setHeading();
      groupSetting.settingEl.addClass("tm-settings-ai-block");

      for (const [pid, meta] of Object.entries(AI_PROVIDER_PRESETS)) {
        if (meta.group !== group.id) continue;
        this.renderProviderRow(containerEl, pid, meta);
      }
    }
  }

  private renderProviderRow(
    containerEl: HTMLElement,
    pid: string,
    meta: { label: string; baseUrl: string; helpUrl: string },
  ): void {
    const s = this.plugin.settings;
    const configured = this.isProviderConfigured(pid);
    const isDefault = s.ai.sourcePreference === pid;

    const row = new Setting(containerEl).setName(
      `${meta.label}${configured ? " · " + t("settings_ai_provider_configured") : " · " + t("settings_ai_provider_not_configured")}${isDefault ? " ★" : ""}`,
    );
    row.setDesc(meta.baseUrl || t("settings_ai_provider_desc"));
    row.settingEl.addClass("tm-settings-ai-block");

    if (meta.helpUrl) {
      row.addExtraButton((btn) => {
        btn.setIcon("external-link").setTooltip(meta.helpUrl).onClick(() => {
          openExternalUrl(meta.helpUrl);
        });
      });
    }

    row.addExtraButton((btn) => {
      btn.setIcon(isDefault ? "star" : "star-off")
        .setTooltip(isDefault ? t("settings_ai_clear_default") : t("settings_ai_set_default"))
        .onClick(async () => {
          s.ai.sourcePreference = isDefault ? "" : pid;
          s.aiProvider = ((isDefault ? "" : pid) || "none") as TopmindPlugin["settings"]["aiProvider"];
          if (isDefault) s.ai.defaultModel = "";
          await this.save();
          clearModelsDevCache();
          this.update();
        });
    });

    if (pid === "ollama") {
      row.addText((text) => {
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
      row.addText((text) => {
        text.setPlaceholder("https://api.example.com/v1").setValue(s.ai.manual.customBaseUrl || "");
        text.inputEl.type = "url";
        text.inputEl.addClass("tm-baseurl-input");
        text.onChange(async (v) => {
          s.ai.manual.customBaseUrl = v.trim().replace(/\/+$/u, "");
          await this.save();
        });
      });
      row.addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(KEY_PLACEHOLDERS.custom).setValue(s.ai.manual.customKey || "");
        text.onChange(async (v) => {
          s.ai.manual.customKey = v;
          await this.save();
        });
      });
      return;
    }

    // Regular providers: optional base-URL override + API key
    row.addText((text) => {
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

    const keyField = PROVIDER_KEY_FIELDS[pid];
    if (keyField) {
      row.addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(KEY_PLACEHOLDERS[pid] || "sk-...")
          .setValue(String((s.ai.manual as unknown as Record<string, string>)[keyField] || ""));
        text.onChange(async (v) => {
          const wasConfigured = hasConfiguredProvider(s.ai);
          (s.ai.manual as unknown as Record<string, string>)[keyField] = v;
          await this.save();
          if (!wasConfigured && hasConfiguredProvider(s.ai) && !s.ai.defaultModel) {
            clearModelsDevCache();
            new Notice(t("settings_ai_model_select_hint"));
          }
        });
      });

      if (configured) {
        row.addExtraButton((btn) => {
          btn.setIcon("x").setTooltip(t("settings_ai_clear_key")).onClick(async () => {
            (s.ai.manual as unknown as Record<string, string>)[keyField] = "";
            await this.save();
            this.update();
          });
        });
      }
    }
  }

  private renderConnectionTest(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName(t("settings_ai_test"))
      .setDesc(t("settings_security_note"))
      .addButton((btn) =>
        btn.setButtonText(t("settings_ai_test")).onClick(async () => {
          if (!hasConfiguredProvider(this.plugin.settings.ai)) {
            new Notice(t("settings_ai_test_no_key"));
            return;
          }
          btn.setButtonText(t("settings_ai_testing"));
          btn.setDisabled(true);
          try {
            const provider = this.plugin.kernelService.testAiConnection();
            const reply = await provider.generate("Reply with: OK", { operation: "test" });
            if (reply && reply.trim().length > 0) new Notice(t("settings_ai_test_success"));
            else new Notice(`${t("settings_ai_test_failed")}: empty response`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`${t("settings_ai_test_failed")}: ${msg}`);
          } finally {
            btn.setButtonText(t("settings_ai_test"));
            btn.setDisabled(false);
          }
        }),
      );
  }

  // ── Security ────────────────────────────────────────────────────────────

  private renderSecuritySection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName(t("settings_security")).setHeading();

    new Setting(containerEl)
      .setName(t("settings_backup_keep"))
      .setDesc(t("settings_backup_keep_desc"))
      .addSlider((slider) =>
        slider
          .setLimits(0, 10, 1)
          .setValue(s.backupKeep)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.backupKeep = v;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings_receipt_keep"))
      .setDesc(t("settings_receipt_keep_desc"))
      .addSlider((slider) =>
        slider
          .setLimits(10, 200, 10)
          .setValue(s.receiptKeep)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.receiptKeep = v;
            await this.save();
          }),
      );
  }

  // ── Workspace status card ───────────────────────────────────────────────

  private renderWorkspaceStatus(containerEl: HTMLElement): void {
    const isReady = this.plugin.kernelService.isWorkspaceReady();

    if (!isReady) {
      const statusSetting = new Setting(containerEl)
        .setName(t("workspace_status"))
        .setDesc(t("workspace_not_ready"));
      statusSetting.controlEl.createSpan({
        cls: "tm-status-badge tm-status-warning",
        text: t("workspace_not_ready"),
      });
      return;
    }

    try {
      const model = this.plugin.kernelService.getResolvedModel();
      const categories = model.categories || [];
      const categoryCount = categories.filter((c) => !(c as { hidden?: boolean }).hidden).length;

      const statusSetting = new Setting(containerEl)
        .setName(t("workspace_status"))
        .setDesc(t("workspace_categories_count", { count: categoryCount }));

      const badgeContainer = statusSetting.controlEl.createDiv({ cls: "tm-status-badges" });
      badgeContainer.createSpan({ cls: "tm-status-badge tm-status-ok", text: t("workspace_ready") });
      badgeContainer.createSpan({
        cls: "tm-status-badge tm-status-info",
        text: t("workspace_contract_valid"),
      });

      new Setting(containerEl)
        .setName(t("workspace_contract_doctor"))
        .setDesc(t("workspace_contract_doctor_desc"))
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
          btn.setButtonText(t("workspace_contract_reseed")).setWarning().onClick(() => {
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
    } catch {
      new Setting(containerEl)
        .setName(t("workspace_status"))
        .setDesc(t("workspace_no_categories"));
    }
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
