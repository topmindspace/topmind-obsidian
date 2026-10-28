import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
register(new URL('./obsidian-stub-loader.mjs', import.meta.url).href, import.meta.url);
const { WritingModal } = await import('../src/views/writing-modal.ts');

test('selecting a writing type only displays the task setup and never opens AI', () => {
  let sideEffects = 0;
  const app = { workspace: { getLeavesOfType: () => { sideEffects++; return []; } } };
  const modal = new WritingModal({ app, kernelService: { getVaultPath: () => '/fixture' } }, '文章A.md');
  modal.onOpen();
  const revise = modal.contentEl.querySelectorAll('button').find(button => button.textContent === '改稿');
  assert.ok(revise);
  revise.click();
  assert.equal(sideEffects, 0);
  assert.match(modal.contentEl.querySelectorAll('div').map(el => el.textContent).join('\n'), /文章A.md/);
  assert.ok(modal.contentEl.querySelectorAll('button').some(button => /开始写作任务|Start writing task/.test(button.textContent)));
});

test('common writing choices are visible, secondary choices stay folded, and adaptation cannot edit the source', () => {
  const modal = new WritingModal({ app: { workspace: {} }, kernelService: { getVaultPath: () => '/fixture' } }, 'A.md');
  modal.onOpen();
  const more = modal.contentEl.querySelector('details.tm-writing-more');
  assert.equal(more.open, false);
  const wechat = modal.contentEl.querySelectorAll('button').find(button => button.getAttribute('data-writing-action') === 'topmind-wechat-post');
  assert.ok(wechat);
  wechat.click();
  assert.equal(modal.output, 'review');
  assert.equal(modal.contentEl.querySelectorAll('select').length, 0);
  const cover = modal.contentEl.querySelectorAll('button').find(button => button.getAttribute('data-writing-action') === 'topmind-cover');
  cover.click();
  assert.equal(modal.contentEl.querySelector('details.tm-writing-more').open, true);
});

test('writing defaults to the captured active article and keeps it until explicitly changed', () => {
  let current = 'A.md';
  const workspace = { getMostRecentLeaf: () => ({view:{file:{path:current}}}) };
  const modal = new WritingModal({app:{workspace},kernelService:{getVaultPath:()=>'/fixture'}});
  modal.onOpen();
  assert.equal(modal.source,'A.md');
  current='B.md'; modal.render();
  assert.equal(modal.source,'A.md');
  const active = modal.contentEl.querySelectorAll('button').find(b => /使用活跃笔记|Use active note/.test(b.textContent));
  assert.ok(active); active.click(); assert.equal(modal.source,'B.md');
});
test('switching writing and local preview never starts an agent or discards task requirements', () => {
  const modal = new WritingModal({app:{workspace:{}},kernelService:{getVaultPath:()=>'/fixture'}},'A.md');
  modal.onOpen(); modal.requirements='Keep the author voice';
  const preview = modal.contentEl.querySelectorAll('button').find(b => b.getAttribute('role') === 'tab' && /排版预览|Layout preview/.test(b.textContent));
  assert.ok(preview); preview.click();
  assert.equal(modal.tab,'preview');
  assert.ok(modal.contentEl.querySelectorAll('button').some(b => /生成预览|Generate preview/.test(b.textContent)));
  modal.contentEl.querySelectorAll('button').find(b => b.getAttribute('role') === 'tab' && /^(写作|Write)$/.test(b.textContent)).click();
  assert.equal(modal.requirements,'Keep the author voice');
});
