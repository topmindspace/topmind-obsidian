// ── ai-chat-hygiene.test.mjs (split from plugin.test.mjs) ──────────────────────────

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


// ── AI provider transient error detection (shipped pure util) ──────────────

describe("AI task manager + chat write-gate hygiene (source)", () => {
  test("ai-task-manager is a serial queue with honest stop-tracking abort", () => {
    const src = fs.readFileSync(path.join(srcDir, "services", "ai-task-manager.ts"), "utf8");
    // Serial lane: inFlight (not `active`) is the gate — abort() clears active
    // but leaves inFlight set until the provider call settles, so a follow-up
    // enqueue cannot start a second concurrent request.
    assert.match(src, /if \(this\.inFlight\) return/);
    assert.match(src, /private inFlight = false/);
    // Abort = stop-tracking: task marked aborted immediately, late result discarded
    assert.match(src, /task\.status = "aborted"/);
    assert.match(src, /abortedMidFlight/);
    // No AbortSignal plumbing — Obsidian requestUrl cannot cancel mid-flight,
    // so the UI must never imply engine-level cancellation.
    assert.doesNotMatch(src, /AbortController/);
    assert.match(src, /subscribe\(fn: TaskListener\)/);
    assert.match(src, /multiActive/);
  });

  test("chat UI chrome follows getLocale; durable answer uses Kernel 3-tier", () => {
    const src = fs.readFileSync(path.join(srcDir, "services", "kernel-service.ts"), "utf8");
    const ops = fs.readFileSync(path.join(srcDir, "services", "kernel-workspace-ops.ts"), "utf8");
    assert.match(src, /getLocale\(\)/);
    assert.match(src, /localeOverride \|\| getLocale/);
    assert.match(src, /resolveChatDurableLocale/);
    assert.match(src, /surfaceUiLocale/);
    assert.match(ops, /resolveAgentOutputLanguage/);
    assert.match(ops, /用户可见回答语言|User-visible answer language/);
  });

  test("chat sanitizes thinking and does not write notes", () => {
    const src = fs.readFileSync(path.join(srcDir, "services", "kernel-service.ts"), "utf8");
    const ops = fs.readFileSync(path.join(srcDir, "services", "kernel-workspace-ops.ts"), "utf8");
    assert.match(src, /runWorkspaceChatTurn/);
    assert.match(src, /<think>/);
    assert.match(ops, /splitAssistantVisible|applyUniqueSpan/);
    assert.match(ops, /preciseEditWorkspace/);
    assert.match(ops, /kernel\.executeWrite/);
    assert.doesNotMatch(src, /executeWrite\(\s*\{[\s\S]{0,200}operation:\s*["']chat["']/u);
    assert.doesNotMatch(ops, /executeWrite\(\s*\{[\s\S]{0,200}operation:\s*["']chat["']/u);
  });

  test("chat reasoning fold defaults collapsed; host stays Pi-free and ledger-free", () => {
    const sidebar = fs.readFileSync(path.join(srcDir, "views", "sidebar-dock-view.ts"), "utf8");
    assert.match(sidebar, /createEl\("details", \{ cls: "tm-chat-reasoning" \}\)/);
    // Historical turns stay collapsed; the live working row may open so the
    // user can watch reasoning while the turn is still running.
    const historyFold = sidebar.slice(sidebar.indexOf("tm-chat-reasoning-body\""));
    const historyBlock = sidebar.slice(sidebar.indexOf('pre.setText(msg.reasoning)') - 400);
    assert.doesNotMatch(historyBlock, /setAttribute\(["']open["']/);
    assert.match(sidebar, /data-chat-reasoning-live/);
    assert.doesNotMatch(sidebar, /pi-agent-core|@earendil-works/);
    const pkg = fs.readFileSync(path.join(srcDir, "..", "package.json"), "utf8");
    assert.doesNotMatch(pkg, /pi-agent-core|pi-coding-agent/);
    const design = fs.readFileSync(path.join(srcDir, "..", "DESIGN.md"), "utf8");
    assert.match(design, /\*\*不发\*\*记账/);
    assert.match(design, /无 Pi/);
    const srcTree = [
      "main.ts",
      "views/sidebar-dock-view.ts",
      "views/stream-workbench-view.ts",
    ].map((rel) => fs.readFileSync(path.join(srcDir, rel), "utf8")).join("\n");
    assert.doesNotMatch(srcTree, /ledger mini-app|LedgerApp|topmind-ledger/);
  });
});

describe("Obsidian chat profile context (active-body collapse)", () => {
  test("loadChatProfileContext uses Kernel collapse and omits archived facts", async () => {
    const os = await import("node:os");
    const { loadChatProfileContext } = await importShipped("services/kernel-workspace-ops.ts");
    const kernel = await import(
      pathToFileURL(path.join(__dirname, "..", "lib", "kernel-api.mjs")).href
    );
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tm-obs-chat-profile-"));
    try {
      fs.writeFileSync(path.join(ws, "topmind.yaml"), "schema_version: 4\n", "utf8");
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, "memory", "profile.md"),
        `---
title: 我的情况
---

# 我的情况

## 进行中的事

- 仍在推进的活事实

## 历史记录

- （2026-01-01 归档）早已过期不该进提示词的事实
`,
        "utf8",
      );
      const ctx = loadChatProfileContext(kernel, ws, "zh-CN");
      assert.ok(ctx.includes("仍在推进的活事实"));
      assert.ok(!ctx.includes("早已过期不该进提示词的事实"));
      assert.match(ctx, /已归档条目|archived fact/u);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("runWorkspaceChatTurn folds Kernel thinking (shipped)", () => {
  test("tagged think is reasoning, not the visible body", async () => {
    const { splitAssistantVisible } = await import(
      pathToFileURL(path.join(__dirname, "..", "lib", "ai-content-sanitize.mjs")).href
    );
    const { runWorkspaceChatTurn } = await importShipped("services/kernel-workspace-ops.ts");
    const kernel = {
      loadContract: () => ({ writeback: { mode: "auto" } }),
      resolveAgentOutputLanguage: () => "zh",
      splitAssistantVisible,
    };
    const result = await runWorkspaceChatTurn(kernel, "/tmp/tm-chat-fold", {
      userMessage: "总结本周",
      generate: async () =>
        "<think>I should inspect the file first and plan a patch.</think>\n\n## 结论\n改中间那段即可。",
    });
    assert.doesNotMatch(result.body, /inspect the file|<think>/i);
    assert.match(result.body, /结论|改中间/);
    assert.match(result.reasoning, /inspect the file/);
  });
});

describe("isTransientError (shipped)", () => {
  test("classifies network/timeout vs client errors", async () => {
    const { isTransientError } = await importShipped("utils.ts");
    assert.ok(isTransientError(new TypeError("fetch failed")));
    assert.ok(isTransientError(new Error("Request timeout")));
    assert.ok(isTransientError(new Error("The operation was aborted")));
    assert.ok(!isTransientError(new Error("AI request failed (400): bad request")));
    assert.ok(!isTransientError(null));
    assert.ok(!isTransientError(undefined));
  });
});

