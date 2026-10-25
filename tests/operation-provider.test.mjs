import test from 'node:test';import assert from 'node:assert/strict';
import {cancellableOperationProvider} from '../src/services/operation-provider.ts';
test('cancellation abandons a returned generation before the caller can write it',async()=>{
 let finish;let cancelled=false;let context;
 const provider=cancellableOperationProvider({generate:async(_prompt,ctx)=>{context=ctx;return new Promise(resolve=>{finish=resolve;});}},()=>cancelled);
 const request=provider.generate('prompt',{operation:'todo_maintain',temperature:0.2});
 cancelled=true;finish('model proposed a new task');
 await assert.rejects(request,error=>error.name==='AbortError');
 assert.equal(context.operation,'todo_maintain');assert.equal(context.temperature,0.2);assert.equal(context.shouldAbort(),true);
});
