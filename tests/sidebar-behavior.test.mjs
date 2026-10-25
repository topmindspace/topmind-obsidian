import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
register(new URL('./obsidian-stub-loader.mjs', import.meta.url).href, import.meta.url);
const { SidebarDockView } = await import('../src/views/sidebar-dock-view.ts');
const { renderSuggestionCard } = await import('../src/views/suggestion-card.ts');
const { DEFAULT_SETTINGS } = await import('../src/types.ts');
const host = await import('./obsidian-host-stub.mjs');
const all = node => [node, ...node.children.flatMap(all)];
const tick = () => new Promise(resolve => setImmediate(resolve));

test('completed-only todo list retains cleanup and direct capture; IME Enter never submits', () => {
  const added = [];
  const service = { readTodos: () => [{ id: 'a', text: 'Done', done: true }], addTodo: text => { added.push(text); return { ok: true }; } };
  const plugin = { settings: structuredClone(DEFAULT_SETTINGS), kernelService: service };
  const view = new SidebarDockView({ app: {} }, plugin);
  view.refreshActiveTab = async () => {};
  const container = host.createElement('div');
  view.renderTodosTab(container);
  assert.ok(all(container).some(el => el.className.includes('tm-todo-clear-done')));
  const input = all(container).find(el => el.tagName === 'INPUT');
  input.value = 'new task';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: true });
  assert.equal(added.length, 0);
  input.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: false, preventDefault() {} });
  assert.deepEqual(added, ['new task']);
});

test('failed todo deletion keeps its row and does not repaint as success', () => {
  let refreshed = 0;
  const plugin = { settings: structuredClone(DEFAULT_SETTINGS), kernelService: { readTodos: () => [{ id: 'a', text: 'Keep', done: false }], deleteTodo: () => ({ ok: false }) } };
  const view = new SidebarDockView({ app: {} }, plugin);
  view.refreshActiveTab = async () => { refreshed++; };
  const container = host.createElement('div');
  view.renderTodosTab(container);
  all(container).find(el => el.className === 'tm-todo-delete').dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(refreshed, 0);
  assert.ok(all(container).some(el => el.textContent === 'Keep'));
});

test('suggestion apply rejection restores the review button', async () => {
  const container = host.createElement('div');
  renderSuggestionCard(container, { id: 's', kind: 'promote_memory', title: 'Review', summary: 'Fact', impact: 'low' }, { apply: async () => { throw new Error('offline'); }, dismiss() {}, refresh() {}, openVaultPath: async () => {} });
  const button = all(container).find(el => el.className.includes('tm-btn-confirm'));
  assert.ok(button);
  button.dispatchEvent({ type: 'click' });
  assert.equal(button.disabled, true);
  await tick();
  assert.equal(button.disabled, false);
  assert.ok(button.textContent.length > 0);
});

test('opening a new dock reveals its leaf, so a collapsed right split becomes visible', async () => {
  const { openSidebarDock } = await import('../src/services/view-openers.ts');
  const events=[];
  const leaf={ setViewState: async state => {events.push(['state',state.type]);} };
  const app={workspace:{getLeavesOfType:()=>[],getRightLeaf:()=>leaf,revealLeaf:async l=>{assert.equal(l,leaf);events.push(['revealed']);}}};
  assert.equal(await openSidebarDock(app),leaf);
  assert.deepEqual(events,[['state','topmind-sidebar-dock'],['revealed']]);
});

test('each assistant response exposes its frozen object independently from the current tab', async () => {
  const opened=[];
  const view=new SidebarDockView({app:{workspace:{openLinkText:async p=>opened.push(p)}}},{settings:structuredClone(DEFAULT_SETTINGS)});
  const container=host.createElement('div');
  view.renderChatMessage(container,{role:'assistant',content:'failed',isError:true,focus:{path:'00-Inbox/Original.md'}});
  const button=all(container).find(el=>el.className==='tm-chat-object');
  assert.ok(button.textContent.includes('Original.md'));
  button.dispatchEvent({type:'click'});
  await tick();
  assert.deepEqual(opened,['00-Inbox/Original.md']);
});

test('AI connection status is a real button; click runs once, shows busy, then restores retry', async () => {
 const settings=structuredClone(DEFAULT_SETTINGS);settings.ai.manual.openAiKey='test-only';
 let resolve,calls=0;
 const service={quickTestAi:()=>{calls++;return new Promise(r=>{resolve=r;});}};
 const view=new SidebarDockView({app:{}},{settings,kernelService:service});
 const container=host.createElement('div');view.renderFooterStatus(container);
 const button=all(container).find(el=>el.tagName==='BUTTON');
 assert.ok(button);assert.ok(button.getAttribute('aria-label'));
 button.click();button.click();
 assert.equal(calls,1);assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-busy'),'true');
 resolve({ok:false,error:'offline'});await tick();
 assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-busy'),null);
 assert.ok(all(container).some(el=>el.className.includes('tm-dot-error')));
 button.click();assert.equal(calls,2);resolve({ok:true});await tick();
 assert.ok(all(container).some(el=>el.className.includes('tm-dot-ok')));
});

