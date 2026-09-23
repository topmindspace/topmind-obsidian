/**
 * Lock writeback / agent-step policy copy against Desktop truth sources.
 * Surfaces must not fork Model-B graded-confirm semantics.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const pluginSrc = path.join(__dirname, "..", "src");
function resolveEngineRoot() {
  const candidates = [
    process.env.TOPMIND_SRC,
    path.resolve(repoRoot, "..", "topmind"),
    path.resolve(repoRoot, ".topmind-src"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "lib", "kernel-api.mjs"))) return dir;
  }
  throw new Error("topmind engine not found (set TOPMIND_SRC or clone as ../topmind)");
}
const engineRoot = resolveEngineRoot();

describe("writeback + agent-step policy parity with Desktop", () => {
  test("tool guide writeback copy shares Desktop graded-confirm key phrases", async () => {
    const ops = await import(
      pathToFileURL(path.join(pluginSrc, "services/kernel-workspace-ops.ts")).href
    );
    const desktopCopy = await import(
      pathToFileURL(path.join(engineRoot, "topmind-desktop", "electron", "lib", "writeback-mode-copy.mjs")).href
    );

    for (const mode of ["auto", "confirm"]) {
      for (const loc of ["zh-CN", "en-US"]) {
        const guide = ops.buildObsidianChatToolGuide(loc, mode);
        const desktop = desktopCopy.describeWritebackModeForPrompt(mode, loc.startsWith("en") ? "en" : "zh");
        // Shared anchors — same policy, not a fork.
        if (mode === "confirm") {
          assert.match(guide, /直接落盘|land immediately/);
          assert.match(guide, /删除\/归档|delete\/archive/);
          assert.match(desktop, /直接落盘|land immediately/);
        } else {
          assert.match(guide, /自动保存|auto-save/);
          assert.match(guide, /快照|snapshot/);
          assert.match(desktop, /自动保存|auto-save/);
        }
        // Model A forbidden on both.
        for (const text of [guide, desktop]) {
          assert.doesNotMatch(text, /must match file content exactly|必须精确匹配文件内容/);
          assert.doesNotMatch(text, /no write tools|不注册写工具|只读草稿/);
        }
      }
    }
  });

  test("agent step budget matches Desktop 3–80 default 32 + auto-continue×2", async () => {
    const ops = await import(
      pathToFileURL(path.join(pluginSrc, "services/kernel-workspace-ops.ts")).href
    );
    const settingsCore = await import(
      pathToFileURL(path.join(engineRoot, "topmind-desktop", "electron", "lib", "settings-core.mjs")).href
    );
    assert.equal(ops.AGENT_STEPS_DEFAULT, settingsCore.AGENT_STEPS_DEFAULT);
    assert.equal(ops.AGENT_STEPS_MIN, settingsCore.AGENT_STEPS_MIN);
    assert.equal(ops.AGENT_STEPS_MAX, settingsCore.AGENT_STEPS_MAX);
    assert.equal(ops.MAX_AUTO_CONTINUES, 2);
  });

  test("tool guide keeps unique-span edit contract and continuous-work mandate", async () => {
    const ops = await import(
      pathToFileURL(path.join(pluginSrc, "services/kernel-workspace-ops.ts")).href
    );
    for (const loc of ["zh-CN", "en-US"]) {
      const guide = ops.buildObsidianChatToolGuide(loc, "auto");
      assert.match(guide, /unique-span|唯一片段/);
      assert.match(guide, /expectedHash|contentHash/);
      assert.match(guide, /workspace_overview|search/);
      assert.match(guide, /save_file/);
      assert.match(guide, /CONTINUOUS|连续调用工具|until the goal is fully done/i);
    }
  });

  test("agent tools module is wired into the chat loop (not a dead shelf)", () => {
    const ops = fs.readFileSync(path.join(pluginSrc, "services/kernel-workspace-ops.ts"), "utf8");
    assert.match(ops, /from "\.\/workspace-agent-tools\.ts"/);
    assert.match(ops, /runAgentTool/);
    const tools = fs.readFileSync(path.join(pluginSrc, "services/workspace-agent-tools.ts"), "utf8");
    assert.match(tools, /export function searchWorkspace/);
    assert.match(tools, /export function saveFile/);
    assert.match(tools, /export function runAgentTool/);
    // Writes still go through the unique write gate.
    assert.match(tools, /executeWrite/);
  });

  test("expectedHash is soft on both surfaces (AI 编辑宽松)", () => {
    const tools = fs.readFileSync(path.join(pluginSrc, "services", "kernel-workspace-ops.ts"), "utf8");
    assert.match(tools, /hashStale/);
    assert.match(tools, /expectedHash was stale; unique-span still matched/);
    // Soft path: mark stale first; hard-reject only when matcher also fails.
    assert.match(tools, /if \(hashStale\) \{\s*return \{[\s\S]*?hash-mismatch/u);
    const desktopPathOps = fs.readFileSync(
      path.join(engineRoot, "topmind-desktop", "electron", "lib", "workspace-path-ops.mjs"),
      "utf8",
    );
    assert.match(desktopPathOps, /hashStale/);
    assert.match(desktopPathOps, /expectedHash was stale; unique-span still matched/);
  });

  test("content writes are confirmed:true on both surfaces (graded-confirm)", () => {
    const tools = fs.readFileSync(path.join(pluginSrc, "services", "workspace-agent-tools.ts"), "utf8");
    assert.match(tools, /confirmed: true/);
    assert.doesNotMatch(tools, /confirmed: ctx\.writebackMode !== "confirm"/);
    const ops = fs.readFileSync(path.join(pluginSrc, "services", "kernel-workspace-ops.ts"), "utf8");
    assert.match(ops, /confirmed: true/);
    assert.doesNotMatch(ops, /confirmed: mode !== "confirm"/);
    const desktop = fs.readFileSync(
      path.join(engineRoot, "topmind-desktop", "electron", "ai-tools.mjs"),
      "utf8",
    );
    assert.match(desktop, /confirmed: LIFECYCLE_TOOLS\.has\(toolName\) \? !needsUserConfirm : true/);
  });

  test("writebackModeOverride never forces a default that forks topmind.yaml", () => {
    const ops = fs.readFileSync(path.join(pluginSrc, "services", "kernel-workspace-ops.ts"), "utf8");
    // Only pass override when contract actually resolved.
    assert.match(ops, /writebackMode: contractMode \|\| opts\.writebackMode/);
    assert.doesNotMatch(ops, /writebackMode: modeHint/);
    const tools = fs.readFileSync(path.join(pluginSrc, "services", "workspace-agent-tools.ts"), "utf8");
    // Override is the already-resolved contract mode (may be undefined).
    assert.match(tools, /writebackModeOverride: ctx\.writebackMode/);
    assert.doesNotMatch(tools, /writebackModeOverride: ["']auto["']/);
  });

  test("text-note write surface is open beyond .md (Desktop parity)", async () => {
    const engineTextNote = await import(
      pathToFileURL(path.join(repoRoot, "lib", "text-note.mjs")).href
    );
    const tools = await import(
      pathToFileURL(path.join(pluginSrc, "services", "workspace-agent-tools.ts")).href
    );
    for (const ext of [".md", ".txt", ".json", ".yaml", ".csv", ".ts", ".html"]) {
      assert.equal(engineTextNote.isTextNotePath(`a/b${ext}`), true, ext);
      assert.equal(tools.isTextNotePath(`a/b${ext}`), true, ext);
    }
    for (const ext of [".png", ".pdf", ".zip"]) {
      assert.equal(engineTextNote.isTextNotePath(`a/b${ext}`), false, ext);
      assert.equal(tools.isTextNotePath(`a/b${ext}`), false, ext);
    }
    // Surfaces re-export the engine inventory — never a private fork.
    assert.deepEqual(
      [...engineTextNote.TEXT_NOTE_EXTS].sort(),
      [...tools.TEXT_NOTE_EXTS].sort(),
    );
    const toolsSrc = fs.readFileSync(path.join(pluginSrc, "services", "workspace-agent-tools.ts"), "utf8");
    assert.match(toolsSrc, /from "#kernel\/text-note\.mjs"/);
    assert.doesNotMatch(toolsSrc, /export const TEXT_NOTE_EXTS = Object\.freeze/);
  });

  test("readTodoList consumers use Kernel { items } shape (Desktop parity)", () => {
    const tools = fs.readFileSync(path.join(pluginSrc, "services/workspace-agent-tools.ts"), "utf8");
    assert.match(tools, /parsed\?\.items|parsed\.items/);
    assert.doesNotMatch(tools, /readTodoList\([^)]*\)\s*\|\|\s*\[\]/);
  });
});
