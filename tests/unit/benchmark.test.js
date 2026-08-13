'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BenchmarkRecorder } = require('../../src/benchmark');

test('benchmark summarizes success, latency, token, screenshot and classifier cost', () => {
  const recorder = new BenchmarkRecorder({ model: 'mock' });
  recorder.record({ name: 'a', application: 'edge', strategy: 'cdp', success: true, latencyMs: 100, inputTokens: 10, classifierCalls: 1, classifierHits: 1, classifierLatencyMs: 8, shortcutHits: 1, strategyCounts: { cdp: 2 } });
  recorder.record({ name: 'b', application: 'edge', strategy: 'cdp', success: false, latencyMs: 300, screenshots: 1, screenshotBytes: 1000, classifierCalls: 1, classifierLatencyMs: 12, ocrCalls: 1, strategyCounts: { ocr: 1 } });
  const summary = recorder.summary();
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.latencyMs.p50, 100);
  assert.equal(summary.latencyMs.p95, 300);
  assert.equal(summary.totals.inputTokens, 10);
  assert.equal(summary.totals.screenshotBytes, 1000);
  assert.equal(summary.classifier.hitRate, 0.5);
  assert.equal(summary.classifier.averageLatencyMs, 10);
  assert.equal(summary.totals.shortcutHits, 1);
  assert.equal(summary.totals.ocrCalls, 1);
  assert.deepEqual(summary.routes, { cdp: 2, ocr: 1 });
});
