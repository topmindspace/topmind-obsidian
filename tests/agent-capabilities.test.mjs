import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as kernel from '../lib/kernel-api.mjs';
import { runWorkspaceChatTurn } from '../src/services/chat-agent.ts';
import { appendStreamEntryToWorkspace } from '../src/services/kernel-workspace-ops.ts';
import { runAgentTool } from '../src/services/workspace-agent-tools.ts';
import { createChatMemoryProposal } from '../src/services/chat-memory-proposal.ts';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-capability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'topmind.yaml'), 'contract_version: 4\nwriteback:\n  mode: auto\n');
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(root, '00-Inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, '00-Inbox/note.md'), '# A\n\noriginal\n');
  return { root, ctx: { kernel, workspaceRoot: root, engineRoot: root, actor: 'ai', writebackMode: 'auto' } };
}
async function turn(root, call, options = {}) {
  let index = 0;
  const prompts = [];
  const result = await runWorkspaceChatTurn(kernel, root, { userMessage: '请修改指定的工作区内容', maxSteps: 3, autoContinue: false, generate: async prompt => { prompts.push(prompt); return index++ === 0 ? JSON.stringify(call) : '检查结果如上。'; }, ...options });
  return { result, prompts };
}
test('unqualified read binds to the frozen object, and dirty editors reject alias writes', async t => {
  const { root } = fixture(t);
  const read = await turn(root, { tool: 'read_file' }, { focus: { path: '00-Inbox/note.md' } });
  assert.match(read.prompts[1], /original/);
  const blocked = await turn(root, { tool: 'save_note', relativePath: '00-Inbox/note.md', content: 'overwritten' }, { focus: { path: '00-Inbox/note.md', unsaved: true } });
  assert.match(blocked.prompts[1], /unsaved-editor-changes/);
  assert.match(fs.readFileSync(path.join(root, '00-Inbox/note.md'), 'utf8'), /original/);
});
test('save_note alias cannot bypass the protected memory plane', async t => {
  const { root } = fixture(t);
  const { prompts } = await turn(root, { tool: 'save_note', relativePath: 'memory/profile.md', content: 'overwrite' });
  assert.match(prompts[1], /write-blocked:memory-plane/);
  assert.equal(fs.existsSync(path.join(root, 'memory/profile.md')), false);
});
test('chat memory proposals create reviewable Kernel-compatible cards without writing memory', async t => {
  const { root } = fixture(t);
  let card;
  const { result, prompts } = await turn(root, { tool: 'propose_memory_change', content: 'Prefers concise replies', title: 'Preference' }, { onMemoryProposal: call => { card = createChatMemoryProposal(call, 'memory/profile.md'); return { id: card.id, targetPath: card.targetPath }; } });
  assert.equal(card.kind, 'promote_memory');
  assert.equal(card.payload.action, 'append_profile');
  assert.equal(card.payload.entry, 'Prefers concise replies');
  assert.match(prompts[1], /wroteFiles.*false/);
  assert.equal(result.toolCalls[0].needsConfirm, true);
  assert.equal(result.goal.status, "blocked");
  assert.equal(result.goal.blockReason, "awaiting_confirmation");
  assert.match(result.body, /待确认|Awaiting confirmation/);
  assert.equal(fs.existsSync(path.join(root, 'memory/profile.md')), false);
  assert.throws(() => createChatMemoryProposal({ action: 'update_profile', content: 'x' }, 'memory/profile.md'), /match/);
});
test('todo edit, due date and delete tools execute through the real Kernel and preserve dates', async t => {
  const { ctx } = fixture(t);
  await runAgentTool(ctx, { tool: 'add_todo', text: 'old task', dueDate: '2026-11-01' });
  let [item] = kernel.readTodoList(ctx.workspaceRoot).items;
  assert.equal((await runAgentTool(ctx, { tool: 'update_todo', id: item.id, newText: 'new task' })).ok, true);
  [item] = kernel.readTodoList(ctx.workspaceRoot).items;
  assert.equal(item.text, 'new task');
  assert.equal(item.dueDate, '2026-11-01');
  assert.equal((await runAgentTool(ctx, { tool: 'set_todo_due', id: item.id, dueDate: null })).ok, true);
  assert.equal(kernel.readTodoList(ctx.workspaceRoot).items[0].dueDate, undefined);
  assert.equal((await runAgentTool(ctx, { tool: 'delete_todo', id: 'missing' })).ok, false);
  assert.equal((await runAgentTool(ctx, { tool: 'delete_todo', id: item.id })).ok, true);
  assert.equal(kernel.readTodoList(ctx.workspaceRoot).items.length, 0);
});
test('append tool lands a real change and rejects paths outside the vault', async t => {
  const { root } = fixture(t);
  const { result } = await turn(root, { tool: 'append_stream_entry', relativePath: '00-Inbox/note.md', content: 'follow-up' });
  assert.equal(result.toolCalls[0].ok, true);
  assert.match(fs.readFileSync(path.join(root, '00-Inbox/note.md'), 'utf8'), /follow-up/);
  assert.equal(appendStreamEntryToWorkspace(kernel, root, undefined, { relativePath: '../outside.md', content: 'x' }).ok, false);
});
test('read-only todo discovery does not create a todo file', async t => {
  const { root, ctx } = fixture(t);
  assert.equal((await runAgentTool(ctx, { tool: 'list_todos' })).ok, true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'memory')), []);
});

