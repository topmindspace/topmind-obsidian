// ── build-writepath.test.mjs (split from plugin.test.mjs) ──────────────────────────

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


// ── Build output verification ─────────────────────────────────────────────

describe("build output", () => {
  const distDir = path.join(__dirname, "..", "dist");
  const hasDist = fs.existsSync(path.join(distDir, "main.js"));

  test("dist/main.js exists and is non-trivial", (t) => {
    if (!hasDist) {
      t.skip("dist/ not built yet — run npm run build first");
      return;
    }
    const mainPath = path.join(__dirname, "..", "dist", "main.js");
    assert.ok(fs.existsSync(mainPath), "dist/main.js not found — run build first");
    const stat = fs.statSync(mainPath);
    assert.ok(stat.size > 10000, `main.js too small: ${stat.size} bytes`);
  });

  test("dist/manifest.json exists and has correct id", (t) => {
    if (!hasDist) {
      t.skip("dist/ not built yet — run npm run build first");
      return;
    }
    const manifestPath = path.join(__dirname, "..", "dist", "manifest.json");
    assert.ok(fs.existsSync(manifestPath), "dist/manifest.json not found");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(manifest.id, "topmind-stream");
    assert.ok(manifest.version, "manifest missing version");
    assert.equal(manifest.isDesktopOnly, true);
    assert.ok(manifest.minAppVersion, "manifest missing minAppVersion");
  });

  test("dist/templates/ has template files", (t) => {
    if (!hasDist) {
      t.skip("dist/ not built yet — run npm run build first");
      return;
    }
    const templatesDir = path.join(__dirname, "..", "dist", "templates");
    assert.ok(fs.existsSync(templatesDir), "templates dir not found");
    const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 4, `Expected at least 4 template files, got ${files.length}`);
  });

  test("dist/styles.css is scoped (tokens on :root, no host style pollution)", (t) => {
    if (!hasDist) {
      t.skip("dist/ not built yet — run npm run build first");
      return;
    }
    const cssPath = path.join(__dirname, "..", "dist", "styles.css");
    assert.ok(fs.existsSync(cssPath), "styles.css missing");
    const css = fs.readFileSync(cssPath, "utf-8");
    // Tokens live on :root so Settings tab + Status Bar (outside the four view
    // roots) resolve --tm-* correctly. What must NOT happen is styling the host
    // from :root — so allow only custom-property declarations in :root blocks.
    for (const m of css.matchAll(/:root\s*\{([^}]*)\}/gsu)) {
      const body = m[1].replace(/\/\*[\s\S]*?\*\//gu, "");
      for (const decl of body.split(";")) {
        const s = decl.trim().replace(/\s+/gu, " ");
        if (!s) continue;
        assert.match(s, /^--[\w-]+\s*:/u, `:root must only declare custom properties, got: ${s}`);
      }
    }
    assert.ok(css.includes("var(--"), "should use Obsidian CSS variables");
    assert.ok(css.includes("--background-primary") || css.includes("--font-ui-"), "should derive from Obsidian theme vars");
  });

  test("source has no default hotkeys on commands", () => {
    const mainSrc = fs.readFileSync(path.join(srcDir, "main.ts"), "utf-8");
    assert.ok(!mainSrc.includes("hotkeys:"), "commands must not set default hotkeys");
  });

  test("LICENSE present", () => {
    assert.ok(
      fs.existsSync(path.join(__dirname, "..", "LICENSE")),
      "LICENSE required for community plugin guidelines",
    );
  });
});

// ── Write-path contract (structural — ops module + service wire-up) ────────

describe("write-path contract (structural)", () => {
  const serviceSrc = fs.readFileSync(
    path.join(srcDir, "services", "kernel-service.ts"),
    "utf-8",
  );
  const opsSrc = fs.readFileSync(
    path.join(srcDir, "services", "kernel-workspace-ops.ts"),
    "utf-8",
  );
  const loaderSrc = fs.readFileSync(
    path.join(srcDir, "bridge", "kernel-loader.ts"),
    "utf-8",
  );
  const typeSrc = fs.readFileSync(
    path.join(srcDir, "bridge", "kernel-types.ts"),
    "utf-8",
  );

  test("ops use periodRelPath + appendToPeriodBody + executeWrite", () => {
    assert.ok(opsSrc.includes("periodRelPath"), "must use Kernel periodRelPath");
    assert.ok(opsSrc.includes("periodAbsPath"), "must use Kernel periodAbsPath");
    assert.ok(opsSrc.includes("appendToPeriodBody"));
    assert.ok(opsSrc.includes("executeWrite"));
    assert.ok(!opsSrc.includes("streamTarget.relPath"), "must not invent .relPath");
  });

  test("listStreamPeriods is awaited with options object", () => {
    assert.ok(opsSrc.includes("await kernel.listStreamPeriods"));
    assert.ok(opsSrc.includes("workspaceRoot"));
    assert.ok(!opsSrc.includes("listStreamPeriods(workspaceRoot,"));
  });

  test("reconcilePeriodBody is positional (body, opts) and uses .changed", () => {
    assert.ok(opsSrc.includes("reconcilePeriodBody(body,"));
    assert.ok(opsSrc.includes("result.changed"));
    assert.ok(!opsSrc.includes("result.reconciled"));
  });

  test("KernelService delegates to pure ops + mapApplySuggestionResult", () => {
    assert.ok(serviceSrc.includes("captureToWorkspace"));
    assert.ok(serviceSrc.includes("listStreamPeriodsForWorkspace"));
    assert.ok(serviceSrc.includes("reconcilePeriodNote"));
    assert.ok(serviceSrc.includes("mapApplySuggestionResult"));
    assert.ok(serviceSrc.includes("toggleTodoItem"));
    assert.ok(serviceSrc.includes("runOperation"));
    assert.ok(opsSrc.includes("createInboxNoteInWorkspace"));
    assert.ok(opsSrc.includes("acceptPendingWrite"));
    assert.ok(serviceSrc.includes("createInboxNoteInWorkspace"));
    assert.ok(serviceSrc.includes("acceptPendingWrite"));
  });

  test("KernelApi types document real Kernel shapes", () => {
    assert.ok(typeSrc.includes("periodRelPath"));
    assert.ok(typeSrc.includes("Promise<ListedStreamPeriod[]>"));
    assert.ok(typeSrc.includes("changed: boolean"));
    assert.ok(typeSrc.includes("reconcilePeriodBody("));
    assert.match(loaderSrc, /from "\.\/kernel-types\.ts"/);
  });

  test("stream workbench new-note goes through Kernel writeback", () => {
    const workbench = fs.readFileSync(
      path.join(srcDir, "views", "stream-workbench-view.ts"),
      "utf-8",
    );
    assert.match(workbench, /createInboxNote\(\)/);
    assert.doesNotMatch(workbench, /adapter\.write/);
  });
});

