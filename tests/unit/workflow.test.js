'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeKind } = require('../../src/workflow');

const click = (text) => ({ click: { text, role: 'button' } });
const wait = (seconds) => ({ wait: { seconds } });
const keys = (...values) => ({ kbseq: values });

function workflow(name, scopeKey, actions, extra = {}) {
  return { name, scopeKey, windowKey: scopeKey, actions, uses: 3, beforeFingerprint: 'before', afterFingerprint: 'after', ...extra };
}

test('conservative matcher accepts parameter and wait variants but rejects side-effect variants', () => {
  const base = workflow('base', 'single|minecraft', [keys('ESC'), click('Options'), click('Done')]);
  const waitVariant = workflow('wait', 'single|minecraft', [keys('ESC'), click('Options'), wait(0.3), click('Done')], { uses: 2 });
  const clickVariant = workflow('click', 'single|minecraft', [keys('ESC'), click('Options'), click('Resource Packs'), click('Done')], { uses: 2 });
  assert.equal(mergeKind(base, waitVariant), 'safe-wait-variant');
  assert.equal(mergeKind(base, clickVariant), null);
});

test('single-window and ordered cross-window scopes are hard isolation boundaries', () => {
  const actions = [keys('ENTER')];
  const single = workflow('single', 'single|chrome', actions);
  const cross = workflow('cross', 'cross|chrome>explorer', actions);
  const reverse = workflow('reverse', 'cross|explorer>chrome', actions);
  assert.equal(mergeKind(single, cross), null);
  assert.equal(mergeKind(cross, reverse), null);
});

test('seeded random and mixed records do not trigger unsafe local merges', () => {
  let seed = 91027;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pool = [keys('A'), keys('B'), keys('C'), click('Alpha'), click('Beta'), wait(0.2)];
  const records = [];
  for (let index = 0; index < 1000; index += 1) {
    const actions = [];
    const length = 3 + Math.floor(random() * 4);
    for (let action = 0; action < length; action += 1) actions.push(pool[Math.floor(random() * pool.length)]);
    records.push(workflow(`random-${index}`, `single|app-${Math.floor(random() * 8)}`, actions, {
      uses: 2 + Math.floor(random() * 3),
      beforeFingerprint: `before-${Math.floor(random() * 16)}`,
      afterFingerprint: `after-${Math.floor(random() * 16)}`
    }));
  }
  let unsafe = 0;
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      const kind = mergeKind(records[left], records[right]);
      if (kind && !['parameter-equivalent', 'safe-wait-variant'].includes(kind)) unsafe += 1;
    }
  }
  assert.equal(unsafe, 0);
});
