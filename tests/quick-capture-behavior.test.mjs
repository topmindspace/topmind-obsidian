import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
register(new URL('./obsidian-stub-loader.mjs',import.meta.url).href,import.meta.url);
const {QuickCaptureModal}=await import('../src/views/quick-capture-modal.ts');
const {DEFAULT_SETTINGS}=await import('../src/types.ts');
const host=await import('./obsidian-host-stub.mjs');
function fixture(service={}) {
 const modal=new QuickCaptureModal({}, {settings:structuredClone(DEFAULT_SETTINGS),kernelService:service});
 modal.onOpen();return modal;
}
const type=(modal,value)=>{modal.textarea.value=value;modal.textarea.dispatchEvent({type:'input'});};

test('empty capture stays open, labels name native controls, and a failed write preserves input',()=>{
 const modal=fixture({capture:()=>({ok:false})});let closed=0;modal.close=()=>{closed++;};
 assert.equal(modal.submitBtn.disabled,true);modal.submit();assert.equal(closed,0);
 assert.ok(modal.textarea.getAttribute('aria-label'));
 assert.equal(modal.contentEl.querySelectorAll('label').length,2);
 type(modal,'keep this draft');modal.submit();
 assert.equal(modal.textarea.value,'keep this draft');assert.equal(modal.textarea.disabled,false);assert.equal(modal.submitBtn.disabled,false);
});

test('URL auto-routing resets for plain text and never overrides a manual destination',()=>{
 const modal=fixture();type(modal,'https://example.com');assert.equal(modal.targetSelect.value,'inbox');
 type(modal,'plain note');assert.equal(modal.targetSelect.value,'stream');
 modal.targetSelect.value='stream';modal.targetSelect.dispatchEvent({type:'change'});
 type(modal,'https://example.com');assert.equal(modal.targetSelect.value,'stream');
});

test('fetch blocks duplicate submit and closing prevents a late page response from being captured',async()=>{
 let finish,writes=0;
 const modal=fixture({fetchUrlForCapture:()=>new Promise(resolve=>{finish=resolve;}),capture:()=>{writes++;return{ok:true};},buildFetchMarkdown:()=> 'article'});
 type(modal,'https://example.com');
 const button=modal.urlHintEl.querySelector('button');const fetching=modal.fetchUrlToInbox(button);
 assert.equal(modal.textarea.disabled,true);assert.equal(modal.targetSelect.disabled,true);assert.equal(modal.submitBtn.disabled,true);
 modal.submit();assert.equal(writes,0);
 modal.onClose();finish({ok:true});await fetching;assert.equal(writes,0);
});
