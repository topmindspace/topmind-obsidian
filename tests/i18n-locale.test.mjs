// ── i18n-locale.test.mjs (split from plugin.test.mjs) ──────────────────────────

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


describe("i18n locale key alignment", () => {
  test("zh-CN and en-US have identical key sets", () => {
    const zhContent = fs.readFileSync(
      path.join(srcDir, "i18n", "locales", "zh-CN.ts"),
      "utf-8",
    );
    const enContent = fs.readFileSync(
      path.join(srcDir, "i18n", "locales", "en-US.ts"),
      "utf-8",
    );

    const keyRegex = /^\s*(\w+):\s*"/gmu;
    const zhKeys = new Set();
    const enKeys = new Set();

    let match;
    while ((match = keyRegex.exec(zhContent)) !== null) {
      zhKeys.add(match[1]);
    }
    keyRegex.lastIndex = 0;
    while ((match = keyRegex.exec(enContent)) !== null) {
      enKeys.add(match[1]);
    }

    for (const key of zhKeys) {
      assert.ok(enKeys.has(key), `en-US missing key: ${key}`);
    }
    for (const key of enKeys) {
      assert.ok(zhKeys.has(key), `zh-CN missing key: ${key}`);
    }
    assert.equal(zhKeys.size, enKeys.size, "Key count mismatch");
    // URL / a11y keys that UI uses must be present
    assert.ok(zhKeys.has("notice_url_to_inbox"), "missing notice_url_to_inbox");
    assert.ok(zhKeys.has("stream_expand_entry"), "missing stream_expand_entry");
    assert.ok(zhKeys.has("quick_capture_hint_enter_note"), "missing quick_capture_hint_enter_note");
    assert.ok(zhKeys.size >= 90, `Expected at least 90 keys, got ${zhKeys.size}`);
  });

  test("user-facing titles use 动态/Stream and 记下/记一下 distinctly", () => {
    const zhContent = fs.readFileSync(
      path.join(srcDir, "i18n", "locales", "zh-CN.ts"),
      "utf-8",
    );
    const enContent = fs.readFileSync(
      path.join(srcDir, "i18n", "locales", "en-US.ts"),
      "utf-8",
    );
    assert.match(zhContent, /stream_workbench_title:\s*"动态"/);
    assert.match(enContent, /stream_workbench_title:\s*"Stream"/);
    assert.doesNotMatch(zhContent, /stream_workbench_title:\s*"[^"]*工作台/);
    assert.doesNotMatch(enContent, /stream_workbench_title:\s*"[^"]*Workbench/);
    assert.match(zhContent, /quick_capture_note_it:\s*"记一下"/);
    assert.match(zhContent, /quick_capture_log_it:\s*"记下"/);
    assert.match(zhContent, /toolbar_btn_profile:\s*"我的情况"/);
    assert.match(enContent, /toolbar_btn_profile:\s*"My profile"/);
    assert.match(zhContent, /pending_writes_title:\s*"待确认写入"/);
    assert.match(enContent, /pending_writes_title:\s*"Pending writes"/);
    assert.doesNotMatch(zhContent, /notice_write_pending:\s*"[^"]*审阅/);
    assert.doesNotMatch(zhContent, /quick_capture_submit:/);
    assert.doesNotMatch(enContent, /quick_capture_submit:/);
    assert.doesNotMatch(zhContent, /suggestion_todo:/);
    assert.doesNotMatch(enContent, /suggestion_todo:/);
    assert.match(zhContent, /stream_loading:\s*"加载中"/);
    assert.match(enContent, /stream_loading:\s*"Loading"/);
    assert.doesNotMatch(zhContent, /stream_loading:\s*"加载中\.\.\."/);
    assert.doesNotMatch(enContent, /stream_loading:\s*"Loading\.\.\."/);
    assert.doesNotMatch(zhContent, /suggestions_loading:\s*"[^"]*\.\.\."/);
    assert.doesNotMatch(enContent, /suggestions_loading:\s*"[^"]*\.\.\."/);
    assert.doesNotMatch(zhContent, /chat_thinking:\s*"[^"]*\.\.\."/);
    assert.doesNotMatch(enContent, /chat_thinking:\s*"[^"]*\.\.\."/);
  });

  test("t() interpolates {{var}} placeholders", () => {
    const i18n = fs.readFileSync(path.join(srcDir, "i18n", "index.ts"), "utf-8");
    assert.match(i18n, /vars\?:\s*Record<string,\s*string\s*\|\s*number>/);
    assert.match(i18n, /replaceAll\(`\{\{\$\{k\}\}\}`/);
    const zh = fs.readFileSync(path.join(srcDir, "i18n", "locales", "zh-CN.ts"), "utf-8");
    const en = fs.readFileSync(path.join(srcDir, "i18n", "locales", "en-US.ts"), "utf-8");
    assert.match(zh, /stream_entry_count:\s*"\{\{count\}\} 条"/);
    assert.match(en, /stream_entry_count:\s*"\{\{count\}\} entries"/);
  });
});

