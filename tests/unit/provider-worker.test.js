'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProviderWorkerClient, serializableArgs } = require('../../src/provider-worker-client');
const { ProviderConfigStore } = require('../../src/provider-config');
const { ComputerEngine } = require('../../src/engine');
const { MockDriver } = require('../../src/drivers/mock');

test('provider worker reuses one isolated process and dispatches a completed call locally', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-provider-worker-'));
  const client = new ProviderWorkerClient({ dataDir, env: { CUP_PROVIDER_WORKER_FAKE: '1' } });
  let dispatched = null;
  try {
    const first = await client.plan({ goal: 'noop' });
    const pid = client.status().pid;
    const second = await client.planToolCallStream({ goal: 'cancel', onToolCall: async (call) => { dispatched = call; } });
    assert.deepEqual(first.actions, []);
    assert.equal(second.name, 'computer.cancel');
    assert.equal(dispatched.name, 'computer.cancel');
    assert.equal(client.status().pid, pid);
    assert.equal(client.status().configured, true);
  } finally { await client.close(); }
});

test('provider worker status reads only public key metadata before startup', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-provider-worker-status-'));
  const keyFile = path.join(dataDir, 'key.txt');
  fs.writeFileSync(keyFile, 'secret-never-returned');
  const store = new ProviderConfigStore(path.join(dataDir, 'providers.json'));
  store.upsert({ id: 'test', baseUrl: 'https://example.test/v1', model: 'quick', protocol: 'openai', apiKey: { type: 'file', path: keyFile } });
  store.activate('test');
  const client = new ProviderWorkerClient({ dataDir, configStore: store });
  const serialized = JSON.stringify(client.status());
  assert.equal(client.status().configured, true);
  assert.equal(client.status().model, 'quick');
  assert.equal(serialized.includes('secret-never-returned'), false);
  assert.equal(serialized.includes(keyFile), false);
});

test('provider IPC strips callbacks and abort signals', () => {
  const controller = new AbortController();
  assert.deepEqual(serializableArgs({ goal: 'x', onToolCall() {}, signal: controller.signal }), { goal: 'x' });
});

test('engine keeps local state available when provider worker has no profile', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-provider-worker-engine-'));
  const engine = new ComputerEngine({ dataDir, driver: new MockDriver(), providerWorker: true, providerReloadIntervalMs: 0 });
  try {
    const state = await engine.state();
    assert.ok(Array.isArray(state.windows));
    assert.equal(state.capabilities.fastAi.configured, false);
    assert.equal(state.capabilities.fastAi.running, false);
  } finally { await engine.close(); }
});