test('a failed move destination never removes the original note', async t => {
  const { root, ctx } = fixture(t);
  const denied = { ...ctx, kernel: { ...kernel, executeWrite: () => ({ wroteFiles: false, operation: 'skip' }) } };
  const moved = await runAgentTool(denied, { tool: 'move_to_topic', relativePath: '00-Inbox/note.md', targetTopicId: '20-专题/topic' });
  assert.equal(moved.ok, false);
  assert.match(fs.readFileSync(path.join(root, '00-Inbox/note.md'), 'utf8'), /original/);
});

test('move destinations and new-file parents cannot escape through symlinks', async t => {
  const { root, ctx } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-capability-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  for (const call of [
    { tool: 'save_file', relativePath: 'escape/new-dir/leak.md', content: 'body' },
    { tool: 'move_to_topic', relativePath: '00-Inbox/note.md', targetTopicId: 'escape/topic' },
    { tool: 'create_topic', category: 'escape/new-dir', name: 'unsafe' },
  ]) assert.equal((await runAgentTool(ctx, call)).ok, false, call.tool);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(root, '00-Inbox/note.md')), true);
});

test('publish refuses to overwrite a previous delivery snapshot', async t => {
  const { root, ctx } = fixture(t);
  const first = await runAgentTool(ctx, { tool: 'publish_to_outputs', relativePath: '00-Inbox/note.md' });
  assert.equal(first.ok, true);
  fs.writeFileSync(path.join(root, '00-Inbox/note.md'), 'replacement');
  const second = await runAgentTool(ctx, { tool: 'publish_to_outputs', relativePath: '00-Inbox/note.md' });
  assert.equal(second.ok, false);
  assert.match(fs.readFileSync(path.join(root, first.relativePath), 'utf8'), /original/);
});

test('the proposal card applies through the existing Kernel confirmation path', async t => {
  const { root } = fixture(t);
  const card=createChatMemoryProposal({content:'Prefers concise and concrete replies',title:'Preference'},'memory/profile.md');
  assert.equal(fs.existsSync(path.join(root,'memory/profile.md')),false);
  const context=kernel.createKernelContext({workspaceRoot:root,engineRoot:process.cwd()});
  const applied=await context.applySuggestion(card,{localeOverride:'en-US'});
  assert.notEqual(applied.wroteFiles,false,JSON.stringify(applied));
  assert.match(fs.readFileSync(path.join(root,'memory/profile.md'),'utf8'),/Prefers concise and concrete replies/);
});

