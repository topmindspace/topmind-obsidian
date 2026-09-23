// ── Settings Tab: Plugin configuration UI ──────────────────────────────────
//
// Multi-provider AI settings — aligned with Desktop's AiProviderPanel design:
//   - All provider keys visible simultaneously (not one-at-a-time)
//   - Grouped: International / Domestic / Local
//   - Help links to each provider's API key page
//   - Status indicators showing which providers are configured
//   - Source preference selector
//   - Import from Desktop capability
//   - Model selection with curated defaults
//   - Workspace status card with contract doctor / reseed

import {
  PluginSettingTab,
  Setting,
  Notice,
  ExtraButtonComponent,
  Modal,
  type App as ObsidianApp,
  type SettingDefinitionItem,
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
  // re-exported kernel curated list (typed via kernel-modules.d.ts)
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

/** Workspace template options */
const TEMPLATE_OPTIONS = [
  { value: "stream", label: "Stream" },
  { value: "balanced", label: "Balanced" },
  { value: "research", label: "Research" },
  { value: "periodic", label: "Periodic" },
] as const;

/**
 * Attempt to import AI provider keys from Desktop.
 *
 * Checks two sources in order:
 * 1. Desktop's explicit export file (obsidian-key-export.json) — written by
 *    Desktop's Settings → AI → Export for Obsidian button. This works even
 *    when Desktop uses safeStorage encryption (the export decrypts first).
 * 2. Desktop's app-settings.json — only works when safeStorage is unavailable
 *    (keys stored in plaintext) or on Linux without libsecret.
 */

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

function tryImportDesktopSettings(): { imported: Partial<AiManualKeys>; preference: string; model: string; encrypted: boolean } | null {
  const home = os.homedir();

  // Source 1: Explicit export file (always plaintext, always up-to-date)
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

  // Source 2: app-settings.json (works only when keys are in plaintext)
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
        return s.startsWith("v10:") || (/^[A-Za-z0-9+/=]{40,}$/.test(s) && !s.startsWith("sk-") && !s.startsWith("AI"));
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

export class TopmindSettingTab extends PluginSettingTab {
  plugin: TopmindPlugin;
  private templateSelect: HTMLSelectElement | null = null;
  private saveTimer: number | null = null;
  /** Provider currently shown in the configure-one section (select-first UI). */
  private configPid = "";

  constructor(app: import("obsidian").App, plugin: TopmindPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }


  /** Obsidian 1.13+ settings search index (declarative API). */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: t("settings_workspace"),
        items: [
          {
            name: t("workspace_status"),
            desc: t("workspace_contract_doctor_desc"),
            aliases: ["workspace", "contract", "工作区"],
            render: (setting: Setting) => {
              setting.setName(t("workspace_status")).setDesc(t("workspace_contract_doctor_desc"));
              this.renderWorkspaceStatusRows(setting.settingEl);
            },
          },
          {
            name: t("init_workspace"),
            desc: t("init_workspace_desc"),
            aliases: ["init", "template", "初始化"],
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
            control: { type: "toggle", key: "autoOpenWorkbench" },
          },
          {
            name: t("settings_timeline_order"),
            desc: t("settings_timeline_order_desc"),
            control: {
              type: "dropdown",
              key: "timelineOrder",
              options: { desc: t("timeline_desc"), asc: t("timeline_asc") },
            },
          },
          {
            name: t("settings_auto_tag"),
            desc: t("settings_auto_tag_desc"),
            control: { type: "toggle", key: "autoTag" },
          },
          {
            name: t("settings_locale_override"),
            desc: t("settings_locale_override_desc"),
            control: {
              type: "dropdown",
              key: "localeOverride",
              options: { "": t("locale_auto"), "zh-CN": "简体中文", "en-US": "English" },
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings_ai"),
        items: [
          {
            name: t("settings_ai"),
            desc: t("settings_ai_status_desc"),
            aliases: ["AI", "provider", "model", "key", "模型", "密钥"],
            render: (setting: Setting) => {
              const root = setting.settingEl.createDiv({ cls: "tm-settings-ai-block" });
              this.renderAiSettingsInto(root);
              return () => root.empty();
            },
          },
          {
            name: t("settings_writeback_mode"),
            desc: t("settings_writeback_mode_desc"),
            control: {
              type: "dropdown",
              key: "writebackMode",
              options: { auto: t("writeback_auto"), confirm: t("writeback_confirm") },
            },
          },
          {
            name: t("settings_max_agent_steps"),
            desc: t("settings_max_agent_steps_desc"),
            control: { type: "slider", key: "maxAgentSteps", min: 3, max: 80, step: 1 },
          },
          {
            name: t("settings_auto_suggest"),
            desc: t("settings_auto_suggest_desc"),
            control: { type: "toggle", key: "autoSuggest" },
          },
          {
            name: t("settings_auto_maintain_todos"),
            desc: t("settings_auto_maintain_todos_desc"),
            control: { type: "toggle", key: "autoMaintainTodos" },
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
            control: { type: "slider", key: "backupKeep", min: 0, max: 10, step: 1 },
          },
          {
            name: t("settings_receipt_keep"),
            desc: t("settings_receipt_keep_desc"),
            control: { type: "slider", key: "receiptKeep", min: 10, max: 200, step: 10 },
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
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    s[key] = value;
    if (key === "writebackMode") {
      this.plugin.kernelService.mirrorWritebackMode(value as WritebackMode);
    }
    if (key === "localeOverride") {
      void (async () => {
        const { setLocale } = await import("../i18n");
        const obsLocale = (this.app as unknown as { locale?: string }).locale || "zh-CN";
        setLocale(asString(value) || (obsLocale.startsWith("en") ? "en-US" : "zh-CN"));
      })();
    }
    void this.save();
  }


  /** Workspace status rows hosted by getSettingDefinitions render. */
  private renderWorkspaceStatusRows(parent: HTMLElement): void {
    const prev = this.plugin.settings.writebackMode;
    this.plugin.kernelService.hydrateWritebackModeFromContract();
    if (this.plugin.settings.writebackMode !== prev) {
      void this.plugin.saveSettings();
    }
    const holder = parent.createDiv({ cls: "tm-settings-workspace-status" });
    // Reuse display()-era renderer against a temporary container.
    const prevContainer = this.containerEl;
    // renderWorkspaceStatus writes to this.containerEl — swap via a local bag.
    (this as unknown as { containerEl: HTMLElement }).containerEl = holder;
    try {
      this.renderWorkspaceStatus();
    } finally {
      (this as unknown as { containerEl: HTMLElement }).containerEl = prevContainer;
    }
  }

  private renderInitWorkspaceRow(setting: Setting): void {
    setting
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

  /** Full AI settings block (status / import / providers / model / test). */
  private renderAiSettingsInto(root: HTMLElement): void {
    const s = this.plugin.settings;
    const containerEl = root;

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
            this.save();
            new Notice(t("settings_ai_import_success", { count }));
            this.update();
          } else {
            new Notice(t("settings_ai_import_nothing"));
          }
        }),
      );

    // Provider picker + credentials (reuse display path by rendering remaining
    // AI controls that live in display() after the import row).
    // Keep a single implementation: call the historical body via a scoped bag.
    this.renderAiProviderControls(containerEl);

    new Setting(containerEl)
      .setName(t("settings_ai_test"))
      .setDesc(t("settings_security_note"))
      .addButton((btn) =>
        btn.setButtonText(t("settings_ai_test")).onClick(async () => {
          if (!hasConfiguredProvider(s.ai)) {
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

  /** Provider / model / credential controls (single source for settings UI). */
  private renderAiProviderControls(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const allPids = Object.keys(AI_PROVIDER_PRESETS);
    const isPidConfigured = (gid: string) =>
      gid === "custom"
        ? Boolean(s.ai.manual.customBaseUrl && s.ai.manual.customKey)
        : gid === "ollama"
          ? Boolean(s.ai.manual.ollamaBaseUrl)
          : Boolean((s.ai.manual as unknown as Record<string, string>)[PROVIDER_KEY_FIELDS[gid] || ""]);

    let activeProvider =
      s.ai.sourcePreference ||
      allPids.find((id) => isPidConfigured(id)) ||
      "openai";
    this.configPid = activeProvider;

    const picker = new Setting(containerEl).setName(t("settings_ai_provider"));
    picker.addDropdown((dd) => {
      for (const pid of allPids) {
        const meta = AI_PROVIDER_PRESETS[pid];
        const mark = isPidConfigured(pid) ? " ✓" : "";
        dd.addOption(pid, `${meta.label}${mark}`);
      }
      dd.setValue(activeProvider);
      dd.onChange((v) => {
        activeProvider = v;
        this.configPid = v;
        this.update();
      });
    });

    // Model selection
    const preset = AI_PROVIDER_PRESETS[activeProvider];
    let modelSelectEl: HTMLSelectElement | null = null;
    const modelSetting = new Setting(containerEl).setName(t("settings_ai_model"));
    modelSetting.addDropdown((dd) => {
      const fallback = curatedModelsForSafe(activeProvider);
      for (const m of fallback) dd.addOption(m.id, m.label);
      if (s.ai.defaultModel && !fallback.some((m) => m.id === s.ai.defaultModel)) {
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
      text.setPlaceholder("custom-model-id").setValue(s.ai.defaultModel || "");
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

    const detail = new Setting(containerEl).setName(
      preset.label + (isPidConfigured(activeProvider) ? " ✓" : "") +
        (s.ai.sourcePreference === activeProvider ? " ★" : ""),
    );
    if (preset.helpUrl) {
      detail.addExtraButton((btn: ExtraButtonComponent) => {
        btn.setIcon("external-link").setTooltip(preset.helpUrl).onClick(() => {
          window.open(preset.helpUrl, "_blank");
        });
      });
    }
    detail.addExtraButton((btn: ExtraButtonComponent) => {
      const isDefault = s.ai.sourcePreference === activeProvider;
      btn.setIcon(isDefault ? "star" : "star-off")
        .setTooltip(isDefault ? t("settings_ai_clear_default") : t("settings_ai_set_default"))
        .onClick(async () => {
          s.ai.sourcePreference = isDefault ? "" : activeProvider;
          s.aiProvider = ((isDefault ? "" : activeProvider) || "none") as TopmindPlugin["settings"]["aiProvider"];
          if (isDefault) s.ai.defaultModel = "";
          await this.save();
          clearModelsDevCache();
          this.update();
        });
    });

    if (activeProvider === "ollama") {
      detail.addText((text) => {
        text.setPlaceholder("http://127.0.0.1:11434/v1").setValue(s.ai.manual.ollamaBaseUrl || "");
        text.inputEl.type = "url";
        text.onChange(async (v) => {
          s.ai.manual.ollamaBaseUrl = v.trim().replace(/\/+$/, "");
          await this.save();
        });
      });
    } else if (activeProvider === "custom") {
      detail.addText((text) => {
        text.setPlaceholder("https://api.example.com/v1").setValue(s.ai.manual.customBaseUrl || "");
        text.inputEl.type = "url";
        text.onChange(async (v) => {
          s.ai.manual.customBaseUrl = v.trim().replace(/\/+$/, "");
          await this.save();
        });
      });
      detail.addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("sk-...").setValue(s.ai.manual.customKey || "");
        text.onChange(async (v) => {
          s.ai.manual.customKey = v;
          await this.save();
        });
      });
    } else {
      const keyField = PROVIDER_KEY_FIELDS[activeProvider] ?? undefined;
      detail.addText((text) => {
        text.setPlaceholder(preset.baseUrl || "https://…").setValue(s.ai.manual.baseUrlOverrides?.[activeProvider] || "");
        text.inputEl.type = "url";
        text.inputEl.addClass("tm-baseurl-input");
        text.onChange(async (v) => {
          const raw = v.trim().replace(/\/+$/, "");
          const bag = { ...(s.ai.manual.baseUrlOverrides || {}) };
          if (raw) bag[activeProvider] = raw;
          else delete bag[activeProvider];
          s.ai.manual.baseUrlOverrides = bag;
          await this.save();
        });
      });
      if (keyField) {
        detail.addText((text) => {
          text.inputEl.type = "password";
          text.setPlaceholder("sk-...").setValue(String((s.ai.manual as unknown as Record<string, string>)[keyField] || ""));
          text.onChange(async (v) => {
            (s.ai.manual as unknown as Record<string, string>)[keyField] = v;
            await this.save();
          });
        });
        if (isPidConfigured(activeProvider)) {
          detail.addExtraButton((btn: ExtraButtonComponent) => {
            btn.setIcon("x").setTooltip(t("settings_ai_clear_key")).onClick(async () => {
              (s.ai.manual as unknown as Record<string, string>)[keyField] = "";
              await this.save();
              this.update();
            });
          });
        }
      }
    }
  }

  display(): void {
    const { containerEl } = this;
    const prevWritebackMode = this.plugin.settings.writebackMode;
    this.plugin.kernelService.hydrateWritebackModeFromContract();
    // Persist hydrated display-cache value so data.json stops lying after the
    // contract changed elsewhere (Desktop / manual edit).
    if (this.plugin.settings.writebackMode !== prevWritebackMode) {
      void this.plugin.saveSettings();
    }
    const s = this.plugin.settings;

    containerEl.empty();
    this.templateSelect = null;

    // ── Section: Workspace & Contract ──
    new Setting(containerEl).setName(t("settings_workspace")).setHeading();

    // Workspace status card
    this.renderWorkspaceStatus();

    new Setting(containerEl)
      .setName(t("init_workspace"))
      .setDesc(t("init_workspace_desc"))
      .addDropdown((dd) => {
        for (const opt of TEMPLATE_OPTIONS) {
          dd.addOption(opt.value, opt.label);
        }
        dd.setValue("stream");
        this.templateSelect = dd.selectEl;
      })
      .addButton((btn) =>
        btn
          .setButtonText(t("init_workspace"))
          .onClick(() => {
            const templateId = this.templateSelect?.value || "stream";
            // Writes ~5 directories + topmind.yaml into this vault — confirm first.
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

    // ── Section: Stream Workbench ──
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

    // ── Section: AI Co-pilot & Writeback ──
    new Setting(containerEl).setName(t("settings_ai")).setHeading();

    // Status indicator
    const aiReady = hasConfiguredProvider(s.ai);
    const statusText = aiReady
      ? t("settings_ai_ready")
      : t("settings_ai_not_configured");

    new Setting(containerEl)
      .setName(t("settings_ai_status"))
      .setDesc(t("settings_ai_status_desc"))
      .addText((text) => {
        text.setValue(statusText).setDisabled(true);
        text.inputEl.addClass(aiReady ? "tm-status-input" : "tm-status-input tm-status-input-dim");
      });

    // Prominent model selection prompt when AI is configured but no model selected
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
        btn
          .setButtonText(t("settings_ai_import"))
          .onClick(() => {
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
            if (result.preference && !s.ai.sourcePreference) {
              s.ai.sourcePreference = result.preference;
            }
            if (result.model && !s.ai.defaultModel) {
              s.ai.defaultModel = result.model;
            }
            if (count > 0) {
              this.save();
              new Notice(t("settings_ai_import_success", { count }));
              this.update();
            } else {
              new Notice(t("settings_ai_import_nothing"));
            }
          }),
      );

    // ── One provider picker = preference + credential target ──
    const allPids = Object.keys(AI_PROVIDER_PRESETS);
    const isPidConfigured = (gid: string) =>
      gid === "custom"
        ? Boolean(s.ai.manual.customBaseUrl && s.ai.manual.customKey)
        : gid === "ollama"
          ? Boolean(s.ai.manual.ollamaBaseUrl)
          : Boolean(getProviderKey(gid, s.ai.manual));

    // Preference "" = auto. Edit target follows preference, else last picked, else first configured.
    if (!this.configPid || !AI_PROVIDER_PRESETS[this.configPid]) {
      this.configPid = s.ai.sourcePreference || allPids.find(isPidConfigured) || allPids[0];
    }
    const pid = this.configPid;
    const meta = AI_PROVIDER_PRESETS[pid];
    const isConfigured = isPidConfigured(pid);

    new Setting(containerEl)
      .setName(t("settings_ai_preference"))
      .setDesc(meta.baseUrl || t("settings_ai_preference_desc"))
      .addDropdown((dd) => {
        dd.addOption("", t("settings_ai_auto"));
        for (const gid of allPids) {
          const p = AI_PROVIDER_PRESETS[gid];
          const star = s.ai.sourcePreference === gid ? " ★" : isPidConfigured(gid) ? " ✓" : "";
          dd.addOption(gid, `${p.label}${star}`);
        }
        dd.setValue(s.ai.sourcePreference || "").onChange(async (v) => {
          s.ai.sourcePreference = v;
          s.aiProvider = (v || "none") as TopmindPlugin["settings"]["aiProvider"];
          // Selecting a concrete provider is also the credential-edit target.
          this.configPid = v || allPids.find(isPidConfigured) || allPids[0];
          await this.save();
          clearModelsDevCache();
          this.update();
        });
      });

    // Model selection — always visible when any provider is configured
    const activeProvider = s.ai.sourcePreference || this.configPid || "";
    if (activeProvider && activeProvider !== "none") {
      const preset = AI_PROVIDER_PRESETS[activeProvider];
      const providerLabel = preset?.label || activeProvider;
      const modelSetting = new Setting(containerEl)
        .setName(t("settings_ai_model"))
        .setDesc(t("settings_ai_model_desc") + ` (${providerLabel})`);
      let modelSelectEl: HTMLSelectElement | null = null;
      modelSetting.addDropdown((dd) => {
        dd.addOption("", t("settings_ai_model_default"));
        if (preset?.model) {
          dd.addOption(preset.model, `${preset.model} (${t("settings_ai_model_default")})`);
        }
        // Curated fallbacks — official / community overlay arrives async
        const fallback = PROVIDER_DEFAULT_MODELS[activeProvider] || [];
        for (const m of fallback) {
          dd.addOption(m.id, m.label);
        }
        if (s.ai.defaultModel && s.ai.defaultModel !== preset?.model && !fallback.some((m) => m.id === s.ai.defaultModel)) {
          dd.addOption(s.ai.defaultModel, s.ai.defaultModel);
        }
        dd.setValue(s.ai.defaultModel || "").onChange(async (v) => {
          s.ai.defaultModel = v;
          s.aiModel = v;
          await this.save();
        });
        modelSelectEl = dd.selectEl;
      });
      // Also allow custom model text input
      modelSetting.addText((text) => {
        text
          .setPlaceholder("custom-model-id")
          .setValue(s.ai.defaultModel || "");
        text.inputEl.addClass("tm-model-custom-input");
        text.onChange(async (v) => {
          // Only update if the value is not empty and differs from dropdown
          const trimmed = v.trim();
          if (trimmed && trimmed !== s.ai.defaultModel) {
            s.ai.defaultModel = trimmed;
            s.aiModel = trimmed;
            await this.save();
          }
        });
      });
      // Refresh — force-bypass TTL; official list-models when keyed, else models.dev
      modelSetting.addExtraButton((btn) => {
        btn
          .setIcon("refresh-cw")
          .setTooltip(t("settings_ai_refresh_models"))
          .onClick(async () => {
            if (!modelSelectEl) return;
            btn.setDisabled(true);
            btn.setIcon("loader");
            try {
              const result = await this.loadDynamicModels(activeProvider, modelSelectEl, true);
              const count = String(result.models.length);
              if (result.source === "official") {
                new Notice(t("notice_models_official", { count }));
              } else if (result.source === "community") {
                new Notice(t("notice_models_community", { count }));
              } else {
                new Notice(t("notice_models_fallback"));
              }
            } finally {
              btn.setDisabled(false);
              btn.setIcon("refresh-cw");
            }
          });
      });
      // Curated defaults are already on screen; enrich without blocking first paint
      if (modelSelectEl) {
        void this.loadDynamicModels(activeProvider, modelSelectEl, false);
      }
    }

    // ── Credentials for the selected provider (no second picker) ──
    const detail = new Setting(containerEl).setName(
      meta.label + (isConfigured ? " ✓" : "") + (s.ai.sourcePreference === pid ? " ★" : ""),
    );

    if (meta.helpUrl) {
      detail.addExtraButton((btn: ExtraButtonComponent) => {
        btn
          .setIcon("external-link")
          .setTooltip(meta.helpUrl)
          .onClick(() => {
            window.open(meta.helpUrl, "_blank");
          });
      });
    }

    // Set / clear preferred provider (★)
    detail.addExtraButton((btn: ExtraButtonComponent) => {
      const isDefault = s.ai.sourcePreference === pid;
      btn
        .setIcon(isDefault ? "star" : "star-off")
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
      detail.addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:11434/v1")
          .setValue(s.ai.manual.ollamaBaseUrl || "");
        text.inputEl.type = "url";
        text.onChange(async (v) => {
          s.ai.manual.ollamaBaseUrl = v.trim().replace(/\/+$/, "");
          await this.save();
        });
      });
    } else if (pid === "custom") {
      detail.addText((text) => {
        text
          .setPlaceholder("https://api.example.com/v1")
          .setValue(s.ai.manual.customBaseUrl || "");
        text.inputEl.type = "url";
        text.onChange(async (v) => {
          s.ai.manual.customBaseUrl = v.trim().replace(/\/+$/, "");
          await this.save();
        });
      });
      detail.addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(s.ai.manual.customKey || "");
        text.onChange(async (v) => {
          s.ai.manual.customKey = v;
          await this.save();
        });
      });
    } else {
      const keyField = PROVIDER_KEY_FIELDS[pid];
      // Optional base URL override (proxy / regional) — placeholder = official default
      detail.addText((text) => {
        text
          .setPlaceholder(meta.baseUrl || "https://…")
          .setValue(s.ai.manual.baseUrlOverrides?.[pid] || "");
        text.inputEl.type = "url";
        text.inputEl.addClass("tm-baseurl-input");
        text.onChange(async (v) => {
          const raw = v.trim().replace(/\/+$/, "");
          const bag = { ...(s.ai.manual.baseUrlOverrides || {}) };
          if (raw) bag[pid] = raw;
          else delete bag[pid];
          s.ai.manual.baseUrlOverrides = bag;
          await this.save();
        });
      });

      if (keyField) {
        detail.addText((text) => {
          text.inputEl.type = "password";
          const placeholder = pid === "anthropic" ? "sk-ant-..."
            : pid === "google" ? "AI..."
            : pid === "groq" ? "gsk_..."
            : pid === "openrouter" ? "sk-or-..."
            : "sk-...";
          text
            .setPlaceholder(placeholder)
            .setValue(String((s.ai.manual as unknown as Record<string, string>)[keyField] || ""));
          text.onChange(async (v) => {
            const wasConfigured = hasConfiguredProvider(s.ai);
            (s.ai.manual as unknown as Record<string, string>)[keyField] = v;
            await this.save();
            if (!wasConfigured && hasConfiguredProvider(s.ai) && !s.ai.defaultModel) {
              clearModelsDevCache();
              new Notice(t("settings_ai_model_select_hint"));
              this.update();
            }
          });
        });

        if (isConfigured) {
          detail.addExtraButton((btn: ExtraButtonComponent) => {
            btn
              .setIcon("x")
              .setTooltip(t("settings_ai_clear_key"))
              .onClick(async () => {
                (s.ai.manual as unknown as Record<string, string>)[keyField] = "";
                await this.save();
                this.update();
              });
          });
        }
      }
    }

    // Connection test
    new Setting(containerEl)
      .setName(t("settings_ai_test"))
      .setDesc(t("settings_security_note"))
      .addButton((btn) =>
        btn
          .setButtonText(t("settings_ai_test"))
          .onClick(async () => {
            if (!hasConfiguredProvider(s.ai)) {
              new Notice(t("settings_ai_test_no_key"));
              return;
            }
            btn.setButtonText(t("settings_ai_testing"));
            btn.setDisabled(true);
            try {
              const provider = this.plugin.kernelService.testAiConnection();
              const reply = await provider.generate("Reply with: OK", { operation: "test" });
              if (reply && reply.trim().length > 0) {
                new Notice(t("settings_ai_test_success"));
              } else {
                new Notice(`${t("settings_ai_test_failed")}: empty response`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`${t("settings_ai_test_failed")}: ${msg}`);
            } finally {
              btn.setButtonText(t("settings_ai_test"));
              btn.setDisabled(false);
            }
          }),
      );

    // Writeback mode
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

    // ── Section: Security & Archive ──
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

  /**
   * Render workspace status card showing contract state and categories.
   */
  private renderWorkspaceStatus(): void {
    const { containerEl } = this;
    const isReady = this.plugin.kernelService.isWorkspaceReady();

    if (!isReady) {
      const statusSetting = new Setting(containerEl)
        .setName(t("workspace_status"))
        .setDesc(t("workspace_not_ready"));
      statusSetting.controlEl.createSpan({ cls: "tm-status-badge tm-status-warning", text: t("workspace_not_ready") });
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
      badgeContainer.createSpan({ cls: "tm-status-badge tm-status-info", text: t("workspace_contract_valid") });

      // Contract doctor + reseed buttons
      new Setting(containerEl)
        .setName(t("workspace_contract_doctor"))
        .setDesc(t("workspace_contract_doctor_desc"))
        .addButton((btn) =>
          btn
            .setButtonText(t("workspace_contract_doctor"))
            .onClick(() => {
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
                new Notice(`${t("workspace_contract_doctor_failed")}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }),
        )
        .addButton((btn) =>
          btn
            .setButtonText(t("workspace_contract_reseed"))
            .setWarning()
            .onClick(() => {
              // Backs up + replaces the contract file — never run silently.
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
                    new Notice(`${t("workspace_contract_reseed_failed")}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                },
              );
            }),
        );
    } catch {
      // Model resolution failed — just show basic status
      new Setting(containerEl)
        .setName(t("workspace_status"))
        .setDesc(t("workspace_no_categories"));
    }
  }

  private async save(): Promise<void> {
    // In-memory settings + kernel config apply immediately (keeps the AI test
    // button coherent); the disk write + full view refresh are debounced —
    // API-key fields fire onChange per keystroke. Flushed on hide().
    this.plugin.kernelService.updateSettings(this.plugin.settings);
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, 400);
  }

  /** Persist to disk + refresh open views (also the hide() flush). */
  private async flushSave(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.plugin.saveSettings();
    // Refresh open views so Stream/Sidebar pick up AI config changes
    this.refreshViews();
  }

  override hide(): void {
    void this.flushSave();
  }

  /** Refresh all open topmind views to pick up settings changes */
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

  /** Resolve official + community + curated and update the dropdown in-place. */
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
