'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BenchmarkMatrixRunner } = require('../../src/benchmark-matrix');

test('benchmark matrix resolves suites from its base directory and cleans each engine', async () => {
  const loaded = [];
  const closed = [];
  const destroyed = [];
  const runner = new BenchmarkMatrixRunner({
    baseDir: 'C:/matrix',
    load(file) {
      loaded.push(file);
      return { name: 'fixture', application: 'test', tasks: [{ id: 'noop', steps: [{ tool: 'computer.state', arguments: {} }] }] };
    },
    async createEngine(profile) {
      return {
        profile,
        metrics: {},
        async state() { return { ok: true }; },
        async close() { closed.push(profile.id); },
        execution: { async destroy() { destroyed.push(profile.id); } }
      };
    },
    platform: 'win32'
  });

  const result = await runner.run({
    name: 'matrix',
    profiles: [{ id: 'one', suite: 'edge.json' }, { id: 'two', suite: 'C:/other.json' }]
  }, { dryRun: false });

  assert.equal(result.ok, true);
  assert.deepEqual(loaded, [path.resolve('C:/matrix/edge.json'), 'C:/other.json']);
  assert.deepEqual(closed, ['one', 'two']);
  assert.deepEqual(destroyed, ['one', 'two']);
});
