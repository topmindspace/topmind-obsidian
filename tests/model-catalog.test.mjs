/**
 * Obsidian catalog wiring — drive shipped helpers and assert settings/chat
 * use the force-bypass two-source resolver (no network).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "..", "src");
const repoRoot = path.join(__dirname, "..");

describe("shipped catalog helpers", () => {
  test("models-dev wires engine parse/resolve and re-exports picker helpers", () => {
    const src = fs.readFileSync(path.join(srcDir, "services", "models-dev.ts"), "utf8");
    assert.match(src, /from ["']#kernel\/model-catalog\.mjs["']/u);
    for (const name of [
      "parseModelsDevCatalog",
      "parseOfficialList",
      "resolveProviderModels",
      "shouldServeCache",
      "shouldPersistCatalog",
      "resolveOfficialRequest",
      "nextSelectOptions",
      "planCatalogRefresh",
    ]) {
      assert.match(src, new RegExp(name, "u"), `models-dev must use ${name}`);
    }
    assert.match(src, /export \{ nextSelectOptions, planCatalogRefresh/);
    assert.match(src, /force === true/);
    assert.match(src, /parseOfficialList\(req\.kind, json\)/);
  });

  test("engine nextSelectOptions / force plan stay the picker contract", async () => {
    const mod = await import(pathToFileURL(path.join(repoRoot, "lib", "model-catalog.mjs")).href);
    const opts = mod.nextSelectOptions({
      models: [{ id: "gpt-4o", label: "GPT-4o" }],
      currentValue: "my-custom",
      presetId: "gpt-4o-mini",
      defaultLabel: "default",
    });
    assert.ok(opts.some((o) => o.id === "my-custom"));
    const plan = mod.planCatalogRefresh({
      providerId: "openai",
      force: true,
      hasKey: true,
      hasEndpoint: true,
      officialCacheFresh: true,
      communityCacheFresh: true,
    });
    assert.equal(plan.fetchOfficial, true);
    assert.equal(plan.officialKind, "openai-compat");
  });

  test("constants curated defaults come from the shipped engine catalog", async () => {
    const { PROVIDER_DEFAULT_MODELS } = await import(
      pathToFileURL(path.join(srcDir, "constants.ts")).href
    );
    const engine = await import(pathToFileURL(path.join(repoRoot, "lib", "model-catalog.mjs")).href);
    assert.ok(PROVIDER_DEFAULT_MODELS.openai.length > 0);
    assert.deepEqual(
      PROVIDER_DEFAULT_MODELS.openai.map((m) => m.id),
      engine.curatedModelsFor("openai").map((m) => m.id),
    );
  });
});

describe("settings + chat wiring (static, shipped source)", () => {
  test("settings refresh calls resolveProviderCatalog with force and source notices", () => {
    const src = fs.readFileSync(path.join(srcDir, "settings", "settings-tab.ts"), "utf8");
    assert.match(src, /resolveProviderCatalog/);
    assert.match(src, /loadDynamicModels\(activeProvider, modelSelectEl, true\)/);
    assert.match(src, /notice_models_official/);
    assert.match(src, /notice_models_community/);
    assert.match(src, /notice_models_fallback/);
    assert.match(src, /applyModelOptions/);
    assert.match(src, /credentialsForProvider/);
    // Custom model id must survive a catalog refresh even when not in the live list.
    assert.match(src, /s\.ai\.defaultModel &&/);
    assert.match(src, /s\.ai\.defaultModel !== preset\?\.model/);
  });

  test("chat switcher keeps custom id and uses resolveProviderCatalog", () => {
    const src = fs.readFileSync(path.join(srcDir, "views", "sidebar-dock-view.ts"), "utf8");
    assert.match(src, /resolveProviderCatalog/);
    assert.match(src, /applyModelOptions/);
    assert.match(src, /credentialsForProvider/);
    assert.match(src, /createEl\("option", \{ value: currentModel/);
  });

  test("model control is always rendered (not gated on one configured provider)", () => {
    const src = fs.readFileSync(path.join(srcDir, "settings", "settings-tab.ts"), "utf8");
    // Model picker is a first-class AI control — always on screen so a user who
    // just pasted a key never has to hunt for it.
    assert.match(src, /renderModelPicker/);
    assert.match(src, /settings_ai_model/);
    // Custom model entry stays available next to the dropdown.
    assert.match(src, /settings_ai_model_enter_custom|custom-model-id/);
    // Full provider board is the primary surface (not a one-at-a-time picker).
    assert.match(src, /renderProviderBoard/);
  });

  test("AI settings render via display() with the full provider board", () => {
    // Obsidian calls display() only when getSettingDefinitions() returns [].
    // A non-empty declarative list SKIPS display(); putting the AI board in a
    // `render` hook then got torn down on update — that is how "AI settings
    // vanished" kept happening. Contract now: empty definitions + imperative
    // display() draws the complete credential/model surface every time.
    const raw = fs.readFileSync(path.join(srcDir, "settings", "settings-tab.ts"), "utf8");
    const src = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(src, /override getSettingDefinitions\s*\(\s*\)\s*:\s*SettingDefinitionItem\[\]/u);
    // Must return empty so display() runs.
    assert.match(src, /getSettingDefinitions\s*\(\s*\)\s*:\s*SettingDefinitionItem\[\]\s*\{\s*return\s*\[\s*\]/u);
    assert.match(src, /display\(\): void/);
    assert.match(src, /renderAiSection/);
    assert.match(src, /renderProviderBoard/);
    // display() must paint every section, including the AI board.
    assert.match(src, /renderAiInto\(containerEl\)|renderAiSection\(containerEl\)/);
    // Credential board must expose key fields for the major providers.
    assert.match(src, /PROVIDER_KEY_FIELDS/);
    assert.match(src, /settings_ai_key|password/);
  });
});
