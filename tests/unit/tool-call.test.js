'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { extractToolCall, ToolCallAccumulator } = require('../../src/tool-call');
const { buildRequest } = require('../../src/providers');
const { ToolCallProvider } = require('../../src/providers');
const { ComputerEngine } = require('../../src/engine');
const { MockDriver } = require('../../src/drivers/mock');
const { MemoryStore } = require('../../src/memory');
const { resolveShortcut } = require('../../src/action-router');

test('normalizes OpenAI, Anthropic and Gemini tool calls', () => {
  const openai = extractToolCall({ choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'computer.invoke', arguments: '{"window":"1","actions":[{"kbseq":["A"]}]}' } }] } }] });
  const anthropic = extractToolCall({ content: [{ type: 'tool_use', id: 'c2', name: 'shortcut.run', input: { window: '1', shortcut_id: 'save' } }] });
  const gemini = extractToolCall({ candidates: [{ content: { parts: [{ functionCall: { name: 'computer.inspect', args: { window: '1' } } }] } }] });
  assert.equal(openai.name, 'computer.invoke');
  assert.equal(anthropic.arguments.shortcut_id, 'save');
  assert.equal(gemini.name, 'computer.inspect');
});

test('assembles streamed tool-call argument fragments', () => {
  const stream = new ToolCallAccumulator();
  stream.push({ delta: { id: 'c1', function: { name: 'computer.invoke', arguments: '{"window":"1",' } } });
  stream.push({ delta: { id: 'c1', function: { arguments: '"actions":[{"kbseq":["A"]}]}' } } });
  const call = stream.complete('c1');
  assert.equal(call.arguments.actions[0].kbseq[0], 'A');
});

test('builds provider-specific native function requests', () => {
  const common = { baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'fast', system: 's', user: {}, tools: [], toolChoice: 'auto' };
  assert.match(buildRequest('responses', common).endpoint, /responses$/);
  assert.equal(buildRequest('anthropic', common).body.messages[0].role, 'user');
  assert.equal(buildRequest('gemini', common).body.tools[0].functionDeclarations.length, 0);
  assert.match(buildRequest('chat-completions', common).headers.authorization, /^Bearer /);
});

test('provider consumes SSE tool-call deltas without exposing prose', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"id":"c1","function":{"name":"computer.invoke","arguments":"{\\"window\\":\\"1\\","}}}]}\n\n',
    'data: {"choices":[{"delta":{"index":0,"function":{"arguments":"\\"actions\\":[{\\"kbseq\\":[\\"A\\"]}]}"}}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const provider = new ToolCallProvider({ apiKey: 'secret', baseUrl: 'https://example.test/v1', model: 'mock', fetch: async () => ({ ok: true, body: (async function* () { for (const chunk of chunks) yield encoder.encode(chunk); })() }) });
  const call = await provider.callStream({ system: 's', user: {} });
  assert.equal(call.name, 'computer.invoke');
  assert.equal(call.arguments.actions[0].kbseq[0], 'A');
});

test('high-risk native actions require a single-use confirmation token', async () => {
  const memory = new MemoryStore(path.join(process.cwd(), '.data-check', `tool-call-${Date.now()}.json`));
  const engine = new ComputerEngine({ driver: new MockDriver(), memory });
  const input = { type: 'tool_call', name: 'computer.invoke', arguments: { window: 'mock-1', actions: [{ click: { text: '发送', role: 'button' } }] } };
  const pending = await engine.invokeToolCall(input);
  assert.equal(pending.requiresConfirmation, true);
  input.arguments.confirm_token = pending.confirmation.token;
  const executed = await engine.invokeToolCall(input);
  assert.equal(executed.ok, true);
  const reused = await engine.invokeToolCall(input);
  assert.equal(reused.requiresConfirmation, true);
});

test('local action router reuses a matching shortcut without a model call', async () => {
  const memory = new MemoryStore(path.join(process.cwd(), '.data-check', `router-${Date.now()}.json`));
  memory.recordWorkflow('切换资源包', 'mock|mock', [{ kbseq: ['ESC'] }], { aliases: ['switch_resource_pack'] });
  assert.equal(resolveShortcut(memory, 'mock|mock', 'switch resource pack').name, '切换资源包');
  let calls = 0;
  const engine = new ComputerEngine({ driver: new MockDriver(), memory, fastAi: { status: () => ({ configured: false }), plan: async () => { calls += 1; throw new Error('must_not_call'); } } });
  const output = await engine.fastAct({ window: 'mock-1', goal: 'switch resource pack' });
  assert.equal(output.source, 'local-shortcut');
  assert.equal(calls, 0);
});