test('in-vault memory aliases and case variants cannot bypass the proposal fence', async t => {
 const {root}=fixture(t);
 fs.symlinkSync(path.join(root,'memory'),path.join(root,'memory-alias'));
 for(const relativePath of ['memory-alias/new-profile.md','Memory/profile.md']) {
  const {prompts}=await turn(root,{tool:'save_note',relativePath,content:'should require a memory proposal'});
  assert.match(prompts[1],/write-blocked:memory-plane/);
 }
 assert.deepEqual(fs.readdirSync(path.join(root,'memory')),[]);
});

test('read-only lookup turns reject attempted writes at execution, not just in the prompt',async t=>{
 const {root}=fixture(t);let calls=0;
 const result=await runWorkspaceChatTurn(kernel,root,{userMessage:'What are my current todos?',maxSteps:2,autoContinue:false,generate:async()=>++calls===1?JSON.stringify({tool:'save_file',relativePath:'00-Inbox/rogue.md',content:'no'}):'No tasks.'});
 assert.equal(fs.existsSync(path.join(root,'00-Inbox/rogue.md')),false);assert.equal(result.toolCalls[0].ok,false);
});

test('a write guard failure is returned to the model without executing the mutation',async t=>{
 const {root}=fixture(t);
 const {prompts}=await turn(root,{tool:'save_file',relativePath:'00-Inbox/note.md',content:'overwritten'},{beforeWrite:()=> 'unsaved-editor-changes:00-Inbox/note.md'});
 assert.match(prompts[1],/unsaved-editor-changes/);assert.match(fs.readFileSync(path.join(root,'00-Inbox/note.md'),'utf8'),/original/);
});

test('canonical Desktop parameter names execute consistently in Obsidian',async t=>{
 const {root,ctx}=fixture(t);
 const batch=await runAgentTool(ctx,{tool:'add_todo',items:['first task','second task']});assert.equal(batch.count,2);
 assert.equal((await runAgentTool(ctx,{tool:'toggle_todo',idOrText:'first task',completed:true})).ok,true);
 await runAgentTool(ctx,{tool:'toggle_todo',idOrText:'first task',completed:true});
 assert.equal(kernel.readTodoList(root).items.find(item=>item.text==='first task').done,true);
 assert.equal((await runAgentTool(ctx,{tool:'save_note',topicId:'20-专题/demo',filename:'note.md',content:'topic note'})).ok,true);
 assert.equal((await runAgentTool(ctx,{tool:'rename_path',relativePath:'20-专题/demo/note.md',newName:'renamed.md'})).ok,true);
 assert.equal(fs.existsSync(path.join(root,'20-专题/demo/renamed.md')),true);
 const found=await runAgentTool(ctx,{tool:'glob_files',pattern:'**/*.md',scope:'20-专题',maxResults:1});
 assert.deepEqual(found.files,['20-专题/demo/renamed.md']);
});

test('a pending delete can be reviewed and confirmed through the shared queue',async t=>{
 const {root,ctx}=fixture(t);
 const result=await runAgentTool({...ctx,writebackMode:'confirm'},{tool:'delete_path',relativePath:'00-Inbox/note.md'});
 assert.equal(result.pending,true);assert.ok(result.pendingId);assert.equal(fs.existsSync(path.join(root,'00-Inbox/note.md')),true);
 assert.equal(kernel.listPendingWrites(root)[0].operation,'delete');
 assert.equal(kernel.acceptPendingWrite(root,result.pendingId).ok,true);assert.equal(fs.existsSync(path.join(root,'00-Inbox/note.md')),false);
});

test('a long summary request returns after read evidence without automatic task continuation', async t => {
 const {root}=fixture(t);
 fs.writeFileSync(path.join(root,'00-Inbox/summary.md'),'# Current note\n\nSummary evidence.');
 let requests=0;
 const turn=await runWorkspaceChatTurn(kernel,root,{
  userMessage:'验证当前对象：总结当前笔记，并给出实际文件路径',
  focus:{path:'00-Inbox/summary.md'},
  generate:async()=>++requests===1 ? JSON.stringify({tool:'read_file'}) : '当前笔记描述了 Summary evidence，路径为 00-Inbox/summary.md。',
 });
 assert.equal(requests,2);assert.equal(turn.autoContinues,0);assert.equal(turn.goal.status,'done');
});
