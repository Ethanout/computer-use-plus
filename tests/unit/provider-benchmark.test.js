'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderBenchmark, estimateCost } = require('../../src/provider-benchmark');

test('provider benchmark reports standard and early streamed dispatch cost without exposing keys', async () => {
  const encoder = new TextEncoder();
  const fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.stream) return { ok: true, body: (async function* () { yield encoder.encode('data: {"choices":[{"delta":{"id":"c1","function":{"name":"computer.inspect","arguments":"{\\"window\\":\\"42\\"}"}}}]}\n\ndata: [DONE]\n\n'); })() };
    return { ok: true, json: async () => ({ model: 'mock', usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'computer.inspect', arguments: '{"window":"42"}' } }] } }] }) };
  };
  const result = await new ProviderBenchmark({ fetch, env: { BENCH_KEY: 'secret-value' } }).run({ repeats: 1, providers: [{ name: 'mock', baseUrl: 'https://example.test/v1', model: 'mock', apiKeyEnv: 'BENCH_KEY', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }] });
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples.every((item) => item.success), true);
  assert.equal(result.summary['mock:standard'].estimatedCostUsd, estimateCost(10, 2, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }));
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test('provider benchmark skips missing keys and blocks the protected key file', async () => {
  const benchmark = new ProviderBenchmark({ env: {} });
  const skipped = await benchmark.run({ providers: [{ name: 'none', baseUrl: 'https://example.test', model: 'x', apiKeyEnv: 'MISSING' }] });
  assert.equal(skipped.samples[0].configured, false);
  await assert.rejects(() => benchmark.run({ providers: [{ name: 'blocked', baseUrl: 'https://example.test', model: 'x', apiKeyFile: 'C:\\重要的资料\\身份认证和各种key\\deepseek.txt' }] }), /key_file_blocked/);
});
