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
  assert.match(modal.contentEl.querySelectorAll('p').map(p => p.textContent).join('\n'), /文章A.md/);
  assert.ok(modal.contentEl.querySelectorAll('button').some(button => /开始 AI 任务|Start AI task/.test(button.textContent)));
});
