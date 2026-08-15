'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ComponentManager } = require('../../src/component-manager');
const { ComponentWorkerManager } = require('../../src/component-worker-manager');

test('component manager installs, activates and uninstalls a verified manifest', async () => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cup-components-'));
  const payload = Buffer.from('component payload\n');
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const manager = new ComponentManager({ rootDir, maxDownloadBytes: 1024 * 1024 });
  const result = await manager.install({ id: 'ocr', version: '1.0.0', url: 'https://example.invalid/ocr.bin', size: payload.length, sha256 }, {
    fetch: async () => ({ ok: true, status: 200, body: (async function* () { yield payload; })() })
  });
  assert.equal(result.active, true);
  assert.equal(manager.list().active.ocr, '1.0.0');
  assert.equal((await manager.uninstall('ocr')).removed, true);
  assert.equal(manager.list().active.ocr, undefined);
});

test('component manager exposes only capabilities from active verified manifests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-components-cap-'));
  const manager = new ComponentManager({ rootDir: dir });
  const payload = Buffer.from('omniparser');
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const fetchImpl = async () => ({ ok: true, status: 200, body: (async function* () { yield payload; })() });
  await manager.install({ id: 'vision', version: '1', url: 'https://example.test/vision', size: payload.length, sha256, capabilities: ['omniparser-detector', 'caption'] }, { fetch: fetchImpl });
  assert.deepEqual(manager.activeCapabilities(), ['caption', 'omniparser-detector']);
});

test('component workers start only from active verified runtime manifests and are reclaimed', async () => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cup-components-worker-'));
  const workerSource = Buffer.from("process.send({type:'ready',protocolVersion:'1'}); process.on('message',m=>{if(m.type==='request')process.send({type:'response',id:m.id,result:{ok:true}})});\n");
  const sha256 = crypto.createHash('sha256').update(workerSource).digest('hex');
  const manager = new ComponentManager({ rootDir });
  await manager.install({ id: 'detector', version: '1.0.0', url: 'https://example.invalid/detector.js', fileName: 'worker.js', size: workerSource.length, sha256, capabilities: ['omniparser-detector'], runtime: { entrypoint: 'worker.js' } }, { fetch: async () => ({ ok: true, status: 200, body: (async function* () { yield workerSource; })() }) });
  const workers = new ComponentWorkerManager(manager);
  const started = await workers.start('detector');
  assert.equal(started.ok, true);
  assert.equal(workers.status().detector.running, true);
  assert.deepEqual(await workers.request('detector', { hello: true }), { ok: true });
  assert.equal((await workers.stop('detector')).stopped, true);
  assert.deepEqual(workers.status(), {});
});

test('component manager rejects unsafe URLs, hashes and names before I/O', async () => {
  const manager = new ComponentManager({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cup-components-')) });
  await assert.rejects(() => manager.install({ id: '../x', version: '1', url: 'http://example.invalid/x', size: 1, sha256: '0'.repeat(64) }), /component_name_invalid/);
  await assert.rejects(() => manager.install({ id: 'x', version: '1', url: 'http://example.invalid/x', size: 1, sha256: '0'.repeat(64) }), /component_url_must_be_https/);
  await assert.rejects(() => manager.install({ id: 'x', version: '1', url: 'https://example.invalid/x', size: 1, sha256: 'bad' }), /component_sha256_invalid/);
});

test('component manager rolls back a failed digest without leaving staging files', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-components-'));
  const manager = new ComponentManager({ rootDir });
  await assert.rejects(() => manager.install({ id: 'ocr', version: '1', url: 'https://example.invalid/x', size: 3, sha256: '0'.repeat(64) }, { fetch: async () => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from('bad'); })() }) }), /component_sha256_mismatch/);
  assert.deepEqual(manager.list().installed, []);
});
