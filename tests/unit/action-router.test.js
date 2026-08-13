'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveShortcutWithClassifier } = require('../../src/action-router');

function memory() {
  const workflows = [
    { id: 'switch_pack', name: '切换资源包', aliases: ['换材质'], actions: [] },
    { id: 'open_settings', name: '打开设置', aliases: [], actions: [] }
  ];
  return {
    findWorkflow(name) { return workflows.find((item) => item.id === name || item.name === name) || null; },
    listWorkflows() { return workflows; }
  };
}

test('action router prefers deterministic matches without calling classifier', async () => {
  let calls = 0;
  const result = await resolveShortcutWithClassifier(memory(), 'minecraft', '切换资源包', {
    classifier: { async classify() { calls += 1; return { id: 'open_settings', confidence: 1 }; } }
  });
  assert.equal(result.shortcut.id, 'switch_pack');
  assert.equal(result.source, 'local-match');
  assert.equal(calls, 0);
});

test('action classifier can select only a known shortcut above threshold', async () => {
  const accepted = await resolveShortcutWithClassifier(memory(), 'minecraft', '帮我换成另一个材质', {
    threshold: 0.8,
    classifier: { async classify({ candidates }) { assert.equal(candidates.length, 2); return { id: 'switch_pack', confidence: 0.91 }; } }
  });
  assert.equal(accepted.shortcut.id, 'switch_pack');
  assert.equal(accepted.source, 'classifier');

  const low = await resolveShortcutWithClassifier(memory(), 'minecraft', '不确定操作', {
    threshold: 0.8,
    classifier: { async classify() { return { id: 'switch_pack', confidence: 0.4 }; } }
  });
  assert.equal(low.shortcut, null);
  assert.equal(low.source, 'classifier-rejected');

  const unknown = await resolveShortcutWithClassifier(memory(), 'minecraft', '未知', {
    classifier: { async classify() { return { id: 'invented', confidence: 1 }; } }
  });
  assert.equal(unknown.shortcut, null);
  assert.equal(unknown.source, 'classifier-unknown-id');
});