describe("pending-writes queue (shipped)", () => {
  test("stash / list / take / reject / restore", async () => {
    const pw = await importShipped("services/pending-writes.ts");
    pw.clearPendingWrites();
    const e = pw.stashPendingWrite({
      relativePath: "20-专题/a.md",
      content: "hello",
      toolName: "edit_file",
    });
    assert.equal(pw.listPendingWrites().length, 1);
    assert.equal(pw.listPendingWrites()[0].id, e.id);
    assert.equal(pw.listPendingWrites()[0].relativePath, "20-专题/a.md");
    assert.equal(pw.rejectPendingWrite("missing"), false);
    const taken = pw.takePendingWrite(e.id);
    assert.equal(taken?.content, "hello");
    assert.equal(pw.listPendingWrites().length, 0);
    pw.restorePendingWrite(taken);
    assert.equal(pw.listPendingWrites().length, 1);
    assert.equal(pw.rejectPendingWrite(e.id), true);
    assert.equal(pw.listPendingWrites().length, 0);
  });
});

describe("chat session compact + render error boundaries", () => {
  test("compactChatMessages keeps recent full and caps older turns", async () => {
    const { compactChatMessages, CHAT_COMPACT_DEFAULTS } = await importShipped("utils.ts");
    assert.equal(CHAT_COMPACT_DEFAULTS.maxMessages, 60);
    assert.equal(CHAT_COMPACT_DEFAULTS.keepRecent, 24);
    const msgs = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `msg-${i} ${"x".repeat(200)}`,
      reasoning: i < 70 ? "r".repeat(500) : "",
    }));
    const out = compactChatMessages(msgs, { maxMessages: 60, keepRecent: 24, maxPerMessage: 100 });
    assert.ok(out.length <= 60);
    assert.ok(out.length >= 24);
    const last = out[out.length - 1];
    assert.match(last.content, /msg-79/);
    assert.ok(last.content.length > 100, "recent message stays full");
    const older = out[0];
    assert.ok(String(older.content).length <= 120, `older message capped, got ${String(older.content).length}`);
  });

  test("compactChatMessages respects maxChars and never drops the latest turn", async () => {
    const { compactChatMessages } = await importShipped("utils.ts");
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      role: "user",
      content: `${i}:${"y".repeat(5000)}`,
    }));
    const out = compactChatMessages(msgs, { maxMessages: 60, keepRecent: 4, maxChars: 20_000 });
    assert.ok(out.length >= 4);
    assert.match(out[out.length - 1].content, /^29:/);
    const total = out.reduce((n, m) => n + m.content.length, 0);
    assert.ok(total <= 20_000 + 50, `char budget respected, got ${total}`);
  });

  test("views wrap render in an error boundary (no unhandled rejection surface)", () => {
    for (const rel of [
      "views/sidebar-dock-view.ts",
      "views/memory-browse-view.ts",
      "views/stream-workbench-view.ts",
    ]) {
      const src = fs.readFileSync(path.join(srcDir, rel), "utf8");
      assert.match(src, /render failed:|refresh failed:/, rel);
      assert.match(src, /console\.error\("\[topmind\]/, rel);
    }
    const ops = fs.readFileSync(path.join(srcDir, "services", "kernel-workspace-ops.ts"), "utf8");
    assert.match(ops, /compactChatMessages\(/, "agent prompt uses session compact");
    assert.doesNotMatch(ops, /\.slice\(-10\)/, "no hard 10-turn window");
  });

  test("locale switch re-registers command names (not frozen at boot)", () => {
    const mainSrc = fs.readFileSync(path.join(srcDir, "main.ts"), "utf8");
    assert.match(mainSrc, /private registerCommands\(\)/);
    assert.match(mainSrc, /applyLocale\(locale: string\)/);
    assert.match(mainSrc, /removeCommand/);
    assert.match(mainSrc, /this\.registerCommands\(\);/);
    // Settings must route locale changes through the plugin helper.
    const settings = fs.readFileSync(path.join(srcDir, "settings", "settings-tab.ts"), "utf8");
    assert.match(settings, /this\.plugin\.applyLocale\(/);
    assert.doesNotMatch(settings, /[^.]setLocale\(/, "settings must not bypass plugin.applyLocale");
  });
});
