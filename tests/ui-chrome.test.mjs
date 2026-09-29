// ── ui-chrome.test.mjs (split from plugin.test.mjs) ──────────────────────────

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


// ── Toolbar / labeled-button chrome (shipped CSS + views) ───────────────────

describe("Obsidian labeled-button chrome (shipped)", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf-8");
  const workbench = fs.readFileSync(path.join(srcDir, "views", "stream-workbench-view.ts"), "utf-8");
  const sidebar = fs.readFileSync(path.join(srcDir, "views", "sidebar-dock-view.ts"), "utf-8");
  const zh = fs.readFileSync(path.join(srcDir, "i18n", "locales", "zh-CN.ts"), "utf-8");
  const en = fs.readFileSync(path.join(srcDir, "i18n", "locales", "en-US.ts"), "utf-8");

  test("chrome buttons are icon-only with accessible names", () => {
    // Toolbar and sidebar header both render icon-only controls; labels live
    // in aria-label / title (community + a11y), not painted text chrome.
    assert.match(css, /\.tm-toolbar-btn\b/);
    assert.doesNotMatch(css, /\.tm-toolbar-btn-labeled/);
    // Dead labeled-ghost skin must stay gone (no leftover unused selectors).
    assert.doesNotMatch(css, /\.tm-sidebar-btn-labeled/);
    assert.doesNotMatch(css, /\.tm-sidebar-btn-label\b/);
    // Every icon-only control in TS carries an accessible name.
    assert.match(sidebar, /setIcon\([^)]+\)[\s\S]{0,200}aria-label|aria-label[\s\S]{0,200}setIcon\(/);
  });

  test("narrow pane hides labels only under an explicit container query", () => {
    assert.match(css, /@container tm-workbench \(max-width:\s*560px\)/);
    assert.match(css, /@container tm-sidebar \(max-width:\s*260px\)/);
    assert.match(css, /container-name:\s*tm-workbench/);
    assert.match(css, /container-name:\s*tm-sidebar/);
  });

  test("refresh and organize use distinct icons and handlers", () => {
    assert.match(workbench, /setIcon\(refreshStreamBtn,\s*"refresh-cw"\)/);
    // organize = sort glyph (Desktop RiSortDesc); list-checks is reserved for todos
    assert.match(workbench, /setIcon\(this\.organizeBtn,\s*"arrow-down-wide-narrow"\)/);
    assert.match(workbench, /stream_unreconciled/);
    assert.match(workbench, /p\.reconciled === false/);
    assert.match(workbench, /refreshStreamBtn\.addEventListener\("click".*refreshStream/s);
    assert.match(workbench, /this\.organizeBtn\.addEventListener\("click".*organizePeriod/s);
    assert.doesNotMatch(workbench, /setIcon\(this\.organizeBtn,\s*"refresh-cw"\)/);
    assert.doesNotMatch(workbench, /setIcon\(this\.organizeBtn,\s*"list-checks"\)/);
    // Workbench entry moved to the Obsidian activity bar (main.ts ribbon).
    const mainSrc = fs.readFileSync(path.join(srcDir, "main.ts"), "utf-8");
    assert.match(mainSrc, /addRibbonIcon\("waves",\s*t\("sidebar_open_workbench"\)/);
  });

  test("icon-only and labeled buttons ship aria-label / title", () => {
    assert.match(workbench, /refreshStreamBtn\.setAttribute\("aria-label"/);
    assert.match(workbench, /refreshStreamBtn\.setAttribute\("title"/);
    assert.match(workbench, /sidebarBtn\.setAttribute\("aria-label"/);
    assert.match(workbench, /newNoteBtn\.setAttribute\("title"/);
    // Header icon buttons were removed (user request); ribbon icons carry titles via API.
    assert.match(sidebar, /statusDiv\.setAttribute\("title"/);
  });

  test("toolbar label keys exist in both locales", () => {
    for (const key of [
      "toolbar_btn_sidebar",
      "toolbar_btn_settings",
      "toolbar_btn_new_note",
      "toolbar_btn_profile",
      "toolbar_btn_refresh",
      "stream_organize",
      "sidebar_btn_workbench",
    ]) {
      const re = new RegExp(`${key}:\\s*"`);
      assert.match(zh, re, `zh missing ${key}`);
      assert.match(en, re, `en missing ${key}`);
    }
    assert.match(zh, /sidebar_btn_workbench:\s*"动态"/);
    assert.match(en, /sidebar_btn_workbench:\s*"Stream"/);
    assert.doesNotMatch(zh, /sidebar_btn_workbench:\s*"[^"]*工作台/);
  });

  test("suggestion card CSS covers live kinds only and has no hardcoded hex", () => {
    assert.match(css, /tm-suggestion-inbox-organize/);
    assert.doesNotMatch(css, /tm-suggestion-todo-extract/);
    assert.doesNotMatch(css, /tm-suggestion-topic-classify/);
    assert.doesNotMatch(css, /var\(--color-[a-z]+,\s*#[0-9a-fA-F]+\)/);
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}/);
  });

  test("chat thinking uses a CSS spinner, not ellipsis-only copy", () => {
    const think = sidebar.slice(sidebar.indexOf("this.chatThinking"));
    assert.match(think, /tm-loading-spinner-sm/);
    assert.match(think, /t\("chat_thinking"\)/);
  });
});

