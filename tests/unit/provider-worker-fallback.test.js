'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ComputerEngine } = require('../../src/engine');
const { MockDriver } = require('../../src/drivers/mock');

test('provider worker failure returns needs_reasoning while local engine stays usable', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-provider-fallback-'));
  const engine = new ComputerEngine({
    dataDir,
    driver: new MockDriver(),
    providerWorker: true,
    providerWorkerOptions: { env: { CUP_PROVIDER_WORKER_FAKE: '0' }, command: process.execPath, args: [path.join(__dirname, '../../src/provider-worker.js')] },
    providerReloadIntervalMs: 0,
    memory: { stats: () => ({ records: 0 }), lookup: () => null, shouldObserve: () => false, predict: () => null }
  });
  try {
    const state = await engine.state();
    assert.ok(state.windows);
    const response = await engine.fastAct({ window: 'mock-1', goal: '打开未知页面' });
    assert.equal(response.ok, false);
    assert.equal(response.reason, 'needs_reasoning');
    assert.ok((await engine.state()).windows);
  } finally { await engine.close(); }
});
