// Settings surface: the host calls getSettingDefinitions() and each item's
// render(setting, group). Extra nodes painted into the group list are dropped,
// which is what hid the credential fields on a fresh enable.

import { register } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { path, pathToFileURL, srcDir } from "./helpers.mjs";

register(new URL("./obsidian-stub-loader.mjs", import.meta.url).href, import.meta.url);

const host = await import(new URL("./obsidian-host-stub.mjs", import.meta.url).href);
const { TopmindSettingTab } = await import(
  pathToFileURL(path.join(srcDir, "settings", "settings-tab.ts")).href
);
const { DEFAULT_SETTINGS, migrateSettings, hasConfiguredProvider } = await import(
  pathToFileURL(path.join(srcDir, "types.ts")).href
);
const { AI_PROVIDER_PRESETS, PROVIDER_KEY_FIELDS } = await import(
  pathToFileURL(path.join(srcDir, "constants.ts")).href
);
const defaultProviderId = Object.keys(AI_PROVIDER_PRESETS)[0];
const defaultKeyField = PROVIDER_KEY_FIELDS[defaultProviderId];
const defaultPresetModel = AI_PROVIDER_PRESETS[defaultProviderId].model;

function makePlugin(settings) {
  return {
    settings,
    app: {
      workspace: { getLeavesOfType: () => [] },
      vault: { adapter: {} },
    },
    saveSettings: async () => {},
    applyLocale() {},
    kernelService: {
      hydrateWritebackModeFromContract() {},
      mirrorWritebackMode() {},
      updateSettings() {},
      isWorkspaceReady() {
        return false;
      },
      getResolvedModel() {
        return { categories: [] };
      },
      invalidateCache() {},
      getVaultPath() {
        return "/vault";
      },
      initWorkspace() {
        return { ok: true };
      },
      testAiConnection() {
        return { generate: async () => "ok" };
      },
    },
  };
}

/** Host render: definition rows stay; siblings stuffed into the group list do not. */
function renderSettings(tab) {
  const root = host.document.createElement("div");
  const defs = tab.getSettingDefinitions();
  assert.ok(Array.isArray(defs) && defs.length > 0, "getSettingDefinitions returned nothing");
  for (const def of defs) {
    if (!def || def.type !== "group") continue;
    const listEl = host.document.createElement("div");
    root.appendChild(listEl);
    const group = { listEl };
    for (const item of def.items || []) {
      if (item.visible === false) continue;
      if (typeof item.visible === "function" && item.visible() === false) continue;
      const before = new Set(listEl.children);
      const setting = new host.Setting(listEl);
      if (item.name) setting.setName(item.name);
      if (typeof item.desc === "string") setting.setDesc(item.desc);
      if (typeof item.render === "function") item.render(setting, group);
      for (const child of [...listEl.children]) {
        if (child !== setting.settingEl && !before.has(child)) child.remove();
      }
    }
  }
  return root;
}

function providerSelect(root) {
  return root.querySelectorAll("select").find((select) => {
    const values = select.options.map((option) => option.value);
    return values.includes("openai") && values.includes("ollama") && values.includes("custom");
  });
}

function modelSelect(root, provider) {
  return root.querySelectorAll("select").find((select) => {
    if (select === provider) return false;
    const values = select.options.map((option) => option.value);
    if (values.includes("ollama") || values.includes("stream") || values.includes("zh-CN")) return false;
    return values.includes("") && values.some((value) => value.length > 0);
  });
}

function assertAiControls(root, label) {
  const provider = providerSelect(root);
  assert.ok(provider, `${label}: provider chooser missing`);
  assert.ok(provider.value, `${label}: a provider must be selected`);
  assert.ok(
    provider.options.some((option) => option.value === provider.value),
    `${label}: selected provider is not an option`,
  );
  const model = modelSelect(root, provider);
  assert.ok(model, `${label}: model chooser missing`);
  assert.ok(model.options.length > 0, `${label}: model chooser has no options`);
  const secret = root.querySelector('input[type="password"]');
  const url = root.querySelector('input[type="url"]');
  assert.ok(secret || url, `${label}: key or URL field missing`);
  return { provider, model, secret, url };
}

test("fresh settings render provider, model, and key; the key round-trips", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  assert.equal(settings.ai.sourcePreference, "");
  assert.equal(hasConfiguredProvider(settings.ai), false);
  const tab = new TopmindSettingTab({ workspace: { getLeavesOfType: () => [] } }, makePlugin(settings));
  const root = renderSettings(tab);
  const { provider, model } = assertAiControls(root, "fresh");
  assert.equal(provider.value, defaultProviderId);
  assert.ok(
    model.options.some((option) => option.value === defaultPresetModel),
    "fresh model chooser includes the default provider preset",
  );

  const secret = root.querySelector('input[type="password"]');
  assert.ok(secret, "fresh install shows an API key field for the default provider");
  secret.value = "sk-fresh-roundtrip";
  secret.dispatchEvent({ type: "input" });

  assert.equal(hasConfiguredProvider(settings.ai), true);
  assert.equal(settings.ai.manual[defaultKeyField], "sk-fresh-roundtrip");
  assert.equal(settings.ai.sourcePreference, defaultProviderId);

  const round = migrateSettings(structuredClone(settings));
  assert.equal(round.ai.manual[defaultKeyField], "sk-fresh-roundtrip");
  assert.equal(round.ai.sourcePreference, defaultProviderId);
  assert.equal(hasConfiguredProvider(round.ai), true);

  const reloaded = new TopmindSettingTab(
    { workspace: { getLeavesOfType: () => [] } },
    makePlugin(structuredClone(round)),
  );
  const again = renderSettings(reloaded);
  const shown = assertAiControls(again, "reload");
  assert.equal(shown.provider.value, defaultProviderId);
  assert.equal(shown.secret.value, "sk-fresh-roundtrip");
});

test("legacy configured settings still show the saved provider, model, and key", () => {
  const settings = migrateSettings({
    aiProvider: "deepseek",
    aiApiKey: "sk-legacy-key",
    aiBaseUrl: "https://api.deepseek.com/v1",
    aiModel: "deepseek-chat",
  });
  assert.equal(hasConfiguredProvider(settings.ai), true);
  const tab = new TopmindSettingTab({ workspace: { getLeavesOfType: () => [] } }, makePlugin(settings));
  const root = renderSettings(tab);
  const { provider, model, secret } = assertAiControls(root, "legacy");
  assert.equal(provider.value, "deepseek");
  assert.equal(model.value, "deepseek-chat");
  assert.ok(secret, "legacy install shows the key field");
  assert.equal(secret.value, "sk-legacy-key");
});