test('keyboard tab activation keeps focus on the tab and supplies panel relationships', () => {
 const view=new SidebarDockView({app:{}},{settings:structuredClone(DEFAULT_SETTINGS)});
 view.renderActiveTab=async()=>{};
 const container=host.createElement('div');view.renderTabBar(container);
 const tabs=all(container).filter(el=>el.getAttribute('role')==='tab');
 tabs[3].dispatchEvent({type:'keydown',key:'Home',preventDefault(){}});
 assert.equal(view.activeTab,'chat');assert.equal(view.chatFocusOnRender,false);assert.equal(host.document.activeElement,tabs[0]);
 assert.ok(tabs.every(tab=>tab.id && tab.getAttribute('aria-controls') && tab.getAttribute('title')));
 tabs[0].dispatchEvent({type:'keydown',key:'ArrowRight',preventDefault(){}});
 assert.equal(view.activeTab,'suggestions');assert.equal(tabs[1].tabIndex,0);assert.equal(tabs[0].tabIndex,-1);
});

test('background chat progress and completion do not repaint another tab or steal focus', async () => {
 let finish,options,renders=0;
 const service={getVaultPath:()=>'/unused',chat:async(_prompt,_history,opts)=>{options=opts;return new Promise(resolve=>{finish=resolve;});}};
 const view=new SidebarDockView({app:{}},{settings:structuredClone(DEFAULT_SETTINGS),kernelService:service});
 view.chatController={send:async(_prompt,_focus,opts)=>{options=opts;opts.onStart();return new Promise(resolve=>{finish=()=>{opts.onFinish();resolve();};});}};
 view.renderActiveTab=async()=>{renders++;};
 const running=view.executeChat('test',null);
 assert.equal(renders,1);view.activeTab='todos';
 options.onProgress({kind:'step',step:1,maxSteps:32});finish();await running;
 assert.equal(renders,1);
});

test('unsent todo survives tab repaint and clears only after successful capture', () => {
 let saved='';
 const service={readTodos:()=>[],addTodo:text=>{saved=text;return {ok:true};}};
 const view=new SidebarDockView({app:{}},{settings:structuredClone(DEFAULT_SETTINGS),kernelService:service});
 view.refreshActiveTab=async()=>{};
 let container=host.createElement('div');view.renderTodosTab(container);
 let input=all(container).find(el=>el.tagName==='INPUT');input.value='keep unsent';input.dispatchEvent({type:'input'});
 container=host.createElement('div');view.renderTodosTab(container);input=all(container).find(el=>el.tagName==='INPUT');
 assert.equal(input.value,'keep unsent');input.dispatchEvent({type:'keydown',key:'Enter',preventDefault(){}});
 assert.equal(saved,'keep unsent');assert.equal(view.todoDraft,'');assert.equal(input.value,'');
});

test('read paths are references rather than write counts, and pending tools stay separate',()=>{
 const view=new SidebarDockView({app:{}},{settings:structuredClone(DEFAULT_SETTINGS)});
 const container=host.createElement('div');
 view.renderResultFooter(container,{role:'assistant',content:'summary',toolCalls:[{tool:'read_file',ok:true,summary:'a.md'},{tool:'propose_memory_change',ok:true,pending:true}],goal:{status:'done',pathReceipts:['a.md']}});
 const strings=all(container).map(el=>el.textContent).join(' ');
 assert.doesNotMatch(strings,/次写入|writes|变更|Changes/u);
 assert.match(strings,/引用路径|Referenced paths/u);
 assert.match(strings,/1.*(?:工具已完成|tool calls completed)/u);
 assert.match(strings,/1.*(?:待确认|awaiting confirmation)/u);
 assert.equal(all(container).filter(el=>el.className==='tm-goal-footer-row').length,1);
});

test('unconfigured Chat offers an actionable path to capture without an AI key',()=>{
 const view=new SidebarDockView({app:{}},{settings:structuredClone(DEFAULT_SETTINGS)});
 let opened=0;view.openWorkbench=async()=>{opened++;};
 const container=host.createElement('div');view.renderChatTab(container);
 const buttons=all(container).filter(el=>el.tagName==='BUTTON');
 assert.equal(buttons.length,2);buttons[1].click();assert.equal(opened,1);
});

test('many todos load in batches, filter without replacing its input, and clear no-match state',()=>{
 const todos=Array.from({length:45},(_,i)=>({id:String(i+1),text:`Task ${i+1}`,done:false}));
 const view=new SidebarDockView({app:{}},{settings:structuredClone(DEFAULT_SETTINGS),kernelService:{readTodos:()=>todos}});
 const container=host.createElement('div');view.renderTodosTab(container);
 const active=()=>all(container).find(el=>el.className==='tm-todo-active-list');
 const rows=()=>all(active()).filter(el=>el.className==='tm-todo-item');
 assert.equal(rows().length,20);
 all(container).find(el=>el.className.includes('tm-todo-load-more')).click();assert.equal(rows().length,40);
 const search=all(container).find(el=>el.type==='search');search.focus();search.value='Task 45';search.dispatchEvent({type:'input'});
 assert.equal(rows().length,1);assert.equal(host.document.activeElement,search);
 assert.ok(all(rows()[0]).some(el=>el.textContent==='Task 45'));
 search.value='nothing matches';search.dispatchEvent({type:'input'});assert.equal(rows().length,0);
 const clear=all(active()).find(el=>el.tagName==='BUTTON');clear.click();
 assert.equal(search.value,'');assert.equal(rows().length,20);
});

