import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
register(new URL('./obsidian-stub-loader.mjs',import.meta.url).href,import.meta.url);
const {ChatController}=await import('../src/services/chat-session.ts');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(t,chat=async()=>({content:'answer'})){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tm-chat-session-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const create=(generator=chat)=>new ChatController({root:()=>root,chat:generator,copy:()=>({paused:'paused',stopped:'stopped',error:'error'})});
 const controller=create();controller.load();return{root,create,controller,file:path.join(root,'.topmind/chat-session.json')};
}
test('chat persists one versioned record and drops transient editor buffers',async t=>{
 const {controller,create,file}=fixture(t);
 await controller.send('prompt',{path:'a.md',selection:'selected',editorText:'do not persist'});
 const restored=create();restored.load();
 assert.equal(restored.messages.length,2);assert.equal(restored.messages[1].focus.path,'a.md');
 assert.doesNotMatch(fs.readFileSync(file,'utf8'),/do not persist|editorText/);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).version,1);
});
test('a checkpoint survives close while the provider is still pending',async t=>{
 const result=deferred();let options;
 const {controller,create}=fixture(t,async(_prompt,_history,opts)=>{options=opts;return result.promise;});
 const running=controller.send('continue editing',{path:'a.md'});
 options.onProgress({kind:'checkpoint',step:1,maxSteps:32,goal:{goal:'continue editing',pathReceipts:['a.md'],plan:['done','remaining'],openCriteria:['remaining'],status:'working'}});
 controller.close();
 const restored=create();restored.load();
 assert.equal(restored.paused,true);assert.equal(restored.focus.path,'a.md');assert.deepEqual(restored.goal.pathReceipts,['a.md']);
 assert.equal(options.shouldAbort(),true);
 result.resolve({content:'paused',stopReason:'paused'});await running;
});
test('a late response cannot overwrite a newer run or revive a cleared conversation',async t=>{
 const oldResult=deferred();let oldOptions;
 const {controller,create,file}=fixture(t,async(_p,_h,opts)=>{oldOptions=opts;return oldResult.promise;});
 const running=controller.send('old',{path:'old.md'});controller.close();
 const next=create(async()=>({content:'new answer'}));next.load();await next.send('new',{path:'new.md'});
 assert.equal(oldOptions.shouldAbort(),true);
 oldResult.resolve({content:'late old answer'});await running;
 let saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(saved.messages.at(-1).content,'new answer');
 next.clear();saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(saved.messages,[]);
});
test('retry uses the final user turn and keeps the original object',async t=>{
 const calls=[];const{controller}=fixture(t,async(prompt,history,opts)=>{calls.push({prompt,history,focus:opts.focus});return{content:'reply'};});
 await controller.send('first',{path:'first.md'});await controller.send('last',{path:'last.md'});
 await controller.send('last',null,{retry:true});
 assert.equal(calls[2].history.length,2);assert.equal(calls[2].focus.path,'last.md');assert.equal(controller.messages.length,4);
 await assert.rejects(controller.send('first',null,{retry:true}),/last-turn/);
});
test('legacy history is imported without rewriting its original files',async t=>{
 const{root,create,file}=fixture(t);fs.mkdirSync(path.join(root,'.topmind'));
 const legacy=path.join(root,'.topmind/chat-history.json');const bytes=JSON.stringify([{role:'user',content:'legacy'}]);fs.writeFileSync(legacy,bytes);
 fs.writeFileSync(path.join(root,'.topmind/chat-goal.json'),JSON.stringify({goal:'legacy',pathReceipts:['a.md']}));
 const controller=create();controller.load();assert.equal(controller.messages.length,1);assert.equal(fs.existsSync(file),false);
 await controller.send('new',null);assert.equal(fs.readFileSync(legacy,'utf8'),bytes);assert.equal(fs.existsSync(file),true);
});
test('damaged session state blocks sends and preserves original data',async t=>{
 let calls=0;const{root,create,file}=fixture(t,async()=>{calls++;return{content:'no'};});fs.mkdirSync(path.join(root,'.topmind'));
 for(const bytes of ['{broken',JSON.stringify({version:1,messages:[{role:'assistant',content:'x',reasoning:{bad:true}}],goal:null,run:null})]){
  fs.writeFileSync(file,bytes);const controller=create();controller.load();assert.ok(controller.storageError);
  await assert.rejects(controller.send('new',null));assert.equal(fs.readFileSync(file,'utf8'),bytes);
 }
 assert.equal(calls,0);
});
test('initial persistence failure is visible and never starts the provider',async t=>{
 let calls=0;const{root,controller}=fixture(t,async()=>{calls++;return{content:'no'};});fs.writeFileSync(path.join(root,'.topmind'),'blocked');
 await assert.rejects(controller.send('prompt',null));assert.ok(controller.storageError);assert.equal(calls,0);assert.equal(controller.thinking,false);
});

test('model context compression never truncates durable conversation history', async t => {
 const {controller,create,file}=fixture(t);
 const content='中文稿件。'.repeat(3000);
 controller.messages=Array.from({length:80},(_,i)=>({role:i%2?'assistant':'user',content:`${i}: ${content}`}));
 controller.save();
 const restored=create();restored.load();
 assert.equal(restored.messages.length,80);
 assert.equal(restored.messages[0].content,controller.messages[0].content);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).messages[79].content,controller.messages[79].content);
});
