import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
register(new URL('./obsidian-stub-loader.mjs', import.meta.url).href, import.meta.url);
const { KernelService } = await import('../src/services/kernel-service.ts');
const { DEFAULT_SETTINGS } = await import('../src/types.ts');
const awaitKernelForPendingTest = await import('../lib/kernel-api.mjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-service-'));
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'topmind.yaml'), 'contract_version: 4\nwriteback:\n  mode: auto\n');
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.autoSuggest = true;
  const service = new KernelService({ vault: { adapter: { getBasePath: () => root } } }, { manifest: { dir: process.cwd() } }, settings);
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, root, settings };
}

test('suggestion failures remain errors, keep cached cards, coalesce requests and permit retry', async t => {
  const { service } = fixture(t);
  const card = { id: 'cached', kind: 'open_profile', title: 'Keep', summary: 'Keep', impact: 'low' };
  service.suggestionSession = [card];
  let calls = 0;
  service.context = { generateSuggestions: async () => { calls++; throw new Error('offline'); } };
  const results = await Promise.allSettled([service.generateSuggestions({ force: true }), service.generateSuggestions({ force: true })]);
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.status === 'rejected' && /offline/.test(r.reason.message)));
  assert.equal(service.peekSuggestions()[0].id, 'cached');
  service.context = { generateSuggestions: async () => { calls++; return []; } };
  assert.deepEqual(await service.generateSuggestions({ force: true }), []);
  assert.equal(calls, 2);
});

test('changing default model or options invalidates the cached provider context', t => {
  const { service, settings } = fixture(t);
  service.updateSettings(settings);
  service.context = { marker: true };
  settings.ai.defaultModel = 'another-model';
  service.updateSettings(settings);
  assert.equal(service.context, null);
});

test('todo mutations use the real Kernel and report missing or duplicate writes', t => {
  const { service } = fixture(t);
  assert.equal(service.addTodo('  real task 📅 2026-11-01  ').ok, true);
  const [item] = service.readTodos();
  assert.equal(item.text, 'real task');
  assert.equal(item.dueDate, '2026-11-01');
  assert.equal(service.addTodo('real task').ok, false);
  assert.equal(service.toggleTodo(item.id).ok, true);
  assert.equal(service.clearCompletedTodos().ok, true);
  assert.equal(service.readTodos().length, 0);
  assert.equal(service.addTodo('delete me').ok, true);
  assert.equal(service.deleteTodo(service.readTodos()[0].id).ok, true);
  assert.equal(service.readTodos().length, 0);
});

test('todo source paths come from indexed periods, including year subfolders', async t => {
  const { service } = fixture(t);
  service.getStreamContext = async () => ({ periods: [{ period: '2026-W43', relPath: '10-动态/2026/2026-W43.md' }], current: null });
  assert.equal(await service.todoSourcePath('2026-W43'), '10-动态/2026/2026-W43.md');
  assert.equal(await service.todoSourcePath('removed'), null);
});

test('late suggestions from an invalidated model context cannot repopulate the session', async t => {
 const {service,settings}=fixture(t);
 let finish;
 service.updateSettings(settings);
 service.context={generateSuggestions:()=>new Promise(resolve=>{finish=resolve;})};
 const pending=service.generateSuggestions({force:true});
 settings.ai.defaultModel='new-model';
 service.updateSettings(settings);
 finish([{id:'stale',kind:'open_profile',title:'Old model',summary:'Ignore',impact:'low'}]);
 assert.deepEqual(await pending,[]);
 assert.deepEqual(service.peekSuggestions(),[]);
});

test('chat memory proposals survive service reload and a persisted dismissal',async t=>{
 const {service,root,settings}=fixture(t);
 service.app.workspace={getMostRecentLeaf:()=>null};
 let count=0;
 service.context={aiProvider:{generate:async()=>++count===1?JSON.stringify({tool:'propose_memory_change',content:'Prefers concise replies',title:'Preference'}):'Please review the proposal.'}};
 await service.chat('Remember my preference for concise replies',[],{focus:null});
 assert.equal(service.peekSuggestions().length,1);assert.equal(fs.existsSync(path.join(root,'memory/profile.md')),false);
 const reloaded=new KernelService(service.app,{manifest:{dir:process.cwd()}},settings);
 const [card]=reloaded.peekSuggestions();assert.equal(card.payload.entry,'Prefers concise replies');
 reloaded.dropSuggestion(card.id);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'.topmind/chat-proposals.json'),'utf8')),[]);
 reloaded.dispose();
});

test('cancelled operations discard results before the provider consumer or suggestion session sees them',async t=>{
 const {service}=fixture(t);let cancelled=false;let finish;let applied=false;
 service.context={aiProvider:{generate:()=>new Promise(resolve=>{finish=resolve;})},runOperation:async options=>{
  try {await options.aiProvider.generate('prompt');applied=true;return{ok:true,suggestions:[{id:'late',kind:'open_profile',title:'late',summary:'late',impact:'low'}]};}
  catch{return{ok:false,summary:'cancelled'};}
 }};
 const pending=service.runOperation('memory_organize',{shouldAbort:()=>cancelled});
 cancelled=true;finish('late');const result=await pending;
 assert.equal(result.ok,false);assert.equal(applied,false);assert.deepEqual(service.peekSuggestions(),[]);
});

test('confirming a pending action preserves a dirty editor and leaves the action retryable', t => {
 const {service,root}=fixture(t);
 const rel='00-Inbox/pending.md';fs.mkdirSync(path.join(root,'00-Inbox'));fs.writeFileSync(path.join(root,rel),'disk');
 const item=service.listPendingWrites();assert.equal(item.length,0);
 service.app.workspace={getLeavesOfType:()=>[{view:{file:{path:rel},editor:{getValue:()=> 'unsaved'}}}]};
 const kernel=awaitKernelForPendingTest;
 const pending=kernel.stashPendingWrite({workspaceRoot:root,relativePath:rel,toolName:'delete_path'});
 assert.match(service.acceptPendingWrite(pending.id).error,/unsaved-editor-changes/);
 assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),'disk');
 assert.equal(service.listPendingWrites().length,1);
});