test('completed todos can be inspected and unchecked to restore through the same Kernel action',()=>{
 const toggles=[];
 const view=new SidebarDockView({app:{}},{settings:structuredClone(DEFAULT_SETTINGS),kernelService:{readTodos:()=>[{id:'done',text:'Completed',done:true}],toggleTodo:id=>{toggles.push(id);return{ok:true};}}});
 view.refreshActiveTab=async()=>{};
 const container=host.createElement('div');view.renderTodosTab(container);
 const completed=all(container).find(el=>el.tagName==='DETAILS');assert.ok(completed);
 const checkbox=all(completed).find(el=>el.type==='checkbox');assert.equal(checkbox.checked,true);
 completed.open=true;completed.dispatchEvent({type:'toggle'});assert.equal(view.completedOpen,true);
 checkbox.checked=false;checkbox.dispatchEvent({type:'change'});assert.deepEqual(toggles,['done']);
});

test('chat repaint keeps reading position; latest is an explicit action and observers disconnect',async()=>{
 const view=new SidebarDockView({app:{}},{settings:structuredClone(DEFAULT_SETTINGS)});
 const container=host.createElement('div');view.contentContainer=container;
 const old=container.createDiv({cls:'tm-chat-messages'});Object.assign(old,{clientHeight:200,scrollHeight:1000,scrollTop:120});
 let disconnected=0;view.chatResizeObserver={disconnect(){disconnected++;}};
 view.captureChatViewport();assert.deepEqual(view.chatViewport,{top:120,follow:false});assert.equal(disconnected,1);
 const pane=host.createElement('div');Object.assign(pane,{clientHeight:200,scrollHeight:1400,scrollTop:0,isConnected:true});
 const jump=host.createElement('button');view.bindChatViewport(pane,jump);
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(pane.scrollTop,120);assert.equal(jump.hidden,false);
 jump.click();assert.equal(view.chatViewport.follow,true);assert.equal(jump.hidden,true);assert.ok(pane.scrollTop>=1200);
 pane.scrollTop=100;pane.dispatchEvent({type:'scroll'});assert.equal(view.chatViewport.follow,false);assert.equal(jump.hidden,false);
});

test('late suggestion results cannot replace Chat, and returning Suggestions joins the original request',async()=>{
 let finish,calls=0;
 const settings=structuredClone(DEFAULT_SETTINGS);settings.ai.manual.openAiKey='test-only';settings.autoSuggest=false;
 const service={peekSuggestions:()=>[],generateSuggestions:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
 const view=new SidebarDockView({app:{}},{settings,kernelService:service});
 const root=host.createElement('div');view.contentContainer=root;view.activeTab='suggestions';
 view.renderPendingWrites=()=>0;view.renderSuggestionRefreshButton=()=>{};
 view.paintSuggestionCards=(container,cards)=>cards.forEach(card=>container.createDiv({text:card.title}));
 const first=view.renderSuggestionsTab(root);const retired=root.children[0];
 root.empty();retired.isConnected=false;view.activeTab='chat';root.createDiv({text:'keep my composer'});
 view.activeTab='suggestions';const second=view.renderSuggestionsTab(root);
 assert.equal(calls,1);finish([{id:'new',title:'Ready',kind:'open_profile',summary:'Ready',impact:'low'}]);
 await Promise.all([first,second]);assert.ok(all(root).some(el=>el.textContent==='Ready'));assert.equal(view.suggestionsInFlight,false);
 const pending=view.renderSuggestionsTab(root,{force:true});const oldSurface=root.children[0];root.empty();oldSurface.isConnected=false;view.activeTab='chat';root.createDiv({text:'new draft'});
 finish([]);await pending;assert.deepEqual(root.children.map(el=>el.textContent),['new draft']);
});

test('late scroll events from a removed pane cannot reset the current reading state',async()=>{
 const view=new SidebarDockView({app:{}},{settings:structuredClone(DEFAULT_SETTINGS)});
 const root=host.createElement('div');view.contentContainer=root;
 const pane=root.createDiv({cls:'tm-chat-messages'});Object.assign(pane,{isConnected:true,clientHeight:200,scrollHeight:1000,scrollTop:0});
 view.bindChatViewport(pane,host.createElement('button'));await new Promise(resolve=>setTimeout(resolve,10));
 pane.scrollTop=120;pane.dispatchEvent({type:'scroll'});view.captureChatViewport();
 pane.isConnected=false;pane.scrollTop=0;pane.clientHeight=0;pane.scrollHeight=0;pane.dispatchEvent({type:'scroll'});
 assert.deepEqual(view.chatViewport,{top:120,follow:false});
});
