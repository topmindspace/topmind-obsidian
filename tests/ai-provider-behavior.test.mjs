import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
register(new URL('./obsidian-stub-loader.mjs', import.meta.url).href, import.meta.url);
const host = await import('./obsidian-host-stub.mjs');
const { createAiProvider } = await import('../src/bridge/ai-provider.ts');
const { DEFAULT_SETTINGS } = await import('../src/types.ts');
const { setLocale, t } = await import('../src/i18n/index.ts');
function provider(id='custom') {
 const settings=structuredClone(DEFAULT_SETTINGS);
 settings.ai.sourcePreference=id;
 settings.ai.defaultModel='test-model';
 if(id==='custom') {settings.ai.manual.customBaseUrl='https://invalid.local/v1'; settings.ai.manual.customKey='test-only';}
 if(id==='anthropic') settings.ai.manual.anthropicKey='test-only';
 return createAiProvider(settings);
}
test('Anthropic text blocks are concatenated instead of silently losing earlier paragraphs', async () => {
 host.setRequestUrlHandler(async () => ({status:200,json:{content:[{type:'text',text:'first paragraph\n'},{type:'text',text:'second paragraph'}]}}));
 assert.equal(await provider('anthropic').generate('test'), 'first paragraph\nsecond paragraph');
});
test('provider request rejection clears cancellation polling without an unhandled promise', async () => {
 const originalSet=window.setInterval;
 const originalClear=window.clearInterval;
 const active=new Set();
 const unhandled=[];
 const onUnhandled=e=>unhandled.push(e);
 window.setInterval=(fn,delay)=>{const id=originalSet(fn,delay);active.add(id);return id;};
 window.clearInterval=id=>{active.delete(id);originalClear(id);};
 process.on('unhandledRejection',onUnhandled);
 const originalError=console.error;
 console.error=()=>{};
 try {
  host.setRequestUrlHandler(async () => {throw new Error('permanent failure');});
  await assert.rejects(provider().generate('test',{operation:'chat',shouldAbort:()=>false}), /permanent failure/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(active.size,0);
  assert.deepEqual(unhandled,[]);
 } finally {
  window.setInterval=originalSet;window.clearInterval=originalClear;
  process.off('unhandledRejection',onUnhandled);console.error=originalError;
 }
});
test('current object and selected text labels interpolate correctly in both languages', () => {
 for(const locale of ['zh-CN','en-US']) {
  setLocale(locale);
  assert.ok(t('chat_context_selection',{count:14}).includes('14'));
  assert.ok(t('chat_context_current_object',{path:'note.md'}).includes('note.md'));
  assert.doesNotMatch(t('chat_context_selection',{count:14}), /[{}]/u);
 }
});

test('credential echoes are redacted from surfaced provider failures', async () => {
 const original=console.error; console.error=()=>{};
 try {
  host.setRequestUrlHandler(async () => {throw new Error('request rejected: Bearer test-only');});
  await assert.rejects(provider().generate('test'),err=>/\[redacted\]/u.test(err.message)&&!err.message.includes('test-only'));
 } finally {console.error=original;}
});
