'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BenchmarkRecorder } = require('../../src/benchmark');

test('benchmark summarizes success, latency, token and screenshot cost', () => {
  const recorder = new BenchmarkRecorder({ model: 'mock' });
  recorder.record({ name: 'a', application: 'edge', strategy: 'cdp', success: true, latencyMs: 100, inputTokens: 10 });
  recorder.record({ name: 'b', application: 'edge', strategy: 'cdp', success: false, latencyMs: 300, screenshots: 1, screenshotBytes: 1000 });
  const summary = recorder.summary();
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.latencyMs.p50, 100);
  assert.equal(summary.latencyMs.p95, 300);
  assert.equal(summary.totals.inputTokens, 10);
  assert.equal(summary.totals.screenshotBytes, 1000);
});
