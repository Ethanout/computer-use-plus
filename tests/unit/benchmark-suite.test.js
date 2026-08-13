'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BenchmarkSuiteRunner } = require('../../src/benchmark-suite');
const { interpolateEnvironment } = require('../../src/benchmark-suite');

const suite = {
  name: 'mock-suite', application: 'mock', requirements: { platform: 'win32', env: ['APP_COMMAND'] },
  tasks: [{ id: 'inspect', strategy: 'uia', repeats: 2, steps: [{ tool: 'computer.state', arguments: { includeUi: true } }, { tool: 'computer.verify', arguments: { window: 'mock-1', assertions: [{ type: 'title', includes: 'Mock' }] } }] }]
};

test('benchmark suite dry-run validates tasks without tool side effects', async () => {
  let calls = 0;
  const runner = new BenchmarkSuiteRunner({ platform: 'win32', env: { APP_COMMAND: 'mock.exe' }, callTool: async () => { calls += 1; } });
  const result = await runner.run(suite, { dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.summary.samples, 2);
  assert.equal(calls, 0);
});

test('benchmark suite reports unmet requirements and rejects unknown tools', async () => {
  const runner = new BenchmarkSuiteRunner({ platform: 'win32', env: {} });
  const result = await runner.run(suite, { dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.requirements.checks[1].passed, false);
  assert.throws(() => runner.validate({ name: 'bad', tasks: [{ id: 'x', steps: [{ tool: 'shell.exec' }] }] }), /benchmark_tool_not_allowed/);
});

test('benchmark suite execute mode records failed MCP steps', async () => {
  const runner = new BenchmarkSuiteRunner({ platform: 'win32', env: { APP_COMMAND: 'mock.exe' }, callTool: async (name) => name === 'computer.state' ? { ok: true } : { ok: false, reason: 'assertion_failed' } });
  const result = await runner.run(suite, { dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(result.tasks[0].failureReason, 'assertion_failed');
  assert.equal(result.summary.totals.mcpRoundTrips, 4);
});

test('benchmark suite treats unmet result expectations as a task failure', async () => {
  const runner = new BenchmarkSuiteRunner({ platform: 'win32', env: { APP_COMMAND: 'mock.exe' }, callTool: async () => ({ ok: true, elements: [] }) });
  const input = { name: 'expect', requirements: { platform: 'win32', env: ['APP_COMMAND'] }, tasks: [{ id: 'x', steps: [{ tool: 'computer.inspect', expect: { minElements: 1 } }] }] };
  const result = await runner.run(input, { dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(result.tasks[0].failureReason, 'benchmark_expected_elements_missing');
});

test('benchmark suite interpolates only declared environment references at execution', async () => {
  let executable = '';
  const runner = new BenchmarkSuiteRunner({ platform: 'win32', env: { APP_COMMAND: 'mock.exe' }, callTool: async (_name, args) => { executable = args.executable; return { ok: true }; } });
  const input = { name: 'interpolate', requirements: { platform: 'win32', env: ['APP_COMMAND'] }, tasks: [{ id: 'x', steps: [{ tool: 'computer.browser', arguments: { executable: '${APP_COMMAND}' } }] }] };
  const result = await runner.run(input, { dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(executable, 'mock.exe');
  assert.equal(interpolateEnvironment('${UNKNOWN}', {}).includes('UNKNOWN'), true);
});
