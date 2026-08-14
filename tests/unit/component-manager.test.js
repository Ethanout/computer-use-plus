'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ComponentManager } = require('../../src/component-manager');

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
