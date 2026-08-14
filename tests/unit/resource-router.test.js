'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResourceRouter } = require('../../src/resource-router');

test('resource router keeps low-memory or explicit battery paths local', () => {
  const router = new ResourceRouter({ lowMemoryBytes: 1024 });
  assert.equal(router.choose({ resources: { freeMemoryBytes: 10, load1m: 0, battery: { onBattery: false } }, visionAvailable: true, isolated: true }).strategy, 'uia-ocr');
  assert.equal(router.choose({ resources: { freeMemoryBytes: 100000, load1m: 0, battery: { onBattery: true } }, visionAvailable: true, isolated: true }).reason, 'battery_saver');
});

test('resource router selects vision only when it is available and isolated', () => {
  const router = new ResourceRouter();
  assert.equal(router.choose({ resources: { freeMemoryBytes: 10 ** 12, load1m: 0, battery: { onBattery: false } }, visionAvailable: true, isolated: true }).strategy, 'uia-omniparser-vision');
  assert.equal(router.choose({ resources: { freeMemoryBytes: 10 ** 12, load1m: 0, battery: { onBattery: false } }, visionAvailable: false, isolated: false, ocrAvailable: false }).strategy, 'uia');
});

test('resource probe degrades to explicit unknown values when optional probes are unavailable', async () => {
  const result = await new ResourceRouter().probe();
  assert.equal(typeof result.freeMemoryBytes, 'number');
  assert.equal(typeof result.battery.known, 'boolean');
  assert.equal(typeof result.gpu.known, 'boolean');
});
