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

test("the compatibility loop returns a code example without invoking its tool", async t => {
  const { root } = fixture(t);
  const example = 'A request for the todo tool looks like this:\n\n```json\n{"tool":"list_todos"}\n```';
  let requests = 0;
  const result = await runWorkspaceChatTurn(kernel, root, {
    userMessage: "Show an example of a todo request.", autoContinue: false,
    generate: async () => { requests++; return example; },
  });
  assert.equal(requests, 1);
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.body, example);
});

test("empty and reasoning-only replies consume the same bounded retry budget", async t => {
  const { root } = fixture(t);
  let requests = 0;
  const result = await runWorkspaceChatTurn(kernel, root, {
    userMessage: "Summarize this note.", locale: "en", focus: { path: "00-Inbox/note.md" },
    generate: async () => ++requests === 1 ? "" : "<think>working</think>",
  });
  assert.equal(requests, 2);
  assert.equal(result.goal.status, "incomplete");
  assert.match(result.body, /no usable reply twice/);
  assert.deepEqual(result.goal.modifiedPaths, []);
});

test("the real skill tools resolve explicit and pack-relative writing resources with a bounded response", async t => {
  const { ctx } = fixture(t);
  const resource = (path, skillId) => runAgentTool(ctx, { tool: "load_skill_resource", path, skillId });
  const relative = await resource("references/workspace.md", "topmind-wechat-post");
  assert.equal(relative.ok, true);
  assert.match(relative.content, /源稿/u);
  assert.deepEqual(await resource("topmind-wechat-post/references/workspace.md"), relative);
  assert.deepEqual(await resource("topmind-wechat-post/references/workspace.md", "topmind-wechat-post"), relative);
  const shared = await resource("shared/capability-degradation.md", "topmind");
  assert.equal(shared.ok, true);
  assert.deepEqual(await resource("../shared/capability-degradation.md", "topmind"), shared);
  assert.equal((await resource("../../outside.md", "topmind-wechat-post")).ok, false);
  assert.equal((await resource("constructor")).ok, false);
  assert.equal((await resource("references/workspace.md", "topmind")).ok, false);
  const runtime = await resource("runtime/article-renderer.mjs", "topmind-wechat-post");
  assert.equal(runtime.ok, true);
  assert.equal(runtime.truncated, true);
  assert.ok(runtime.content.length < 12100);
  const loaded = await runAgentTool(ctx, { tool: "load_skill", skillId: "topmind-wechat-post" });
  assert.match(loaded.content, /^# Topmind 内置写作能力/u);
  assert.match(loaded.content, /name: topmind-wechat-post/u);
});
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
  assert.equal(prompts.length, 1, 'a staged suggestion ends the agent run');
  assert.deepEqual(result.goal.modifiedPaths, []);
  assert.equal(result.toolCalls[0].needsConfirm, true);
  assert.equal(result.goal.status, "blocked");
  assert.equal(result.goal.blockReason, "awaiting_confirmation");
  assert.match(result.body, /待确认|Awaiting confirmation/);
  assert.equal(fs.existsSync(path.join(root, 'memory/profile.md')), false);
  assert.throws(() => createChatMemoryProposal({ action: 'update_profile', content: 'x' }, 'memory/profile.md'), /match/);
});
test('a pending deletion stops the agent and preserves prior real changes', async t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'topmind.yaml'), 'contract_version: 4\nwriteback:\n  mode: confirm\n');
  const removed = '00-Inbox/note.md';
  const created = '00-Inbox/delivery.md';
  const script = [
    { tool: 'save_file', relativePath: created, content: 'Deliverable.' },
    { tool: 'delete_path', relativePath: removed },
  ];
  let requests = 0;
  const result = await runWorkspaceChatTurn(kernel, root, {
    userMessage: 'Save a deliverable, then delete the old note.', locale: 'en',
    generate: async () => JSON.stringify(script[requests++]),
  });
  assert.equal(result.goal.status, 'blocked');
  assert.equal(result.goal.blockReason, 'awaiting_confirmation');
  assert.deepEqual(result.goal.modifiedPaths, [created]);
  assert.equal(requests, 2);
  assert.equal(fs.readFileSync(path.join(root, created), 'utf8'), 'Deliverable.');
  assert.ok(fs.existsSync(path.join(root, removed)));
  assert.deepEqual(kernel.listPendingWrites(root).map(item => item.relativePath), [removed]);
  const waiting = await runWorkspaceChatTurn(kernel, root, { userMessage: '继续', priorGoal: result.goal,
    generate: async () => assert.fail('a pending review must stop before the model') });
  assert.equal(waiting.goal.blockReason, 'awaiting_confirmation');
  assert.equal(kernel.acceptPendingWrite(root, kernel.listPendingWrites(root)[0].id).ok, true);
  fs.writeFileSync(path.join(root, removed), 'A new note at the same path.');
  let resumeStep = 0;
  const resumed = await runWorkspaceChatTurn(kernel, root, { userMessage: '继续', locale: 'en', priorGoal: waiting.goal,
    generate: async () => resumeStep++ === 0 ? JSON.stringify({ tool: 'delete_path', relativePath: removed }) : 'Reviewed deletion completed. [DONE]' });
  assert.equal(resumed.goal.status, 'done', resumed.body);
  assert.deepEqual(resumed.goal.modifiedPaths, []);
  assert.equal(fs.readFileSync(path.join(root, removed), 'utf8'), 'A new note at the same path.');
  assert.deepEqual(kernel.listPendingWrites(root), []);
});

