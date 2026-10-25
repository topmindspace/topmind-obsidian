import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { captureChatFocus, buildFocusContext, persistableChatFocus } from "../src/services/editor-context.ts";

test("sidebar focus still captures the most recent main editor and its selection", () => {
  const focus = captureChatFocus({
    getMostRecentLeaf: () => ({ view: { file: { path: "20-专题/topic/note.md" }, editor: {
      getValue: () => "paragraph", getSelection: () => "paragraph", getCursor: () => ({ line: 2 }),
    } } }),
    activeEditor: null,
  });
  assert.equal(focus.path, "20-专题/topic/note.md");
  assert.equal(focus.selection, "paragraph");
  assert.equal(focus.startLine, 3);
  assert.ok(!Object.hasOwn(persistableChatFocus(focus), "editorText"));
});

test("a non-document main view does not inherit an unrelated previous file", () => {
  assert.equal(captureChatFocus({ getMostRecentLeaf: () => ({ view: {} }), getActiveFile: () => ({ path: "old.md" }) }), null);
  assert.deepEqual(captureChatFocus({ getMostRecentLeaf: () => ({ view: { getChatFocus: () => ({ path: "10-动态/2026/2026-W43.md" }) } }) }), { path: "10-动态/2026/2026-W43.md" });
});

test("focus evidence includes the actual file, selection, nearest topic and dirty status", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tm-focus-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "20-专题", "2026-A"), { recursive: true });
  const relative = "20-专题/2026-A/note.md";
  fs.writeFileSync(path.join(root, relative), "alpha\nbeta\n");
  fs.writeFileSync(path.join(root, "20-专题/2026-A/topic.md"), "# Target topic\n");
  const evidence = buildFocusContext(root, { path: relative, selection: "beta", editorText: "alpha\nbeta\n" });
  assert.equal(evidence.unsaved, false);
  assert.match(evidence.prompt, /Target topic/);
  assert.match(evidence.prompt, /1\| alpha/);
  assert.match(evidence.contentHash, /^[a-f0-9]{16}$/);
  assert.equal(buildFocusContext(root, { path: relative, editorText: "unsaved" }).unsaved, true);
  assert.equal(buildFocusContext(root, { path: "../outside.md" }), null);
});

test('Obsidian vault-relative plugin directories resolve inside the actual vault', async () => {
  const { getEngineRoot } = await import('../src/bridge/vault-bridge.ts');
  assert.equal(getEngineRoot({ manifest: { dir: '.obsidian/plugins/topmind-stream' } }, '/vault'), '/vault/.obsidian/plugins/topmind-stream');
  assert.equal(getEngineRoot({ manifest: { dir: '/packaged/plugin' } }, '/vault'), '/packaged/plugin');
  assert.throws(() => getEngineRoot({ manifest: { dir: '../escape' } }, '/vault'), /escapes/);
  assert.throws(() => getEngineRoot({ manifest: {} }, '/vault'), /unavailable/);
});

test('execution-time guard protects dirty editors even after switching to a different file',async t=>{
 const {editorWriteConflict}=await import('../src/services/editor-context.ts');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tm-editor-guard-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'A.md'),'disk A');fs.writeFileSync(path.join(root,'B.md'),'disk B');
 let buffer='unsaved A';
 const workspace={getLeavesOfType:()=>[{view:{file:{path:'A.md'},editor:{getValue:()=>buffer}}}],getMostRecentLeaf:()=>({view:{file:{path:'B.md'}}})};
 assert.match(editorWriteConflict(workspace,root,['A.md']),/unsaved-editor-changes/);
 assert.equal(editorWriteConflict(workspace,root,['B.md']),null);
 buffer='disk A';assert.equal(editorWriteConflict(workspace,root,['A.md']),null);
});
