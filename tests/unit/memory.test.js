'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../../src/memory');

test('memory keeps a bounded recent stack and automatically forgets stale locators', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-memory-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'), { maxRecords: 2, baseTtlMs: 1000, recentLimit: 3 });
  for (let index = 0; index < 4; index += 1) {
    memory.recordSuccess('app|window', { text: `Button ${index}`, role: 'button' }, { automationId: `button-${index}` }, 'clicked');
  }
  assert.equal(memory.stats().records, 2);
  for (const record of memory.records.values()) {
    assert.ok(record.recent.length <= 3);
    record.lastUsedAt = Date.now() - 10000;
  }
  memory.prune();
  assert.equal(memory.stats().records, 0);
});

test('memory records UI transitions without model-controlled learning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-transition-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  const edge = memory.recordTransition('app|window', 'click:button:Open',
    { fingerprint: 'before', nodes: ['button|Open'] },
    { fingerprint: 'after', nodes: ['button|Close', 'text|Ready'] });
  assert.equal(edge.uses, 1);
  assert.deepEqual(edge.appeared, ['button|Close', 'text|Ready']);
  assert.deepEqual(edge.disappeared, ['button|Open']);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
  assert.equal(persisted.version, 4);
  assert.equal(persisted.transitions.length, 1);
});

test('memory emits only sufficiently repeated environment-compatible prediction snapshots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-predict-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'), { predictionMinUses: 2 });
  const before = { fingerprint: 'menu', nodes: [{ role: 'button', name: '资源包' }], environment: { process: 'mc', dpi: 96 } };
  const after = { fingerprint: 'packs', nodes: [{ role: 'button', name: '完成' }], environment: { process: 'mc', dpi: 96 } };
  assert.equal(memory.predict('mc|window', 'click:button:资源包'), null);
  memory.recordTransition('mc|window', 'click:button:资源包', before, after);
  memory.recordTransition('mc|window', 'click:button:资源包', before, after);
  const prediction = memory.predict('mc|window', 'click:button:资源包', { environment: { process: 'mc', dpi: 96 } });
  assert.equal(prediction.source, 'memory');
  assert.equal(prediction.snapshot.fingerprint, 'packs');
  assert.equal(memory.predict('mc|window', 'click:button:资源包', { environment: { process: 'other', dpi: 96 } }), null);
});

test('memory stores parameterized shortcuts and preserves numeric seconds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-workflow-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  memory.recordWorkflow('switch resource pack', 'minecraft|window', [
    { setValue: { label: 'name', value: '{{name}}' } },
    { wait: { seconds: '{{mywait}}' } }
  ], { parameters: { name: 'objmc', mywait: 0.3 }, source: 'main-ai' });

  const workflow = memory.getWorkflow('switch resource pack', 'minecraft|window');
  const actions = MemoryStore.interpolate(workflow.actions, { name: 'other', mywait: 1.5 });
  assert.equal(actions[0].setValue.value, 'other');
  assert.equal(actions[1].wait.seconds, 1.5);
  assert.equal(typeof actions[1].wait.seconds, 'number');
  assert.equal(memory.listWorkflows('minecraft|window').length, 1);
});

test('local consolidation merges repeated safe variants and preserves aliases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-consolidate-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  const metadata = { beforeFingerprint: 'menu', afterFingerprint: 'resource-pack', source: 'main-ai' };
  const base = [{ kbseq: ['ESC'] }, { click: { text: 'Resource Packs', role: 'button' } }, { click: { text: 'Done', role: 'button' } }];
  const waited = [{ kbseq: ['ESC'] }, { click: { text: 'Resource Packs', role: 'button' } }, { wait: { seconds: 0.3 } }, { click: { text: 'Done', role: 'button' } }];
  for (let index = 0; index < 3; index += 1) memory.recordWorkflow('switch resource pack', 'minecraft|window', base, metadata);
  for (let index = 0; index < 2; index += 1) memory.recordWorkflow('change resource pack', 'minecraft|window', waited, metadata);

  assert.equal(memory.stats().workflows, 1);
  const workflow = memory.getWorkflow('change resource pack', 'minecraft|window');
  assert.ok(workflow);
  assert.equal(workflow.aliases.includes('change resource pack'), true);
  assert.equal(workflow.variants, 1);
});

test('workflows from different window scopes never consolidate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-scope-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  const actions = [{ kbseq: ['ENTER'] }];
  const metadata = { beforeFingerprint: 'before', afterFingerprint: 'after' };
  for (let index = 0; index < 3; index += 1) memory.recordWorkflow('confirm', 'app-a|window', actions, metadata);
  for (let index = 0; index < 3; index += 1) memory.recordWorkflow('confirm', 'app-b|window', actions, metadata);
  assert.equal(memory.stats().workflows, 2);
});

test('memory enforces a total serialized byte budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-byte-budget-'));
  const file = path.join(dir, 'memory.json');
  const memory = new MemoryStore(file, { maxBytes: 4096, maxWorkflows: 500 });
  for (let index = 0; index < 100; index += 1) {
    memory.recordWorkflow(`workflow-${index}`, 'app|window', [{ setValue: { label: 'field', value: 'x'.repeat(200) + index } }]);
  }
  assert.ok(fs.statSync(file).size <= 4096);
  assert.ok(memory.stats().workflows < 100);
});

test('memory never writes beyond an extremely small byte budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-byte-budget-min-'));
  const file = path.join(dir, 'memory.json');
  const memory = new MemoryStore(file, { maxBytes: 2 });
  memory.recordWorkflow('tiny', 'app|window', [{ keys: ['ESC'] }]);
  assert.ok(fs.statSync(file).size <= 2);
});
