import test from 'node:test';
import assert from 'node:assert/strict';
import { AiTaskManager } from '../src/services/ai-task-manager.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('a returned operation failure is an error, with a retryable explanation', async () => {
  const manager = new AiTaskManager();
  manager.enqueue('todo', 'Todos', async () => ({ ok: false, summary: 'provider unavailable' }));
  await tick();
  assert.equal(manager.getProgress().recent[0].status, 'error');
  assert.equal(manager.getProgress().recent[0].error, 'provider unavailable');
});

test('abort discards the late result and keeps the queue serial', async () => {
  const manager = new AiTaskManager();
  const first = deferred();
  let secondStarted = false;
  manager.enqueue('first', 'First', () => first.promise);
  manager.abort();
  manager.enqueue('second', 'Second', async () => { secondStarted = true; return { ok: true, summary: 'second' }; });
  assert.equal(secondStarted, false);
  first.resolve({ ok: true, summary: 'late' });
  await tick();
  assert.equal(secondStarted, true);
  assert.deepEqual(manager.getProgress().recent.map(t => t.status), ['aborted', 'done']);
});

test('completion from a reset generation cannot release a new running lane', async () => {
  const manager = new AiTaskManager();
  const old = deferred();
  const current = deferred();
  let thirdStarted = false;
  manager.enqueue('old', 'Old', () => old.promise);
  manager.reset();
  manager.enqueue('current', 'Current', () => current.promise);
  manager.enqueue('third', 'Third', async () => { thirdStarted = true; return { ok: true, summary: 'third' }; });
  old.resolve({ ok: true, summary: 'old' });
  await tick();
  assert.equal(thirdStarted, false);
  assert.equal(manager.getProgress().active.operation, 'current');
  current.resolve({ ok: true, summary: 'current' });
  await tick();
  assert.equal(thirdStarted, true);
  assert.deepEqual(manager.getProgress().recent.map(t => t.operation), ['current', 'third']);
});

test('abort and reset propagate cooperative cancellation to the executor',async()=>{
 const manager=new AiTaskManager();const result=deferred();let control;
 manager.enqueue('operation','Operation',async token=>{control=token;return result.promise;});
 assert.equal(control.shouldAbort(),false);manager.abort();assert.equal(control.shouldAbort(),true);
 result.resolve({ok:false,summary:'cancelled'});await tick();
});
