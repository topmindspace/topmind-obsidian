import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
register(new URL('./obsidian-stub-loader.mjs', import.meta.url).href, import.meta.url);
const kernel = await import('../lib/kernel-api.mjs');
const { runWorkspaceChatTurn } = await import('../src/services/chat-agent.ts');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-targeting-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'topmind.yaml'), 'contract_version: 4\nwriteback:\n  mode: auto\n');
  fs.writeFileSync(path.join(root, 'A.md'), '# Article A\n\nOriginal content.\n');
  fs.writeFileSync(path.join(root, 'B.md'), '# Article B\n');
  return root;
}
test('missing target and unavailable image generation never invoke the model', async t => {
  const root = fixture(t);
  let requests = 0;
  const generate = async () => { requests++; return 'must not run'; };
  const missing = await runWorkspaceChatTurn(kernel, root, { userMessage: '调用 revise', generate });
  assert.equal(missing.goal.blockReason, 'needs-target');
  const image = await runWorkspaceChatTurn(kernel, root, { userMessage: '为当前文章生成封面', focus: { path: 'A.md' }, generate });
  assert.equal(image.goal.blockReason, 'image-generation-unavailable');
  assert.equal(requests, 0);
});
test('real agent reads the bound article directly, preloads revise, and stops repeated successes', async t => {
  const root = fixture(t); let requests = 0;
  const result = await runWorkspaceChatTurn(kernel, root, { userMessage: '调用 revise', focus: { path: 'A.md' }, maxSteps: 80,
    generate: async (_prompt, context) => {
      requests++;
      assert.match(context.systemPrompt, /Host-preloaded skill: topmind-revise/);
      assert.match(context.systemPrompt, /"targetPath":"A.md"/);
      return JSON.stringify({ tool: 'read_file' });
    } });
  assert.equal(result.goal.status, 'blocked');
  assert.equal(result.goal.blockReason, 'repeated-result');
  assert.equal(requests, 3);
  assert.equal(result.autoContinues, 0);
  assert.equal(fs.readFileSync(path.join(root, 'B.md'), 'utf8'), '# Article B\n');
});
test('wrong target, web search, and review-only writes are stopped before side effects', async t => {
  const root = fixture(t);
  for (const call of [{ tool: 'edit_file', relativePath: 'B.md', oldText: 'B', newText: 'wrong' }, { tool: 'web_search', query: 'unrelated' }, { tool: 'save_file', relativePath: 'A.md', content: 'wrong' }]) {
    let requests = 0;
    const result = await runWorkspaceChatTurn(kernel, root, { userMessage: 'revise', focus: { path: 'A.md', taskIntent: { targetPath: 'A.md', output: 'review' } }, generate: async () => { requests++; return JSON.stringify(call); } });
    assert.equal(result.goal.status, 'blocked');
    assert.equal(requests, 1);
  }
  assert.equal(fs.readFileSync(path.join(root, 'A.md'), 'utf8'), '# Article A\n\nOriginal content.\n');
});
test('clarifying the selected article retains the pending revise request', async t => {
  const root = fixture(t);
  const first = await runWorkspaceChatTurn(kernel, root, { userMessage: '调用 revise', generate: async () => { throw new Error('must not generate'); } });
  const result = await runWorkspaceChatTurn(kernel, root, { userMessage: '就是这篇', focus: { path: 'A.md' }, priorGoal: first.goal, generate: async (_prompt, context) => {
    assert.match(context.systemPrompt, /Host-preloaded skill: topmind-revise/);
    assert.match(context.systemPrompt, /"targetPath":"A.md"/);
    return '建议保留现有事实和结构。';
  } });
  assert.equal(result.goal.task.skillId, 'topmind-revise');
  assert.equal(result.goal.task.targetPath, 'A.md');
});
test('source changes during model execution prevent a stale write', async t => {
  const root = fixture(t);
  const result = await runWorkspaceChatTurn(kernel, root, { userMessage: 'revise', focus: { path: 'A.md' }, generate: async () => {
    fs.writeFileSync(path.join(root, 'A.md'), '# Article A\n\nExternal change.\nOriginal content.\n');
    return JSON.stringify({ tool: 'edit_file', relativePath: 'A.md', oldText: 'Original content.', newText: 'Changed by AI.' });
  } });
  assert.equal(result.goal.blockReason, 'source-changed');
  const text = fs.readFileSync(path.join(root, 'A.md'), 'utf8');
  assert.match(text, /External change/); assert.doesNotMatch(text, /Changed by AI/);
});
