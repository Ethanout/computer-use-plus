'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FastAiClient, DEFAULT_SYSTEM_PROMPT } = require('../../src/fast-ai');

test('fast AI is explicitly disabled without an API key', async () => {
  const client = new FastAiClient({ apiKey: '', apiKeyFile: '', fetch: async () => { throw new Error('must_not_call'); } });
  assert.equal(client.status().configured, false);
  await assert.rejects(() => client.plan({ goal: 'test', snapshot: {} }), /fast_ai_not_configured/);
});

test('fast AI accepts fractional-second wait plans and does not expose its key', async () => {
  let request;
  const client = new FastAiClient({
    apiKey: 'secret-test-key',
    model: 'mock-fast',
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ model: 'mock-fast', choices: [{ message: { content: '{"actions":[{"wait":{"seconds":"{{mywait}}"}}]}' } }] })
      };
    }
  });

  const plan = await client.plan({ goal: 'test', params: { mywait: 0.3 }, snapshot: {} });
  assert.equal(plan.actions[0].wait.seconds, '{{mywait}}');
  assert.match(request.messages[0].content, /wait\.seconds/);
  assert.equal(JSON.stringify(client.status()).includes('secret-test-key'), false);
  assert.equal(DEFAULT_SYSTEM_PROMPT.includes('只有 kbops.at 使用毫秒'), true);
});

test('organizer validates bounded merge, rename and archive operations', async () => {
  const client = new FastAiClient({
    apiKey: 'secret-test-key',
    fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"operations":[{"op":"merge","keep":"a","remove":["b"]},{"op":"archive","name":"old"}]}' } }] }) })
  });
  const output = await client.organize({ candidates: [] });
  assert.equal(output.operations.length, 2);
  assert.equal(output.operations[0].op, 'merge');
});

test('shared AI key can be read from a user-managed file without appearing in status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-key-file-'));
  const keyFile = path.join(dir, 'provider-key.txt');
  fs.writeFileSync(keyFile, 'secret-from-file\n', 'utf8');
  const client = new FastAiClient({ apiKey: '', apiKeyFile: keyFile, fetch: async () => ({ ok: true }) });
  assert.equal(client.status().configured, true);
  assert.equal(JSON.stringify(client.status()).includes('secret-from-file'), false);
});
