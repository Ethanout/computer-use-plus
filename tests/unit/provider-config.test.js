'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProviderConfigStore } = require('../../src/provider-config');
const { FastAiClient } = require('../../src/fast-ai');

function fixture(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-provider-'));
  const file = path.join(dir, 'providers.json');
  return { dir, file, store: new ProviderConfigStore(file, { env }) };
}

function profile(overrides = {}) {
  return { id: 'fast', baseUrl: 'https://api.example.test/v1', model: 'fast-model', protocol: 'openai', apiKey: { type: 'env', name: 'TEST_PROVIDER_KEY' }, ...overrides };
}

test('provider config persists only key references and redacts public state', () => {
  const { file, store } = fixture({ TEST_PROVIDER_KEY: 'secret-value' });
  store.upsert(profile(), 0);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('secret-value'), false);
  assert.equal(raw.includes('TEST_PROVIDER_KEY'), true);
  const listed = store.list();
  assert.equal(listed.profiles[0].configured, true);
  assert.equal(listed.profiles[0].keySource, 'env');
  assert.equal(JSON.stringify(listed).includes('TEST_PROVIDER_KEY'), false);
  assert.equal(JSON.stringify(listed).includes('secret-value'), false);
  assert.equal(store.resolve('fast').apiKey, 'secret-value');
});

test('provider config resolves an explicitly selected key file without exposing its path', () => {
  const { dir, store } = fixture();
  const keyFile = path.join(dir, 'provider.key');
  fs.writeFileSync(keyFile, 'file-secret\n', 'utf8');
  store.upsert(profile({ apiKey: { type: 'file', path: keyFile } }), 0);
  assert.equal(store.resolve('fast').apiKey, 'file-secret');
  assert.equal(JSON.stringify(store.list()).includes(keyFile), false);
  assert.equal(JSON.stringify(store.list()).includes('file-secret'), false);
});

test('provider config blocks the protected key file without reading it', () => {
  const protectedPath = 'C:\\' + '\u91cd\u8981\u7684\u8d44\u6599\\' + '\u8eab\u4efd\u8ba4\u8bc1\u548c\u5404\u79cdkey\\deepseek.txt';
  const { store } = fixture();
  assert.throws(() => store.upsert(profile({ apiKey: { type: 'file', path: protectedPath } }), 0), /provider_key_file_blocked/);
});

test('provider config enforces revision and supports activate, replace and remove', () => {
  const { store } = fixture({ TEST_PROVIDER_KEY: 'one' });
  store.upsert(profile(), 0);
  assert.throws(() => store.upsert(profile({ model: 'stale' }), 0), /provider_revision_conflict/);
  assert.deepEqual(store.activate('fast', 1), { ok: true, active: 'fast', revision: 2 });
  store.upsert(profile({ model: 'new-model' }), 2);
  assert.equal(store.resolve().model, 'new-model');
  assert.deepEqual(store.remove('fast', 3), { ok: true, removed: 'fast', revision: 4 });
  assert.equal(store.resolve(), null);
});

test('provider config rejects invalid URL, protocol, model and numeric limits', () => {
  const values = [profile({ baseUrl: 'file:///local' }), profile({ protocol: 'unknown' }), profile({ model: '' }), profile({ timeoutMs: 999 })];
  for (const value of values) {
    const { store } = fixture();
    assert.throws(() => store.upsert(value, 0), /provider_/);
  }
});

test('provider config atomically rewrites valid JSON and leaves no temporary files', () => {
  const { dir, file, store } = fixture();
  store.upsert(profile(), 0);
  store.upsert(profile({ model: 'second' }), 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].model, 'second');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
});

test('an explicitly empty active provider key does not fall back to process environment', () => {
  const previous = process.env.COMPUTER_USE_PLUS_AI_API_KEY;
  process.env.COMPUTER_USE_PLUS_AI_API_KEY = 'fallback-secret';
  try {
    const client = new FastAiClient({ apiKey: '', baseUrl: 'https://api.example.test/v1', model: 'model' });
    assert.equal(client.configured, false);
  } finally {
    if (previous === undefined) delete process.env.COMPUTER_USE_PLUS_AI_API_KEY;
    else process.env.COMPUTER_USE_PLUS_AI_API_KEY = previous;
  }
});
