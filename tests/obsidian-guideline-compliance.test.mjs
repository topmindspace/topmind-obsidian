// Obsidian plugin guidelines — living compliance lock.
// https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.join(root, "src");

function resolveEngineRoot() {
  const candidates = [
    process.env.TOPMIND_SRC,
    path.resolve(root, "..", "topmind"),
    path.resolve(root, ".topmind-src"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, "lib", "kernel-api.mjs"))) return dir;
  }
  throw new Error("topmind engine not found (set TOPMIND_SRC or clone as ../topmind)");
}
const engineRoot = resolveEngineRoot();

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const files = walk(src);
const all = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");

describe("Obsidian plugin guidelines", () => {
  test("manifest: desktop-only, versions.json in sync, no fake funding fields", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.id, "topmind-stream");
    assert.equal(manifest.isDesktopOnly, true, "Node fs/path/crypto require desktop-only");
    assert.ok(manifest.minAppVersion, "minAppVersion required");
    assert.ok(/^\d+\.\d+\.\d+$/u.test(manifest.version), "semver version");
    const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));
    assert.ok(versions[manifest.version], `versions.json must map ${manifest.version}`);
  });

  test("no eval / new Function / localStorage / innerHTML", () => {
    assert.doesNotMatch(all, /\beval\s*\(/u);
    assert.doesNotMatch(all, /new\s+Function\s*\(/u);
    assert.doesNotMatch(all, /\blocalStorage\b/u);
    assert.doesNotMatch(all, /\bsessionStorage\b/u);
    assert.doesNotMatch(all, /\.innerHTML\b/u);
    assert.doesNotMatch(all, /\.outerHTML\b/u);
    assert.doesNotMatch(all, /insertAdjacentHTML/u);
    assert.doesNotMatch(all, /document\.write\s*\(/u);
  });

  test("external HTTP goes through requestUrl (CSP-safe), never bare fetch/XHR", () => {
    // Strip line + JSDoc prose so comments may name "fetch" as the banned API.
    const code = all
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "")
      .replace(/^\s*\*.*$/gmu, "");
    assert.doesNotMatch(code, /(?<![.\w])fetch\s*\(/u);
    assert.doesNotMatch(code, /XMLHttpRequest/u);
    assert.match(all, /from "obsidian"/u);
    assert.match(all, /requestUrl/u);
  });

  test("settings persist via loadData/saveData (not ad-hoc files)", () => {
    const main = fs.readFileSync(path.join(root, "src", "main.ts"), "utf8");
    assert.match(main, /this\.loadData\(\)/);
    assert.match(main, /this\.saveData\(/);
  });

  test("MarkdownRenderer always gets a Component (lifecycle-safe)", () => {
    for (const f of files) {
      const t = fs.readFileSync(f, "utf8");
      if (!t.includes("MarkdownRenderer.render")) continue;
      assert.match(
        t,
        /MarkdownRenderer\.render\([^;]*,\s*(this\.)?renderComp|MarkdownRenderer\.render\([^;]*cardComp/su,
        `${f} must pass a Component to MarkdownRenderer.render`,
      );
    }
  });

  test("onLayoutReady callbacks are unload-guarded", () => {
    const main = fs.readFileSync(path.join(root, "src", "main.ts"), "utf8");
    const readyCount = (main.match(/onLayoutReady\(/g) || []).length;
    const guardCount = (main.match(/if \(this\._unloaded\) return/g) || []).length;
    assert.ok(readyCount > 0, "uses onLayoutReady");
    assert.ok(guardCount >= readyCount, `every onLayoutReady needs _unloaded guard (ready=${readyCount} guards=${guardCount})`);
    assert.match(main, /this\._unloaded = true/);
  });

  test("plugin-owned DOM listeners use registerDomEvent (auto-cleanup)", () => {
    const main = fs.readFileSync(path.join(root, "src", "main.ts"), "utf8");
    assert.match(main, /this\.registerDomEvent\(/);
    // Status bar click must not be a raw addEventListener on plugin-owned chrome.
    assert.doesNotMatch(main, /addStatusBarItem\(\)[\s\S]{0,400}el\.addEventListener/su);
  });

  test("no default global hotkeys (users bind in Settings → Hotkeys)", () => {
    const main = fs.readFileSync(path.join(root, "src", "main.ts"), "utf8");
    // addCommand without hotkeys: key is fine, `hotkeys:` default binding is not.
    assert.doesNotMatch(main, /hotkeys:\s*\[/u);
  });

  test("Node builtins only behind isDesktopOnly + documented divergence", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.isDesktopOnly, true);
    const arch = fs.readFileSync(path.join(root, "ARCHITECTURE.md"), "utf8");
    assert.match(arch, /Vault API|intentional divergence|writeback/iu);
  });

  test("no remote code / dynamic script injection", () => {
    assert.doesNotMatch(all, /createElement\(["']script["']\)/iu);
    assert.doesNotMatch(all, /importScripts\s*\(/u);
    assert.doesNotMatch(all, /https?:\/\/[^"'\s]+\.(m?js|wasm)["']/iu);
  });
});

describe("quality gates stay honest", () => {
  test("Desktop undeclared-identifier guard declares its parser deps", () => {
    const desktopRoot = path.join(engineRoot, "topmind-desktop");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
    );
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ["@babel/parser", "@babel/traverse", "@babel/types"]) {
      assert.ok(deps[name], `topmind-desktop must declare ${name} for check:undeclared`);
    }
    const script = fs.readFileSync(
      path.join(desktopRoot, "scripts", "check-undeclared-idents.mjs"),
      "utf8",
    );
    // Once node_modules exists, a missing parser is a FAIL, not a silent skip.
    assert.match(script, /process\.exit\(1\)/);
    assert.match(script, /hasNodeModules/);
  });

  test("plugin views implement the ItemView contract", () => {
    for (const rel of [
      "views/stream-workbench-view.ts",
      "views/sidebar-dock-view.ts",
      "views/memory-browse-view.ts",
    ]) {
      const body = fs.readFileSync(path.join(src, rel), "utf8");
      assert.match(body, /getViewType\(\)/, rel);
      assert.match(body, /getDisplayText\(\)/, rel);
      assert.match(body, /getIcon\(\)/, rel);
      assert.match(body, /onOpen\(\)/, rel);
      assert.match(body, /onClose\(\)/, rel);
    }
  });

  test("Desktop key import is user-initiated (never auto-reads credentials)", () => {
    const settings = fs.readFileSync(path.join(src, "settings", "settings-tab.ts"), "utf8");
    assert.match(settings, /tryImportDesktopSettings\(\)/);
    // Must only be called from a button onClick, not onload/display.
    const callSites = [...settings.matchAll(/tryImportDesktopSettings\(\)/g)];
    assert.equal(callSites.length, 2, "definition + one user-initiated call");
  });
});
