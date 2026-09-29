// ── settings-model.test.mjs (split from plugin.test.mjs) ──────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fs,
  path,
  pathToFileURL,
  __dirname,
  srcDir,
  pluginRoot,
  importShipped,
} from "./helpers.mjs";


// ── DEFAULT_SETTINGS + AI presets (shipped) ────────────────────────────────

describe("DEFAULT_SETTINGS and AI_PROVIDER_PRESETS (shipped)", () => {
  test("DEFAULT_SETTINGS has required fields and safe defaults", async () => {
    const { DEFAULT_SETTINGS } = await importShipped("types.ts");
    const required = [
      "autoOpenWorkbench", "timelineOrder", "autoTag",
      "aiProvider", "aiApiKey", "aiBaseUrl", "aiModel",
      "writebackMode", "autoSuggest", "autoMaintainTodos",
      "backupKeep", "receiptKeep",
      "backupAiKeysToVault",
      "maxAgentSteps",
      // New multi-provider model
      "ai", "localeOverride", "feedLayout",
    ];
    for (const field of required) {
      assert.ok(field in DEFAULT_SETTINGS, `Missing field: ${field}`);
    }
    // Display cache default must match the contract default ("auto") — an
    // uninitialized workspace must not display "confirm" while Kernel runs "auto".
    assert.equal(DEFAULT_SETTINGS.writebackMode, "auto");
    // Plugin data.json is a display cache — Kernel must not take settings.writebackMode
    // as a permanent executeWrite override (operational truth is topmind.yaml).
    const svc = fs.readFileSync(path.join(srcDir, "services", "kernel-service.ts"), "utf8");
    assert.doesNotMatch(
      svc,
      /return this\.settings\.writebackMode/,
      "writebackModeOverride must not fork yaml from plugin data",
    );
    assert.match(svc, /hydrateWritebackModeFromContract/);
    assert.match(svc, /mirrorWritebackMode/);
    assert.equal(DEFAULT_SETTINGS.aiProvider, "none");
    assert.equal(DEFAULT_SETTINGS.aiApiKey, "");
    assert.equal(DEFAULT_SETTINGS.autoMaintainTodos, false);
    assert.equal(DEFAULT_SETTINGS.feedLayout, "list");
    assert.equal(DEFAULT_SETTINGS.receiptKeep, 50);
    assert.ok(DEFAULT_SETTINGS.receiptKeep >= 10);
    // backupKeep=0 is a valid configuration (disables backups)
    assert.ok(typeof DEFAULT_SETTINGS.backupKeep === "number");
    // Secrets must not land in the vault by default (community hygiene).
    assert.equal(DEFAULT_SETTINGS.backupAiKeysToVault, false);
    const mainSrc = fs.readFileSync(path.join(srcDir, "main.ts"), "utf8");
    assert.match(
      mainSrc,
      /if \(!this\.settings\?\.backupAiKeysToVault\) return;/,
      "saveAiKeysBackup must be gated behind the opt-in setting",
    );
    // New: ai multi-provider model
    assert.ok(DEFAULT_SETTINGS.ai, "ai config object must exist");
    assert.ok(DEFAULT_SETTINGS.ai.manual, "ai.manual must exist");
    assert.equal(DEFAULT_SETTINGS.ai.sourcePreference, "");
    assert.equal(DEFAULT_SETTINGS.ai.defaultModel, "");
    // All manual keys exist and default to empty
    for (const key of ["openAiKey", "anthropicKey", "googleKey", "xaiKey",
      "groqKey", "mistralKey", "openrouterKey",
      "deepseekKey", "moonshotKey", "zhipuKey", "minimaxKey",
      "qwenKey", "doubaoKey", "siliconflowKey", "baiduKey", "hunyuanKey",
      "customBaseUrl", "customKey", "ollamaBaseUrl"]) {
      assert.ok(key in DEFAULT_SETTINGS.ai.manual, `Missing manual key: ${key}`);
      assert.equal(DEFAULT_SETTINGS.ai.manual[key], "", `${key} should default to empty`);
    }
  });

  test("AI_PROVIDER_PRESETS has all Desktop-aligned providers", async () => {
    const { AI_PROVIDER_PRESETS } = await importShipped("constants.ts");
    // Must include all providers that Desktop supports
    const expectedProviders = ["openai", "anthropic", "google", "deepseek",
      "moonshot", "zhipu", "minimax", "xai",
      "groq", "mistral", "openrouter",
      "qwen", "doubao", "siliconflow", "baidu", "hunyuan",
      "ollama", "custom"];
    for (const pid of expectedProviders) {
      assert.ok(pid in AI_PROVIDER_PRESETS, `Missing provider: ${pid}`);
      const preset = AI_PROVIDER_PRESETS[pid];
      assert.ok(typeof preset.baseUrl === "string", `${pid} missing baseUrl`);
      assert.ok(typeof preset.model === "string", `${pid} missing model`);
      assert.ok(typeof preset.label === "string", `${pid} missing label`);
      assert.ok(typeof preset.helpUrl === "string", `${pid} missing helpUrl`);
      assert.ok(["international", "domestic", "local"].includes(preset.group),
        `${pid} invalid group: ${preset.group}`);
      assert.ok(["openai-compat", "anthropic", "google"].includes(preset.apiType),
        `${pid} invalid apiType: ${preset.apiType}`);
    }
    assert.equal(AI_PROVIDER_PRESETS.custom.baseUrl, "");
    assert.equal(AI_PROVIDER_PRESETS.custom.model, "");
    assert.ok(AI_PROVIDER_PRESETS.ollama.baseUrl.startsWith("http://127.0.0.1"));
    // Google must use google API type (not openai-compat)
    assert.equal(AI_PROVIDER_PRESETS.google.apiType, "google");
    // Anthropic must use anthropic API type
    assert.equal(AI_PROVIDER_PRESETS.anthropic.apiType, "anthropic");
  });
});

