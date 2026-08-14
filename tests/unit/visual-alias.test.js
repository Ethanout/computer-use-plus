'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VisualAliasStore } = require('../../src/visual-alias');

test('visual aliases require repeated verified observations and stay scope isolated', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cup-alias-')), 'aliases.json');
  const store = new VisualAliasStore(file, { minSuccesses: 3 });
  assert.equal(store.record({ scopeKey: 'qq|main', caption: 'Person', alias: '联系人', success: false }).accepted, false);
  for (let i = 0; i < 3; i += 1) store.record({ scopeKey: 'qq|main', caption: 'Person', alias: '联系人', success: true });
  assert.equal(store.resolve({ scopeKey: 'qq|main', caption: 'person' }).alias, '联系人');
  assert.equal(store.resolve({ scopeKey: 'wechat|main', caption: 'person' }), null);
});
