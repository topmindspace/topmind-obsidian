import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
register(new URL('./obsidian-stub-loader.mjs', import.meta.url).href, import.meta.url);
const { TFile } = await import('./obsidian-host-stub.mjs');
const { openCreatedMarkdownNote } = await import('../src/services/view-openers.ts');

test('a newly created note opens in a new main tab and is revealed', async () => {
  const file = new TFile(); file.path = '00-Inbox/Untitled.md';
  const calls = [];
  const leaf = { openFile: async target => { calls.push(['open', target]); } };
  const app = {
    vault: { getAbstractFileByPath: path => path === file.path ? file : null },
    workspace: {
      getLeaf: fresh => { calls.push(['leaf', fresh]); return leaf; },
      revealLeaf: async target => { calls.push(['reveal', target]); },
    },
  };
  await openCreatedMarkdownNote(app, file.path);
  assert.deepEqual(calls, [['leaf', true], ['open', file], ['reveal', leaf]]);
});

test('opening waits for Obsidian to index a Kernel-created note', async () => {
  const file = new TFile(); file.path = '00-Inbox/Just-created.md';
  let indexed = null, listener, unsubscribed = false, opened = false;
  const app = {
    vault: {
      getAbstractFileByPath: () => indexed,
      on: (kind, cb) => { assert.equal(kind, 'create'); listener = cb; return {}; },
      offref: () => { unsubscribed = true; },
    },
    workspace: {
      getLeaf: fresh => { assert.equal(fresh, true); return { openFile: async target => { opened = target === file; } }; },
      revealLeaf: async () => {},
    },
  };
  const opening = openCreatedMarkdownNote(app, file.path);
  indexed = file; listener(file);
  await opening;
  assert.equal(opened, true);
  assert.equal(unsubscribed, true);
});