test('an explicit profile fact is saved directly, deduplicated and protected from a dirty editor', async t => {
  const { root } = fixture(t);
  const generate = async () => assert.fail('literal profile changes need no model');
  const remember = (userMessage, options = {}) => runWorkspaceChatTurn(kernel, root, { userMessage, generate, ...options });
  const added = await remember('记住：我偏好深色界面');
  const profile = path.join(root, 'memory/profile.md');
  const saved = fs.readFileSync(profile, 'utf8');
  assert.equal(added.goal.status, 'done');
  assert.deepEqual(added.goal.modifiedPaths, ['memory/profile.md']);
  assert.match(saved, /我偏好深色界面/u);
  const duplicate = await remember('记住：我偏好深色界面');
  assert.equal(duplicate.goal.status, 'done');
  assert.deepEqual(duplicate.goal.modifiedPaths, []);
  assert.equal(fs.readFileSync(profile, 'utf8'), saved);
  const dirty = await remember('Remember that I read long articles on Sundays.', { beforeWrite: files => {
    assert.deepEqual(files, ['memory/profile.md']);
    return 'unsaved-editor-changes';
  } });
  assert.equal(dirty.goal.status, 'incomplete');
  assert.equal(fs.readFileSync(profile, 'utf8'), saved);
  const fuzzy = await remember('更新我的情况：把「深色界面」改成「我偏好浅色界面」');
  assert.equal(fuzzy.goal.status, 'incomplete');
  assert.equal(fs.readFileSync(profile, 'utf8'), saved);
  const exact = await remember('更新我的情况：把「我偏好深色界面」改成「我偏好浅色界面」');
  assert.equal(exact.goal.status, 'done');
  assert.match(kernel.readProfileActiveBody(root), /我偏好浅色界面/u);
  assert.doesNotMatch(kernel.readProfileActiveBody(root), /我偏好深色界面/u);
});

test('one successful write does not hide an independent failed write', async t => {
  const { root } = fixture(t);
  let step = 0;
  const script = [
    JSON.stringify({ tool: 'save_file', relativePath: '00-Inbox/result.md', content: 'Result.' }),
    JSON.stringify({ tool: 'edit_file', relativePath: '00-Inbox/note.md', oldText: 'missing', newText: 'replacement' }),
    'All files finished. [DONE]',
  ];
  const result = await runWorkspaceChatTurn(kernel, root, {
    userMessage: 'Save the result and replace text in the other file.', generate: async () => script[step++],
  });
  assert.equal(result.goal.status, 'incomplete');
  assert.equal(result.goal.blockReason, 'partial-write');
  assert.deepEqual(result.goal.modifiedPaths, ['00-Inbox/result.md']);
  assert.match(fs.readFileSync(path.join(root, '00-Inbox/note.md'), 'utf8'), /original/);
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

test('publish does not clone creation identity into a second Markdown note', async t => {
  const { root, ctx } = fixture(t);
  const source = path.join(root, '00-Inbox/note.md');
  fs.writeFileSync(source, '---\ncreation_id: 426ca86c-eabc-4cb1-86d2-9a59437fb532\n---\n\n# Original\n');
  const result = await runAgentTool(ctx, { tool: 'publish_to_outputs', relativePath: '00-Inbox/note.md' });
  assert.equal(result.ok, false);
  assert.match(result.error, /creation-metadata-copy-blocked/);
  assert.equal(fs.readFileSync(source, 'utf8').includes('creation_id:'), true);
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

test('read-only lookup rejects an attempted write and still returns the supported answer', async t => {
  const { root } = fixture(t);
  const todoFile = path.join(root, 'memory/todo.md');
  const source = '# Todos\n\n- [ ] Review the index.\n';
  fs.writeFileSync(todoFile, source);
  const script = [
    JSON.stringify({ tool: 'save_file', relativePath: '00-Inbox/rogue.md', content: 'Unrequested write.' }),
    JSON.stringify({ tool: 'list_todos' }),
    'Review the index. Source: memory/todo.md.',
  ];
  const result = await runWorkspaceChatTurn(kernel, root, {
    userMessage: 'What are my current todos?', maxSteps: 3, autoContinue: false,
    generate: async () => script.shift(),
  });
  assert.equal(fs.existsSync(path.join(root, '00-Inbox/rogue.md')), false);
  assert.equal(fs.readFileSync(todoFile, 'utf8'), source);
  assert.deepEqual(result.toolCalls.map(call => [call.tool, call.ok]), [['save_file', false], ['list_todos', true]]);
  assert.equal(result.body, 'Review the index. Source: memory/todo.md.');
  assert.deepEqual(result.goal.modifiedPaths, []);
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
