import assert from 'node:assert/strict';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { Type } from 'typebox';
let requests = 0;
let writes = 0;
const events = [];
const model = { id: 'probe', name: 'probe', api: 'openai-completions', provider: 'probe', baseUrl: 'https://invalid.local', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const agent = new Agent({
  initialState: { model, systemPrompt: 'Isolated probe', tools: [{ name: 'write_note', label: 'Write', description: 'Test only', parameters: Type.Object({ path: Type.String() }), execute: async () => { writes++; return { content: [{ type: 'text', text: 'wrote' }] }; } }] },
  beforeToolCall: async () => ({ block: true, reason: 'Kernel policy fence' }),
  streamFn: (_model, context) => {
    requests++;
    if (requests === 2) assert.ok(context.messages.some(m => m.role === 'toolResult' && m.isError));
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: requests === 1 ? 'toolUse' : 'stop', content: requests === 1 ? [{ type: 'toolCall', id: 'call-1', name: 'write_note', arguments: { path: 'test.md' } }] : [{ type: 'text', text: 'Blocked as intended' }] };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason, message });
    stream.end();
    return stream;
  },
});
agent.subscribe(event => events.push(event.type));
await agent.prompt('Edit current note');
assert.equal(writes, 0);
assert.equal(requests, 2);
assert.equal(agent.state.isStreaming, false);
assert.ok(events.includes('tool_execution_end'));
console.log(JSON.stringify({ version: '1.4.0', requests, writes, messages: agent.state.messages.map(m => m.role), events }));
