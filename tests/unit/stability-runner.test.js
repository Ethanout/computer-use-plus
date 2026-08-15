'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StabilityRunner } = require('../../src/stability-runner');

test('stability runner rejects side-effect tools and requires a bound', () => {
  const runner = new StabilityRunner();
  assert.throws(() => runner.validate({ task: { tool: 'computer.act' } }), /stability_bound_required/);
  assert.throws(() => runner.validate({ iterations: 1, task: { tool: 'computer.act' } }), /stability_tool_not_allowed/);
});

test('stability runner executes only bounded safe calls, records percentiles and closes the engine', async () => {
  let now = 0;
  let closed = 0;
  let calls = 0;
  const resources = [
    { rss: 100, heapUsed: 10, activeHandles: 2 },
    { rss: 108, heapUsed: 15, activeHandles: 3 }
  ];
  const runner = new StabilityRunner({
    now: () => now,
    getResource: () => resources.shift(),
    createEngine: () => ({ async close() { closed += 1; } }),
    callTool: async (name, args) => { assert.equal(name, 'computer.state'); assert.deepEqual(args, {}); calls += 1; now += calls; }
  });

  const result = await runner.run({ iterations: 3, task: { tool: 'computer.state', arguments: {} }, maxHeapGrowthBytes: 10, maxActiveHandleGrowth: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.samples, 3);
  assert.equal(result.averageLatencyMs, 2);
  assert.equal(result.latencyP50Ms, 2);
  assert.equal(result.latencyP95Ms, 3);
  assert.equal(result.activeHandleGrowth, 1);
  assert.equal(closed, 1);
});

test('duration-only stability runs are not capped by the iterations default', async () => {
  let now = 0;
  const runner = new StabilityRunner({
    now: () => now,
    getResource: () => ({ rss: 0, heapUsed: 0, activeHandles: 0 }),
    createEngine: () => ({ async close() {} }),
    callTool: async () => { now += 10; }
  });

  const result = await runner.run({ durationMs: 100, task: { tool: 'computer.inspect', arguments: {} } });
  assert.equal(result.samples, 10);
});

test('stability runner fails heap or active-handle growth limits and dry runs without creating an engine', async () => {
  let created = 0;
  const runner = new StabilityRunner({
    createEngine: () => { created += 1; return {}; },
    getResource: (() => {
      const values = [{ rss: 1, heapUsed: 1, activeHandles: 1 }, { rss: 3, heapUsed: 3, activeHandles: 4 }];
      return () => values.shift();
    })(),
    callTool: async () => {}
  });
  const result = await runner.run({ iterations: 1, maxHeapGrowthBytes: 1, maxActiveHandleGrowth: 1 });
  assert.equal(result.ok, false);
  assert.equal(created, 1);
  const dryRun = await runner.run({ iterations: 1 }, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(created, 1);
});
