// Isolated desktop-host smoke: fresh userData + Vault + local model server.
// Requires an existing Obsidian executable and optional external Playwright installation.
// It never loads the user's configured Vault or credentials; temporary evidence is retained.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const os = require('node:os');
const net = require('node:net');
const options = new Map();
for (let i=2;i<process.argv.length;i+=2) {
 if (!['--obsidian','--playwright'].includes(process.argv[i]) || !process.argv[i+1]) throw new Error('Usage: node scripts/smoke-obsidian.cjs --obsidian <executable> [--playwright <module-resolution-root>]');
 options.set(process.argv[i],process.argv[i+1]);
}
const executable=options.get('--obsidian');
if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('--obsidian must name an existing absolute executable path');
const lookup=options.get('--playwright');
if (lookup && (!path.isAbsolute(lookup) || !fs.existsSync(lookup))) throw new Error('--playwright must name an existing absolute module-resolution root');
const {chromium}=lookup ? createRequire(path.join(lookup,'package.json'))('playwright') : require('playwright');
const repo=path.resolve(__dirname,'..');
const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'topmind-obsidian-smoke-'));
const artifacts=path.join(isolated,'artifacts');fs.mkdirSync(artifacts);

const vault = path.join(isolated, 'test-vault');
const pluginDir = path.join(vault, '.obsidian/plugins/topmind-stream');
fs.mkdirSync(pluginDir, { recursive: true });
fs.cpSync(path.join(repo, 'dist'), pluginDir, { recursive: true });
fs.writeFileSync(path.join(vault, 'topmind.yaml'), 'contract_version: 4\nwriteback:\n  mode: auto\n');
fs.mkdirSync(path.join(vault, '00-Inbox'), { recursive: true });
fs.writeFileSync(path.join(vault, '00-Inbox/Focus-A.md'), '# Focus A\n\nCurrent object test selection.\n');
fs.writeFileSync(path.join(vault, '00-Inbox/Focus-B.md'), '# Focus B\n\nOther object.\n');
const longPath = '00-Inbox/Long-article.md';
const longOriginal = '# Offline index\n\n> “Search stays on this device.”\n\nThe vendor measured 0.3 seconds on 10,000 notes.\n\n'
  + 'An untouched body paragraph keeps its wording and reference.\n\n'.repeat(290)
  + '![Index diagram](missing-index.png)\n\nDraft closing sentence.\n';
