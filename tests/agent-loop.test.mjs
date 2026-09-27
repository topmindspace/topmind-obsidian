/**
 * Obsidian continuous agent loop: multi-step tools, auto-continue, discovery.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const pluginSrc = path.join(__dirname, "..", "src");

async function importShipped(rel) {
  return import(pathToFileURL(path.join(pluginSrc, rel)).href);
}

describe("Obsidian agent loop — continuous work", () => {
  let tmp;
  let kernel;
  let ops;
  let tools;

  before(async () => {
    kernel = await import(pathToFileURL(path.join(repoRoot, "lib", "kernel-api.mjs")).href);
    ops = await importShipped("services/kernel-workspace-ops.ts");
    tools = await importShipped("services/workspace-agent-tools.ts");
  });

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-obs-agent-"));
    fs.writeFileSync(
      path.join(tmp, "topmind.yaml"),
      "contract_version: 4\nwriteback:\n  mode: auto\n  backup_to: 99-归档/backups\n  receipts: 99-归档/receipts\n",
      "utf8",
    );
    fs.mkdirSync(path.join(tmp, "00-Inbox"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "10-动态"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "20-专题", "2026-主题"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "88-交付"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "99-归档", "backups"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "20-专题", "2026-主题", "note.md"),
      "---\ntitle: note\n---\n\nHello UNIQUE_AGENT_TOKEN world\n",
      "utf8",
    );
    fs.writeFileSync(path.join(tmp, "00-Inbox", "clip.md"), "# clip\n\nfrom inbox\n", "utf8");
    fs.writeFileSync(path.join(tmp, "memory", "todo.md"), "- [ ] first todo\n", "utf8");
  });

  after(() => {
    if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("parseToolCall accepts discovery tools and embedded JSON", () => {
    assert.equal(ops.parseToolCall(JSON.stringify({ tool: "search", query: "x" }))?.tool, "search");
    assert.equal(ops.parseToolCall(JSON.stringify({ tool: "workspace_overview" }))?.tool, "workspace_overview");
    assert.equal(ops.parseToolCall('Here:\n```json\n{"tool":"list_todos"}\n```')?.tool, "list_todos");
    assert.equal(
      ops.parseToolCall('thinking…\n{"tool":"save_file","relativePath":"a.md","content":"x"}\n')?.tool,
      "save_file",
    );
    assert.equal(ops.parseToolCall("just prose, no tool")?.tool ?? null, null);
    // Unknown tools still surface so the loop can error-continue (not "finish").
    assert.equal(ops.parseToolCall(JSON.stringify({ tool: "invent_tool" }))?.tool, "invent_tool");
  });

  test("buildObsidianChatToolGuide demands continuous multi-step work", () => {
    for (const loc of ["zh-CN", "en-US"]) {
      const guide = ops.buildObsidianChatToolGuide(loc, "auto");
      assert.match(guide, /search/);
      assert.match(guide, /save_file/);
      assert.match(guide, /workspace_overview/);
      assert.match(guide, /连续调用工具|CONTINUOUS|until the goal is fully done/i);
    }
  });

  test("search / overview / save_file / todos work via agent tools", () => {
    const ctx = {
      kernel,
      workspaceRoot: tmp,
      engineRoot: tmp,
      writebackMode: "auto",
      actor: "ai",
    };
    const hit = tools.searchWorkspace(ctx, { query: "UNIQUE_AGENT_TOKEN" });
    assert.equal(hit.ok, true, JSON.stringify(hit));
    assert.ok(hit.count >= 1);
    assert.match(String(hit.results[0].relativePath), /note\.md$/);

    const overview = tools.workspaceOverview(ctx);
    assert.equal(overview.ok, true);
    assert.ok(Array.isArray(overview.categories) && overview.categories.length > 0);

    const saved = tools.saveFile(ctx, {
      relativePath: "20-专题/2026-主题/agent-created.md",
      content: "# created by agent\n\nbody\n",
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.ok(fs.existsSync(path.join(tmp, "20-专题", "2026-主题", "agent-created.md")));

    const added = tools.addTodo(ctx, { text: "agent todo item" });
    assert.equal(added.ok, true, JSON.stringify(added));
    const todos = tools.listTodos(ctx, {});
    assert.equal(todos.ok, true);
    assert.ok(todos.items.some((t) => String(t.text).includes("agent todo")));
  });

  test("runWorkspaceChatTurn auto-continues after step budget while mid-task", async () => {
    // maxSteps=3: three tool calls exhaust the budget → auto-continue → answer.
    let calls = 0;
    const generate = async () => {
      calls += 1;
      if (calls <= 3) {
        return JSON.stringify({ tool: "list_categories" });
      }
      return "Done. Path: 20-专题/2026-主题/note.md";
    };
    const progress = [];
    const turn = await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: "inspect workspace then finish",
      generate,
      locale: "en",
      maxSteps: 3,
      onProgress: (ev) => progress.push(ev),
    });
    assert.ok(turn.autoContinues >= 1, `autoContinues=${turn.autoContinues}`);
    assert.equal(turn.stepLimitHit, true);
    assert.ok(turn.toolCalls.length >= 3, `toolCalls=${turn.toolCalls.length}`);
    assert.match(turn.body, /Done/);
    assert.ok(progress.some((p) => p.kind === "continue"));
  });

  test("runWorkspaceChatTurn keeps working across search → save_file → answer", async () => {
    const script = [
      JSON.stringify({ tool: "search", query: "UNIQUE_AGENT_TOKEN" }),
      JSON.stringify({
        tool: "save_file",
        relativePath: "20-专题/2026-主题/followup.md",
        content: "# followup\n\nlinked UNIQUE_AGENT_TOKEN\n",
      }),
      "## Done\nCreated followup.md from the search hit.",
    ];
    let i = 0;
    const generate = async () => script[Math.min(i++, script.length - 1)];
    const turn = await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: "find the token and create a follow-up note",
      generate,
      locale: "en",
      maxSteps: 32,
    });
    assert.equal(i, 3, `generate calls=${i}`);
    assert.ok(turn.toolCalls.some((t) => t.tool === "search" && t.ok));
    assert.ok(turn.toolCalls.some((t) => t.tool === "save_file" && t.ok));
    assert.match(turn.body, /Done/);
    assert.ok(fs.existsSync(path.join(tmp, "20-专题", "2026-主题", "followup.md")));
    assert.equal(turn.autoContinues, 0);
    assert.equal(turn.stepLimitHit, false);
  });

  test("bare [DONE] after a tool is incomplete until a path receipt exists", async () => {
    let calls = 0;
    const generate = async () => {
      calls += 1;
      if (calls === 1) return JSON.stringify({ tool: "list_categories" });
      return "All done [DONE]";
    };
    const turn = await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: "list categories then close",
      generate,
      locale: "en",
      maxSteps: 6,
      autoContinue: false,
    });
    assert.equal(turn.goal.status, "incomplete");
    assert.equal(turn.goal.blockReason, "missing-path-receipts");
    assert.equal(turn.goal.pathReceipts.length, 0);
    assert.match(turn.body, /\[INCOMPLETE/);
  });

  test("pause keeps the task ledger and is not cancelled", async () => {
    const turn = await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: "整理交付稿",
      generate: async () => JSON.stringify({ tool: "list_categories" }),
      locale: "zh-CN",
      maxSteps: 4,
      shouldAbort: () => true,
      stopKind: () => "paused",
      priorGoal: {
        goal: "整理交付稿",
        plan: ["读原文", "写成稿"],
        criteria: ["成稿存在"],
        openCriteria: ["成稿存在"],
        status: "working",
        pathReceipts: ["20-专题/2026-主题/note.md"],
      },
    });
    assert.equal(turn.stopReason, "paused");
    assert.equal(turn.cancelled, false);
    assert.deepEqual(turn.goal.plan, ["读原文", "写成稿"]);
    assert.deepEqual(turn.goal.openCriteria, ["成稿存在"]);
    assert.ok(turn.goal.pathReceipts.includes("20-专题/2026-主题/note.md"));
    assert.match(turn.body, /已暂停/);
  });

  test("cancel is a distinct stop and does not report paused", async () => {
    const turn = await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: "整理交付稿",
      generate: async () => "should not run",
      locale: "en",
      maxSteps: 2,
      shouldAbort: () => true,
      stopKind: () => "cancelled",
    });
    assert.equal(turn.stopReason, "cancelled");
    assert.equal(turn.cancelled, true);
    assert.match(turn.body, /Cancelled/);
  });

  test("resume prompt and 继续 keep the saved ledger, including a pause", async () => {
    const prior = {
      goal: "整理交付稿",
      plan: ["读原文", "写成稿"],
      criteria: ["成稿存在"],
      openCriteria: ["成稿存在"],
      pathReceipts: ["20-专题/2026-主题/note.md"],
      status: "working",
    };
    // Same text sidebar-dock-view resumeChat sends.
    const resume = [
      "[系统] 任务被用户暂停后恢复，可能尚未完成。请继续完成用户原始目标；若已完成则给出简短结论与路径回执。",
      "原目标：整理交付稿",
      "计划：\n1. 读原文\n2. 写成稿",
      "未完成验收项：\n- 成稿存在",
      "先更新/执行剩余步骤，再收尾。收尾时输出结论 + 路径回执 + [DONE]；若无法完成则 [INCOMPLETE 原因]。",
    ].join("\n");
    const assertKept = (turn) => {
      assert.equal(turn.goal.goal, "整理交付稿");
      assert.deepEqual(turn.goal.plan, ["读原文", "写成稿"]);
      assert.deepEqual(turn.goal.openCriteria, ["成稿存在"]);
      assert.ok(turn.goal.pathReceipts.includes("20-专题/2026-主题/note.md"));
      assert.notEqual(turn.goal.status, "idle");
    };
    assertKept(await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: resume,
      generate: async () => "仍在写",
      locale: "zh-CN",
      maxSteps: 2,
      autoContinue: false,
      priorGoal: prior,
    }));
    assertKept(await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: "继续",
      generate: async () => "仍在写",
      locale: "zh-CN",
      maxSteps: 2,
      autoContinue: false,
      priorGoal: prior,
    }));
    // Pause returns this snapshot; the view saves it. It must not be an empty ledger.
    const paused = await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: resume,
      generate: async () => "should not run",
      locale: "zh-CN",
      maxSteps: 2,
      shouldAbort: () => true,
      stopKind: () => "paused",
      priorGoal: prior,
    });
    assert.equal(paused.stopReason, "paused");
    assert.equal(paused.cancelled, false);
    assertKept(paused);
  });

  test("open criteria survive restore when the snapshot uses openCriteria", async () => {
    const turn = await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: "整理交付稿",
      generate: async () => "仍在写",
      locale: "zh-CN",
      maxSteps: 2,
      autoContinue: false,
      priorGoal: {
        goal: "整理交付稿",
        plan: ["读原文", "写成稿"],
        openCriteria: ["成稿存在"],
        status: "working",
      },
    });
    assert.deepEqual(turn.goal.plan, ["读原文", "写成稿"]);
    assert.deepEqual(turn.goal.openCriteria, ["成稿存在"]);
    assert.notEqual(turn.goal.status, "done");
  });

  test("unknown tool does not silently finish the turn", async () => {
    let calls = 0;
    const generate = async () => {
      calls += 1;
      if (calls === 1) return JSON.stringify({ tool: "not_a_real_tool" });
      return "Recovered and finished.";
    };
    const turn = await ops.runWorkspaceChatTurn(kernel, tmp, {
      userMessage: "try a bad tool then recover",
      generate,
      locale: "en",
      maxSteps: 8,
    });
    assert.equal(calls, 2);
    assert.match(turn.body, /Recovered/);
  });

  test("clampMaxAgentSteps matches Desktop 3–80 default 32", () => {
    assert.equal(ops.clampMaxAgentSteps(undefined), 32);
    assert.equal(ops.clampMaxAgentSteps(1), 3);
    assert.equal(ops.clampMaxAgentSteps(200), 80);
    assert.equal(ops.clampMaxAgentSteps(24), 24);
    assert.equal(ops.AGENT_STEPS_DEFAULT, 32);
  });
});

describe("chat compact budget scales with model contextLimit", () => {
  test("resolveChatCompactBudget matches Desktop window scaling", async () => {
    const utils = await importShipped("utils.ts");
    const def = utils.resolveChatCompactBudget(undefined);
    assert.equal(def.maxMessages, 60);
    const big = utils.resolveChatCompactBudget(200_000);
    assert.ok(big.maxMessages > 60, `expected scaled-up maxMessages, got ${big.maxMessages}`);
    assert.ok(big.maxChars > 240_000);
    const small = utils.resolveChatCompactBudget(32_000);
    assert.ok(small.maxMessages < 60);
  });
});