// ── Migration + multi-provider helpers (shipped) ───────────────────────────

describe("migrateSettings + hasConfiguredProvider (shipped)", () => {
  test("migrateSettings converts old single-provider to multi-provider", async () => {
    const { migrateSettings } = await importShipped("types.ts");
    const oldSettings = {
      aiProvider: "deepseek",
      aiApiKey: "sk-test-123",
      aiBaseUrl: "https://api.deepseek.com/v1",
      aiModel: "deepseek-chat",
    };
    const migrated = migrateSettings(oldSettings);
    assert.ok(migrated.ai, "ai object must exist after migration");
    assert.equal(migrated.ai.manual.deepseekKey, "sk-test-123");
    assert.equal(migrated.ai.sourcePreference, "deepseek");
    assert.equal(migrated.ai.defaultModel, "deepseek-chat");
  });

  test("migrateSettings handles ollama (no key, URL only)", async () => {
    const { migrateSettings } = await importShipped("types.ts");
    const oldSettings = {
      aiProvider: "ollama",
      aiBaseUrl: "http://127.0.0.1:11434/v1",
      aiModel: "llama3.2",
    };
    const migrated = migrateSettings(oldSettings);
    assert.equal(migrated.ai.manual.ollamaBaseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(migrated.ai.sourcePreference, "ollama");
  });

  test("migrateSettings preserves existing multi-provider config", async () => {
    const { migrateSettings, DEFAULT_SETTINGS } = await importShipped("types.ts");
    const settings = {
      ai: {
        sourcePreference: "openai",
        defaultModel: "gpt-4o",
        manual: { ...DEFAULT_SETTINGS.ai.manual, openAiKey: "sk-existing" },
      },
    };
    const migrated = migrateSettings(settings);
    assert.equal(migrated.ai.manual.openAiKey, "sk-existing");
    assert.equal(migrated.ai.sourcePreference, "openai");
  });

  test("migrateSettings normalizes junk values from damaged data.json", async () => {
    const { migrateSettings } = await importShipped("types.ts");
    const migrated = migrateSettings({
      timelineOrder: 42,
      writebackMode: "yolo",
      localeOverride: "fr-FR",
      backupKeep: "x",
      receiptKeep: 99999,
      autoOpenWorkbench: "yes",
      autoTag: 0,
    });
    assert.equal(migrated.timelineOrder, "desc");
    assert.equal(migrated.writebackMode, "auto");
    assert.equal(migrated.localeOverride, "");
    assert.equal(migrated.backupKeep, 3, "non-numeric backupKeep falls back to default");
    assert.equal(migrated.receiptKeep, 200, "receiptKeep clamps to slider max");
    assert.equal(migrated.autoOpenWorkbench, false, "junk falls back to the new default (off)");
    assert.equal(migrated.autoTag, true);
  });

  test("migrateSettings preserves unknown ai.* keys for forward compat", async () => {
    const { migrateSettings } = await importShipped("types.ts");
    const migrated = migrateSettings({
      ai: {
        sourcePreference: "",
        defaultModel: "",
        manual: {},
        futureProviderKey: "keep-me",
      },
    });
    assert.equal(
      migrated.ai.futureProviderKey,
      "keep-me",
    );
  });

  test("hasConfiguredProvider detects configured vs empty", async () => {
    const { hasConfiguredProvider, DEFAULT_SETTINGS } = await importShipped("types.ts");
    assert.equal(hasConfiguredProvider(DEFAULT_SETTINGS.ai), false);
    const configured = {
      sourcePreference: "",
      defaultModel: "",
      manual: { ...DEFAULT_SETTINGS.ai.manual, deepseekKey: "sk-test" },
    };
    assert.equal(hasConfiguredProvider(configured), true);
    // Ollama URL counts as configured
    const ollamaConfigured = {
      sourcePreference: "",
      defaultModel: "",
      manual: { ...DEFAULT_SETTINGS.ai.manual, ollamaBaseUrl: "http://127.0.0.1:11434/v1" },
    };
    assert.equal(hasConfiguredProvider(ollamaConfigured), true);
  });

  test("getProviderKey returns correct key for each provider", async () => {
    const { getProviderKey, DEFAULT_SETTINGS } = await importShipped("types.ts");
    const manual = { ...DEFAULT_SETTINGS.ai.manual, openAiKey: "sk-oai", deepseekKey: "sk-ds" };
    assert.equal(getProviderKey("openai", manual), "sk-oai");
    assert.equal(getProviderKey("deepseek", manual), "sk-ds");
    assert.equal(getProviderKey("anthropic", manual), "");
    assert.equal(getProviderKey("ollama", manual), "ollama"); // sentinel
  });
});