fs.writeFileSync(path.join(vault, longPath), longOriginal);
fs.mkdirSync(path.join(vault,'.topmind'),{recursive:true});
fs.writeFileSync(path.join(vault,'00-Inbox/Pending-delete.md'),'delete only after explicit confirm');
fs.writeFileSync(path.join(vault,'.topmind/pending-writes.json'),JSON.stringify({items:[{id:'ui-delete',relativePath:'00-Inbox/Pending-delete.md',content:'delete only after explicit confirm',toolName:'delete_path',operation:'delete',createdAt:new Date().toISOString()}]}));
let port;
(async () => {
 let firstRequest;
 const firstSeen = new Promise(resolve => { firstRequest = resolve; });
 const requests = [];
 const scriptedReplies = [];
 let quickTests=0;
 const server = http.createServer((req,res) => {
  if(req.method!=='POST') {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'isolated-mock'}]}));return;}
  let raw=''; req.on('data',d=>raw+=d); req.on('end',()=>{
   const body=JSON.parse(raw);
   if (body.messages?.some(message=>String(message.content).includes('Reply with: OK'))) {
    quickTests++;setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'OK'}}]}));},150);return;
   }
   requests.push(body);
   const reply=scriptedReplies.shift();
   const content=reply !== undefined ? (typeof reply==='string' ? reply : JSON.stringify(reply))
    : requests.length===1 ? JSON.stringify({tool:'read_file'}) : '当前对象是 Focus A，内容为 Current object test selection。路径：00-Inbox/Focus-A.md';
   if(requests.length===1) firstRequest();
   setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({choices:[{message:{role:'assistant',content}}]}));},requests.length===1?1000:0);
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const apiPort=server.address().port;
 const reservation=net.createServer();
 await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
 port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child = spawn(executable, [`--user-data-dir=${isolated}`, `--remote-debugging-port=${port}`], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
 child.stderr.on('data', d => fs.appendFileSync(path.join(artifacts,'stderr.log'), d));
 let browser;
 let testPage;
 try {
  for(let i=0; i<40; i++) { try { const r=await fetch(`http://127.0.0.1:${port}/json/version`); if(r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
  const context=browser.contexts()[0];
  const starter=context.pages()[0];
  const actual=await starter.evaluate(() => ({ userData: require('@electron/remote').app.getPath('userData'), version: require('@electron/remote').app.getVersion(), runtime:{node:process.versions.node,electron:process.versions.electron,chrome:process.versions.chrome} }));
  assert.equal(fs.realpathSync(actual.userData), fs.realpathSync(isolated));
  const nextPage=context.waitForEvent('page', { timeout: 20000 });
  await starter.evaluate(root => electron.ipcRenderer.sendSync('vault-open',root,false), vault);
  const page=await nextPage; testPage=page;
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 20000 });
  console.log(JSON.stringify({ stage:'vault-open', actual, vault, methods: await page.evaluate(() => Object.getOwnPropertyNames(Object.getPrototypeOf(app.plugins))) }));
  const loaded=await page.evaluate(async () => {
   app.plugins.setEnable(true);
   await app.plugins.loadManifests();
   await app.plugins.enablePlugin('topmind-stream');
   return { ids:Object.keys(app.plugins.plugins), manifest:app.plugins.manifests['topmind-stream'] };
  });
  assert.ok(loaded.ids.includes('topmind-stream'),JSON.stringify(loaded));
  console.log(JSON.stringify({ stage:'loaded',loaded }));
  assert.equal(loaded.manifest.version,JSON.parse(fs.readFileSync(path.join(repo,'manifest.json'),'utf8')).version);
  const trust=page.getByRole('button',{name:/信任仓库作者并启用插件|Trust .*enable plugins/iu});
  await trust.waitFor({timeout:1800}).catch(error=>{if(error.name!=='TimeoutError')throw error;});
  if(await trust.isVisible()) {await trust.click();await trust.waitFor({state:'hidden'});}
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(async()=>{const plugin=app.plugins.plugins['topmind-stream'];plugin.kernelService.initWorkspace();await plugin.openSidebar();});
  await page.locator('.tm-sidebar-dock').waitFor();
  if(await page.locator('.modal-close-button').count()) await page.locator('.modal-close-button').last().click();
  assert.ok(await page.locator('.tm-sidebar-dock .tm-empty-action button').count());
  const firstHint=page.locator('.tm-sidebar-dock .tm-empty-hint');
  assert.notEqual(await firstHint.evaluate(el=>getComputedStyle(el).whiteSpace),'nowrap');
  await page.screenshot({path:path.join(artifacts,'first-run.png')});

  await page.evaluate(async apiPort => {
   const plugin=app.plugins.plugins['topmind-stream'];
   const initialized=plugin.kernelService.initWorkspace();
   if(!initialized.ok) throw new Error(JSON.stringify(initialized));
   plugin.settings.autoSuggest=false;
   plugin.settings.ai.sourcePreference='custom';
   plugin.settings.ai.defaultModel='isolated-mock';
   plugin.settings.ai.manual.customKey='isolated-test-only';
   plugin.settings.ai.manual.customBaseUrl=`http://127.0.0.1:${apiPort}/v1`;
   plugin.kernelService.updateSettings(plugin.settings);
   await app.workspace.openLinkText('00-Inbox/Focus-A.md','',false);
   const md=app.workspace.getMostRecentLeaf().view;
   md.editor.setSelection({line:2,ch:0},{line:2,ch:14});
   await plugin.openSidebar();
  },apiPort);
  await page.locator('.tm-sidebar-dock').waitFor({ timeout: 10000 });
  if(await page.locator('.modal-close-button').count()) await page.locator('.modal-close-button').last().click();
  await page.evaluate(()=>app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.refresh());
  await page.locator('.tm-chat-context-bar').waitFor();
  assert.match(await page.locator('.tm-chat-context-bar').innerText(),/Focus-A/);
  const tabs=page.locator('.tm-sidebar-dock [role="tab"]');
  await tabs.last().focus();await page.keyboard.press('Home');
  await page.waitForTimeout(80);
  assert.equal(await tabs.first().evaluate(el=>document.activeElement===el),true);
  const panel=page.locator('.tm-sidebar-dock [role="tabpanel"]');
  assert.equal(await panel.getAttribute('aria-labelledby'),await tabs.first().getAttribute('id'));
  const connectivity=page.locator('.tm-footer-status');await connectivity.click();
  assert.equal(await connectivity.isDisabled(),true);await page.waitForFunction(()=>!document.querySelector('.tm-footer-status')?.disabled);
  assert.equal(quickTests,1);

  const input=page.locator('.tm-sidebar-dock textarea');
  await input.fill('验证当前对象：总结当前笔记，并给出实际文件路径');
  await input.press('Enter');
  console.log(JSON.stringify({stage:"submitted", text:(await page.locator(".tm-sidebar-dock").innerText()).slice(-2500)}));
  await Promise.race([firstSeen,new Promise((_,reject)=>setTimeout(()=>reject(new Error("No AI request after submission")),15000))]);
  await page.evaluate(()=>app.workspace.openLinkText('00-Inbox/Focus-B.md','',false));
  await page.locator('[data-tab-id="todos"]').click();
  await page.locator('.tm-todo-add-input').fill('keep draft during AI progress');

  await page.waitForFunction(()=>{
    const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0]?.view;
    return view?.chatHistory?.some(m=>m.role==='assistant') && !view.chatThinking;
  },null,{timeout:20000});
  assert.equal(requests.length,2);
  assert.equal(await page.locator('.tm-todo-add-input').inputValue(),'keep draft during AI progress');
  assert.equal(await page.locator('.tm-todo-add-input').evaluate(el=>document.activeElement===el),true);
  await page.locator('[data-tab-id="chat"]').click();

  assert.match(requests[0].messages[0].content,/Focus-A\.md/);
  assert.match(requests[1].messages[1].content,/Current object test selection/);
  const receipt=await page.evaluate(()=>app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.chatHistory.at(-1));
  assert.equal(receipt.focus.path,'00-Inbox/Focus-A.md');
  assert.ok(receipt.toolCalls.some(c=>c.tool==='read_file'&&c.summary==='00-Inbox/Focus-A.md'&&c.ok));
  const resultFooter=await page.locator('.tm-goal-footer').innerText();
  assert.doesNotMatch(resultFooter,/次写入|writes|变更|Changes/u);
  assert.match(resultFooter,/引用路径|Referenced paths/u);
  await page.screenshot({path:path.join(artifacts,'chat.png')});
  await page.evaluate(()=>app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].detach());
  await page.evaluate(()=>app.plugins.plugins['topmind-stream'].openSidebar());
  await page.locator('.tm-sidebar-dock').waitFor();
  const restored=await page.evaluate(()=>app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.chatHistory.at(-1));
  assert.equal(restored.focus.path,'00-Inbox/Focus-A.md');assert.equal(restored.content,receipt.content);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vault,'.topmind/chat-session.json'),'utf8')).version,1);
  await page.evaluate(async()=>{const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view;view.activeTab='suggestions';await view.renderActiveTab();});
  const deleteCard=page.locator('.tm-pending-write-card').filter({hasText:'Pending-delete.md'});
  await deleteCard.waitFor();
  await deleteCard.getByRole('button',{name:/确认删除|Confirm deletion/}).click();
  await page.waitForFunction(()=>!app.plugins.plugins['topmind-stream'].kernelService.listPendingWrites().length);
  assert.equal(fs.existsSync(path.join(vault,'00-Inbox/Pending-delete.md')),false);
  console.log(JSON.stringify({stage:'session-and-pending-delete',restored:true,deleted:true}));

  await page.evaluate(async()=>{const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view;view.activeTab='todos';await view.renderActiveTab();});
  await page.locator('.tm-todo-add-input').fill('真实界面新增待办');
  await page.locator('.tm-todo-add-input').press('Enter');
  await page.getByText('真实界面新增待办',{exact:true}).waitFor();
  const toggleHit=await page.locator('.tm-todo-toggle').last().boundingBox();assert.ok(toggleHit.width>=32 && toggleHit.height>=32);
  await page.locator('.tm-todo-toggle').last().click();
  await page.locator('.tm-todo-clear-done').waitFor();
  assert.ok(await page.locator('.tm-todo-clear-done').count());
  assert.equal(await page.evaluate(()=>app.plugins.plugins['topmind-stream'].kernelService.readTodos().every(todo=>todo.done)),true);

  await page.screenshot({path:path.join(artifacts,'todos.png')});
  await page.evaluate(async()=>{
   const service=app.plugins.plugins['topmind-stream'].kernelService;
   for(let i=1;i<=45;i++) if(!service.addTodo(`Task ${i}`).ok) throw new Error('todo fixture failed');
   await app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.refresh();
  });
  const activeRows=page.locator('.tm-todo-active-list .tm-todo-item');assert.equal(await activeRows.count(),20);
  await page.locator('.tm-todo-load-more').click();assert.equal(await activeRows.count(),40);
  const todoFilter=page.locator('.tm-todo-filter-input');await todoFilter.fill('Task 45');
  assert.equal(await activeRows.count(),1);assert.match(await activeRows.innerText(),/Task 45/);
  assert.equal(await todoFilter.evaluate(el=>document.activeElement===el),true);
  await todoFilter.fill('nothing matches');assert.equal(await activeRows.count(),0);
  await page.locator('.tm-todo-active-list .tm-empty-action button').click();assert.equal(await activeRows.count(),20);
  await page.locator('.tm-todo-completed summary').click();
  await page.locator('.tm-todo-completed .tm-todo-toggle').first().click();
  await page.waitForFunction(()=>app.plugins.plugins['topmind-stream'].kernelService.readTodos().every(todo=>!todo.done));
  await page.screenshot({path:path.join(artifacts,'todos-many.png')});
  await page.evaluate(()=>{
   const service=app.plugins.plugins['topmind-stream'].kernelService;
   window.__savedSuggestionGenerator=service.generateSuggestions;window.__suggestionCalls=0;
   service.generateSuggestions=()=>{window.__suggestionCalls++;return new Promise(resolve=>{window.__finishSuggestions=resolve;});};
  });
  await page.locator('[data-tab-id="suggestions"]').click();
  await page.waitForFunction(()=>typeof window.__finishSuggestions==='function');
  await page.locator('[data-tab-id="chat"]').click();
  await page.locator('.tm-chat-input').fill('Keep draft while suggestions finish');
  await page.evaluate(()=>window.__finishSuggestions([]));await page.waitForTimeout(50);
  assert.equal(await page.locator('.tm-chat-input').inputValue(),'Keep draft while suggestions finish');
  await page.locator('[data-tab-id="suggestions"]').click();
  await page.waitForFunction(()=>window.__suggestionCalls===2);
  await page.locator('[data-tab-id="todos"]').click();await page.locator('[data-tab-id="suggestions"]').click();
  assert.equal(await page.evaluate(()=>window.__suggestionCalls),2);
  await page.evaluate(()=>window.__finishSuggestions([{id:'ui-review',kind:'open_profile',title:'Current review result',summary:'Only the current Suggestions surface is updated.',impact:'low'}]));
  await page.getByText('Current review result',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:/全部确认|Accept all/u}).count(),0);
  await page.evaluate(()=>{app.plugins.plugins['topmind-stream'].kernelService.generateSuggestions=window.__savedSuggestionGenerator;delete window.__savedSuggestionGenerator;delete window.__finishSuggestions;delete window.__suggestionCalls;});


  await page.evaluate(()=>app.plugins.plugins['topmind-stream'].openWorkbench());
  await page.locator('.tm-stream-workbench .tm-input-field').waitFor();
  const ribbonLabels=await page.locator('.side-dock-ribbon-action').evaluateAll(els=>els.map(el=>el.getAttribute('aria-label')||el.getAttribute('title')||''));
  assert.ok(ribbonLabels.some(label=>/写作与交付|Writing & delivery/u.test(label)),JSON.stringify(ribbonLabels));
  const documentActions=page.locator('.tm-stream-workbench .tm-toolbar-actions');
  assert.equal(await documentActions.locator('button').count(),2);
  assert.ok(await documentActions.getByRole('button',{name:/新笔记|New Note/u}).isVisible());
  assert.ok(await documentActions.getByRole('button',{name:/写作与交付|Writing & delivery/u}).isVisible());
  await documentActions.getByRole('button',{name:/新笔记|New Note/u}).click();
  await page.waitForFunction(()=>app.workspace.getActiveFile()?.path?.includes('/Untitled-'),null,{timeout:10000});
  const createdPath=await page.evaluate(()=>app.workspace.getActiveFile()?.path);
  assert.match(createdPath,/^00-Inbox\/Untitled-.*\.md$/u);
  assert.ok(await page.evaluate(()=>app.workspace.getLeavesOfType('topmind-stream-workbench').length>0));
  const writing=page.locator('.tm-writing-modal');
  const focusVault=async()=>{
    await page.evaluate(()=>{
      require('@electron/remote').getCurrentWindow().focus();
      // CDP can target this Vault without delivering a macOS focus transition.
      if(activeWindow!==window)window.dispatchEvent(new FocusEvent('focus'));
    });
    await page.waitForFunction(()=>activeWindow===window,null,{timeout:4000});
  };
  const openWriting=async()=>{
    await focusVault();
    assert.equal(await page.evaluate(()=>app.commands.executeCommandById('topmind-stream:writing-delivery')),true);
    await writing.waitFor();
  };
  await focusVault();
  await page.locator('.side-dock-ribbon-action[aria-label="写作与交付"]').click();
  await writing.waitFor();
  const writingOpenedFromRibbon=true;
  assert.match(await writing.innerText(),/Untitled-/u);
  assert.equal(await writing.locator('details.tm-writing-more').first().evaluate(el=>el.open),false);
  const briefsChoice=writing.locator('[data-writing-action="topmind-briefs"]');
  const requestsBeforeChoice=requests.length;
  await briefsChoice.locator('.tm-writing-choice-desc').click();
  assert.equal(await briefsChoice.getAttribute('aria-pressed'),'true');
  assert.equal(await briefsChoice.evaluate(el=>document.activeElement===el),true);
  const reviseChoice=writing.locator('[data-writing-action="topmind-revise"]');
  await reviseChoice.press('Space');
  assert.equal(await reviseChoice.getAttribute('aria-pressed'),'true');
  assert.equal(requests.length,requestsBeforeChoice);
  const writingMeasure=async()=>writing.evaluate(el=>{const box=el.getBoundingClientRect();const content=el.querySelector('.modal-content');return{x:box.x,y:box.y,width:box.width,height:box.height,contentWidth:content?.clientWidth,contentScrollWidth:content?.scrollWidth,contentHeight:content?.clientHeight,contentScrollHeight:content?.scrollHeight};});
  const wideWriting=await writingMeasure();
  assert.ok(wideWriting.width<=660 && wideWriting.x>=0 && wideWriting.y>=0,JSON.stringify(wideWriting));
  await page.screenshot({path:path.join(artifacts,'writing-wide.png')});
  await page.setViewportSize({width:500,height:560});
  const narrowWriting=await writingMeasure();
  assert.ok(narrowWriting.width<=500 && narrowWriting.height<=560 && narrowWriting.x>=0 && narrowWriting.y>=0,JSON.stringify(narrowWriting));
  assert.ok(narrowWriting.contentScrollWidth<=narrowWriting.contentWidth+1,JSON.stringify(narrowWriting));
  const startWriting=writing.getByRole('button',{name:/开始写作任务|Start writing task/u});
  await startWriting.scrollIntoViewIfNeeded();assert.ok(await startWriting.isVisible());
  await startWriting.focus();assert.equal(await startWriting.evaluate(el=>document.activeElement===el),true);
  await page.screenshot({path:path.join(artifacts,'writing-narrow.png')});
  await page.keyboard.press('Escape');await writing.waitFor({state:'hidden'});
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(()=>app.workspace.revealLeaf(app.workspace.getLeavesOfType('topmind-stream-workbench')[0]));
  await page.locator('.tm-stream-workbench .tm-input-field').waitFor({state:'visible'});
  console.log(JSON.stringify({stage:'writing-and-new-note',ribbonLabels,writingOpenedFromRibbon,createdPath,wideWriting,narrowWriting}));
  await page.evaluate(()=>{const service=app.plugins.plugins['topmind-stream'].kernelService;window.__originalPolish=service.polishText;service.polishText=()=>new Promise(resolve=>{window.__finishPolish=resolve;});});
  const compose=page.locator('.tm-stream-workbench .tm-input-field');
  await compose.fill('original draft');await page.locator('.tm-btn-polish').click();
  await compose.fill('newer draft kept');await page.evaluate(()=>window.__finishPolish('stale polished text'));
  await page.waitForFunction(()=>!document.querySelector('.tm-btn-polish')?.disabled);
  assert.equal(await compose.inputValue(),'newer draft kept');
  const stalePolishNotice=page.locator('.notice-message').filter({hasText:/输入已变化|Your draft changed/u});
  await stalePolishNotice.click();
  await stalePolishNotice.waitFor({state:'hidden'});
  await page.evaluate(()=>{app.plugins.plugins['topmind-stream'].kernelService.polishText=window.__originalPolish;delete window.__originalPolish;delete window.__finishPolish;});
  await page.screenshot({path:path.join(artifacts,'stream.png')});
  await page.evaluate(()=>app.plugins.plugins['topmind-stream'].openQuickCapture());
  const capture=page.locator('.tm-quick-capture-modal');await capture.waitFor();
  const note=capture.locator('textarea');await note.press('Enter');assert.equal(await capture.isVisible(),true);
  await note.fill('https://example.com');
  const target=capture.locator('select');assert.equal(await target.inputValue(),'inbox');
  await target.selectOption('stream');await note.fill('https://example.com/next');assert.equal(await target.inputValue(),'stream');
  await page.screenshot({path:path.join(artifacts,'capture.png')});await note.press('Escape');
  await page.setViewportSize({width:900,height:700});
  await page.locator('[data-tab-id="chat"]').click();
  assert.ok(await page.locator('.tm-sidebar-dock .tm-chat-input').isVisible());

  await page.evaluate(async()=>{
   const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view;
   window.__savedMessages=view.chat.messages;
   view.chat.messages=Array.from({length:40},(_,i)=>({role:i%2?'assistant':'user',content:`Message ${i}\n\n${'Long conversation evidence. '.repeat(30)}`}));
   view.chatScrollToLatest=true;await view.refresh();
  });
  let reading=page.locator('.tm-chat-messages');
  await page.waitForFunction(()=>document.querySelector('.tm-chat-messages')?.scrollHeight>2000);
  await page.waitForTimeout(100);
  console.log(JSON.stringify({stage:'reading-start',value:await reading.evaluate(el=>{el.scrollTop=200;el.dispatchEvent(new Event('scroll'));const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view;return{top:el.scrollTop,scrollBehavior:getComputedStyle(el).scrollBehavior,viewport:view.chatViewport,force:view.chatScrollToLatest};})}));
  await page.evaluate(()=>app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.refresh());
  await page.waitForTimeout(80);assert.ok(Math.abs(await reading.evaluate(el=>el.scrollTop)-200)<4,JSON.stringify(await page.evaluate(()=>({viewport:app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.chatViewport,top:document.querySelector('.tm-chat-messages')?.scrollTop,height:document.querySelector('.tm-chat-messages')?.clientHeight,scrollHeight:document.querySelector('.tm-chat-messages')?.scrollHeight}))));
  await page.locator('[data-tab-id="todos"]').click();await page.locator('[data-tab-id="chat"]').click();
  await page.waitForTimeout(80);assert.ok(Math.abs(await reading.evaluate(el=>el.scrollTop)-200)<4,JSON.stringify(await page.evaluate(()=>({viewport:app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.chatViewport,top:document.querySelector('.tm-chat-messages')?.scrollTop,height:document.querySelector('.tm-chat-messages')?.clientHeight,scrollHeight:document.querySelector('.tm-chat-messages')?.scrollHeight}))));
  await page.evaluate(()=>{const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view;view.chat.thinking=true;view.chat.reasoning='Progress without a reading jump';view.patchChatWorkingRow();});
  await page.waitForTimeout(80);assert.ok(Math.abs(await reading.evaluate(el=>el.scrollTop)-200)<4,JSON.stringify(await page.evaluate(()=>({viewport:app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.chatViewport,top:document.querySelector('.tm-chat-messages')?.scrollTop,height:document.querySelector('.tm-chat-messages')?.clientHeight,scrollHeight:document.querySelector('.tm-chat-messages')?.scrollHeight}))));
  await page.evaluate(async()=>{const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view;view.chat.thinking=false;view.chat.messages.push({role:'assistant',content:'A newer reply arrives.'});await view.refresh();});
  await page.waitForTimeout(80);assert.ok(Math.abs(await reading.evaluate(el=>el.scrollTop)-200)<4,JSON.stringify(await page.evaluate(()=>({viewport:app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.chatViewport,top:document.querySelector('.tm-chat-messages')?.scrollTop,height:document.querySelector('.tm-chat-messages')?.clientHeight,scrollHeight:document.querySelector('.tm-chat-messages')?.scrollHeight}))));
  await page.screenshot({path:path.join(artifacts,'long-chat.png')});
  await page.locator('.tm-chat-jump').click();
  assert.ok(await reading.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)<4);
  await page.evaluate(async()=>{const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view;view.chat.messages=window.__savedMessages;delete window.__savedMessages;view.chat.reasoning='';view.chatScrollToLatest=true;await view.refresh();});
  await page.waitForTimeout(80);
  const statusSize=await page.locator('.tm-footer-status').boundingBox();assert.ok(statusSize.width>=32 && statusSize.height>=32);
  const composeHint=await page.locator('.tm-wb-compose-hint').boundingBox();
  assert.ok(composeHint.width>100 && composeHint.height<40,JSON.stringify(composeHint));
  await page.screenshot({path:path.join(artifacts,'narrow.png')});
  const overflow=await page.locator('.tm-sidebar-dock').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));
  assert.ok(overflow.scrollWidth<=overflow.width+1,JSON.stringify(overflow));
  await page.evaluate(()=>{document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');});
  await page.waitForTimeout(100);await page.screenshot({path:path.join(artifacts,'dark.png')});

  await page.evaluate(async()=>{
    await app.workspace.openLinkText('00-Inbox/Focus-A.md','',true);
    const leaf=app.workspace.getLeavesOfType('markdown').find(item=>item.view.file?.path==='00-Inbox/Focus-A.md');
    await app.workspace.revealLeaf(leaf);
    leaf.view.editor.setSelection({line:2,ch:0},{line:2,ch:14});
    app.commands.executeCommandById('topmind-stream:review-selection');
  });
  await page.waitForFunction(()=>{
    const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0]?.view;
    return view?.chatHistory?.at(-1)?.role==='assistant' && view.chatHistory.at(-1).focus?.taskIntent?.skillId==='topmind-revise' && !view.chatThinking;
  },null,{timeout:20000});
  const selectionReceipt=await page.evaluate(()=>app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.chatHistory.at(-1));
  assert.equal(selectionReceipt.focus.selection,'Current object');
  assert.equal(selectionReceipt.focus.taskIntent.output,'review');
  assert.equal(fs.readFileSync(path.join(vault,'00-Inbox/Focus-A.md'),'utf8'),'# Focus A\n\nCurrent object test selection.\n');
  await page.screenshot({path:path.join(artifacts,'selection-review.png')});

  const beforeMemoryRequests=requests.length;
  await input.fill('记住：我在周日上午阅读长文');
  await input.press('Enter');
  await page.waitForFunction(()=>{
    const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0]?.view;
    const result=view?.chatHistory?.at(-1);
    return result?.role==='assistant' && result.goal?.modifiedPaths?.includes('memory/profile.md') && !view.chatThinking;
  },null,{timeout:10000});
  assert.equal(requests.length,beforeMemoryRequests);
  assert.match(fs.readFileSync(path.join(vault,'memory/profile.md'),'utf8'),/我在周日上午阅读长文/u);
  const memoryMessage=page.locator('.tm-chat-message.tm-chat-ai').last();
  assert.equal(await memoryMessage.locator('.tm-chat-object').count(),0);
  const memoryFooter=memoryMessage.locator('.tm-goal-footer');
  assert.match(await memoryFooter.innerText(),/已修改文件|Changed files/u);
  await memoryFooter.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(artifacts,'direct-memory.png')});

  const setChatTab=tab=>page.evaluate(async id=>{
    const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view;
    view.activeTab=id;await view.renderActiveTab();
  },tab);
  const latest=()=>page.evaluate(()=>app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.chatHistory.at(-1));
  const send=async(text)=>{
    const turns=await page.evaluate(()=>app.workspace.getLeavesOfType('topmind-sidebar-dock')[0].view.chatHistory.length);
    await input.fill(text);await input.press('Enter');
    await page.waitForFunction(previous=>{
      const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0]?.view;
      return view?.chatHistory.length>previous && view.chatHistory.at(-1)?.role==='assistant' && !view.chatThinking;
    },turns,{timeout:20000});
    return latest();
  };
  await page.evaluate(relative=>app.workspace.openLinkText(relative,'',true),longPath);
  await openWriting();
  assert.match(await writing.innerText(),/Long-article\.md/u);
  await writing.locator('select').first().selectOption('edit');
  await writing.locator('textarea').fill('只替换结尾一句，保留引语、实测数字及其余段落。');
  const beforeEdit=requests.length;
  scriptedReplies.push({tool:'read_file',relativePath:longPath,around:'Draft closing sentence.',limit:30},
    {tool:'edit_file',relativePath:longPath,oldText:'Draft closing sentence.',newText:'Only the closing sentence changed.'},
    '只改了结尾。');
  await writing.getByRole('button',{name:/开始写作任务|Start writing task/u}).click();
  await page.waitForFunction(()=>{
    const view=app.workspace.getLeavesOfType('topmind-sidebar-dock')[0]?.view;
    const msg=view?.chatHistory.at(-1);
    return msg?.role==='assistant' && msg.focus?.path==='00-Inbox/Long-article.md' && !view.chatThinking;
  },null,{timeout:20000});
  const edited=longOriginal.replace('Draft closing sentence.','Only the closing sentence changed.');
  assert.equal(fs.readFileSync(path.join(vault,longPath),'utf8'),edited);
  assert.deepEqual((await latest()).goal.modifiedPaths,[longPath]);
  assert.ok(requests[beforeEdit+1].messages.some(message=>/\d+\|Draft closing sentence\./u.test(String(message.content))));
  assert.equal(scriptedReplies.length,0);

  const beforePreview=requests.length;
  await openWriting();
  await writing.getByRole('tab',{name:/排版预览|Layout preview/u}).click();
  const formatControl=writing.locator('[data-writing-format]');
  await formatControl.focus();
  await formatControl.selectOption('text');
  assert.equal(await formatControl.evaluate(el=>el===document.activeElement),true);
  await formatControl.selectOption('wechat');
  const themeControl=writing.locator('[data-writing-theme]');
  await themeControl.selectOption('graphite');
  assert.equal(await themeControl.evaluate(el=>el===document.activeElement),true);
  await themeControl.selectOption('minimal-ink');
  await writing.getByRole('button',{name:/生成预览|Generate preview/u}).click();
  const frame=writing.locator('iframe');await frame.waitFor();
  const html=await frame.getAttribute('srcdoc');
  assert.match(html,/\[Index diagram\]/u);
  const imageDetails=writing.locator('[data-writing-images]');
  assert.ok(await imageDetails.evaluate(details=>details.open));
  assert.match(await imageDetails.innerText(),/缺失或无法读取|Missing or unreadable/u);
  assert.ok(await imageDetails.getByText('missing-index.png',{exact:true}).isVisible());
  const exportButton=writing.getByRole('button',{name:/导出文件|Export file/u});
  assert.ok(await writing.locator('[data-writing-checks]').evaluate((section,button)=>
    !!(section.compareDocumentPosition(button)&Node.DOCUMENT_POSITION_FOLLOWING),await exportButton.elementHandle()));
  await exportButton.click();
  const exportPath='00-Inbox/out/Long-article-wechat.html';
  await writing.getByRole('status').filter({hasText:exportPath}).waitFor();
  assert.equal(fs.readFileSync(path.join(vault,exportPath),'utf8'),html);
  assert.match(fs.readFileSync(path.join(vault,'00-Inbox/out/Long-article-wechat-images.md'),'utf8'),/missing · missing-index\.png/u);
  assert.equal(fs.readFileSync(path.join(vault,longPath),'utf8'),edited);
  assert.equal(requests.length,beforePreview);
  await page.screenshot({path:path.join(artifacts,'missing-image-export.png')});
  const checklistPath='00-Inbox/out/Long-article-wechat-images.md';
  fs.renameSync(path.join(vault,checklistPath),path.join(artifacts,'initial-checklist.md'));
  fs.mkdirSync(path.join(vault,checklistPath));
  await exportButton.click();
  const partial=writing.getByRole('status').filter({hasText:/正文已导出|Article exported/u});
  await partial.waitFor();
  assert.ok((await partial.innerText()).includes(exportPath));
  assert.ok((await partial.innerText()).includes(checklistPath));
  assert.ok(await partial.evaluate(status=>{
    const visibleArea=status.closest('.modal-content').getBoundingClientRect();
    const bounds=status.getBoundingClientRect();
    return bounds.top>=visibleArea.top-1 && bounds.bottom<=visibleArea.bottom+1;
  }));
  assert.equal(fs.readFileSync(path.join(vault,exportPath),'utf8'),html);
  assert.equal(fs.readFileSync(path.join(vault,longPath),'utf8'),edited);
  await page.screenshot({path:path.join(artifacts,'partial-export.png')});
  fs.rmdirSync(path.join(vault,checklistPath));
  fs.writeFileSync(path.join(vault,'00-Inbox/missing-index.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lfsAAAAASUVORK5CYII=','base64'));
  await exportButton.click();
  await writing.getByRole('status').filter({hasText:/图片已改变|images changed/u}).waitFor();
  assert.equal(await exportButton.isDisabled(),true);
  assert.equal(await frame.count(),0);
  assert.equal(fs.readFileSync(path.join(vault,exportPath),'utf8'),html);
  await writing.getByRole('button',{name:/生成预览|Generate preview/u}).click();
  await frame.waitFor();
  assert.match(await frame.getAttribute('srcdoc'),/src="data:image\/png;base64,/u);
  assert.equal(await writing.locator('[data-writing-checks]').count(),0);
  await page.keyboard.press('Escape');await writing.waitFor({state:'hidden'});

  await setChatTab('chat');
  const todoFile=path.join(vault,'memory/todo.md');
  const todoBefore=fs.readFileSync(todoFile,'utf8');
  assert.match(todoBefore,/Task 45/u);
  scriptedReplies.push({tool:'save_file',relativePath:'00-Inbox/Unexpected.md',content:'Unrequested write'},
    {tool:'list_todos',limit:60},'待办包括 Task 45。来源：memory/todo.md。');
  const lookup=await send('What are my current todos?');
  assert.ok(lookup.toolCalls.some(call=>call.tool==='save_file' && !call.ok));
  assert.ok(lookup.toolCalls.some(call=>call.tool==='list_todos' && call.ok));
  assert.match(lookup.content,/Task 45.*memory\/todo\.md/u);
  assert.deepEqual(lookup.goal?.modifiedPaths || [],[]);
  assert.equal(fs.existsSync(path.join(vault,'00-Inbox/Unexpected.md')),false);
  assert.equal(fs.readFileSync(todoFile,'utf8'),todoBefore);

  const yamlPath=path.join(vault,'topmind.yaml');
  fs.writeFileSync(yamlPath,fs.readFileSync(yamlPath,'utf8').replace(/mode: auto/u,'mode: confirm'));
  const removed='00-Inbox/Focus-B.md';
  const beforeDelete=fs.readFileSync(path.join(vault,removed),'utf8');
  const resumeOutput='00-Inbox/Resume-result.md';
  scriptedReplies.push({tool:'delete_path',relativePath:removed});
  const pending=await send('请删除 Focus-B.md，然后保存续跑结果。');
  assert.equal(pending.goal.blockReason,'awaiting_confirmation');
  assert.equal(fs.readFileSync(path.join(vault,removed),'utf8'),beforeDelete);
  const beforeWait=requests.length;
  const waiting=await send('继续');
  assert.equal(waiting.goal.blockReason,'awaiting_confirmation');
  assert.equal(requests.length,beforeWait);
  await setChatTab('suggestions');
  const liveCard=page.locator('.tm-pending-write-card').filter({hasText:'Focus-B.md'});
  await liveCard.getByRole('button',{name:/确认删除|Confirm deletion/u}).click();
  await liveCard.waitFor({state:'hidden'});
  assert.equal(fs.existsSync(path.join(vault,removed)),false);
  fs.writeFileSync(path.join(vault,removed),'Replacement note at the same path.\n');
  await setChatTab('chat');
  scriptedReplies.push({tool:'delete_path',relativePath:removed},
    {tool:'save_file',relativePath:resumeOutput,content:'Continued after confirmation.'},
    '续跑结果已保存。 [DONE]');
  const resumed=await send('继续');
  assert.equal(resumed.goal.status,'done');
  assert.deepEqual(resumed.goal.modifiedPaths,[resumeOutput]);
  assert.equal(fs.readFileSync(path.join(vault,removed),'utf8'),'Replacement note at the same path.\n');
  assert.equal(fs.readFileSync(path.join(vault,resumeOutput),'utf8'),'Continued after confirmation.');
  assert.equal(scriptedReplies.length,0);
  const resumedFooter=page.locator('.tm-chat-message.tm-chat-ai').last().locator('.tm-goal-footer');
  assert.match(await resumedFooter.innerText(),/Resume-result\.md/u);
  await resumedFooter.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(artifacts,'resume-after-confirmation.png')});
  console.log(JSON.stringify({stage:'host-replay',longEdit:longPath,exportPath,queryWriteBlocked:true,confirmedResume:resumeOutput}));

  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log(JSON.stringify({stage:'validated',requests:requests.length,target:receipt.focus.path,errors}));
  console.log(JSON.stringify({stage:'rendered',text:(await page.locator('body').innerText()).slice(-5000),errors}));
  fs.writeFileSync(path.join(artifacts,'verification.json'),JSON.stringify({pluginVersion:loaded.manifest.version,host:{version:actual.version,runtime:actual.runtime},model:'local mock; no real-provider calls',checks:{focusFrozen:true,sessionRestored:true,pendingDelete:true,todoAddedAndCompleted:true,summaryRequests:requests.length,quickTests,keyboardTabFocus:true,backgroundDraftPreserved:true,polishPreservesNewerDraft:true,captureDestinationRespected:true,emptyCaptureRetained:true,narrowViewport:true,darkTheme:true,noHorizontalOverflow:true,streamHintNotVertical:true,longChatReadingPosition:true,explicitJumpToLatest:true,todoBatchAndFilter:true,completedTodoRestore:true,todoToggleTarget32px:true,suggestionResultsStayInSurface:true,suggestionRequestRejoined:true,suggestionNoBulkApply:true,inlineSelectionReview:true,readOnlyFooterHonest:true,ribbonWritingEntry:writingOpenedFromRibbon,createdNoteOpened:createdPath,writingWide:wideWriting,writingNarrow:narrowWriting,hostReplay:{longEdit:longPath,exportPath,checklistPath,partialExport:true,queryWriteBlocked:true,confirmedResume:resumeOutput},pageErrors:errors}},null,2));
  console.log(JSON.stringify({stage:'artifacts',directory:artifacts}));
 } finally { if(testPage) console.log(JSON.stringify({stage:"final-dom",text:(await testPage.locator("body").innerText().catch(()=>"")).slice(-5000)})); if(browser) await browser.close(); child.kill(); server.closeAllConnections(); server.close(); }
})().catch(e=>{console.error(e.stack); process.exitCode=1;});
