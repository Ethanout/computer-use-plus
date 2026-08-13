'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RiskPolicy } = require('../../src/risk-policy');

test('risk policy supports allow, confirm, deny and application scoping', () => {
  const policy = new RiskPolicy({ rules: [
    { id: 'deny-pay', decision: 'deny', risk: 'payment', pattern: '支付' },
    { id: 'wechat-send', decision: 'confirm', risk: 'message', pattern: '发送', process: 'wechat' }
  ] });
  assert.equal(policy.evaluate([{ click: { text: '支付' } }], {}).decision, 'deny');
  assert.equal(policy.evaluate([{ click: { text: '发送' } }], { process: 'WeChat.exe' }).decision, 'confirm');
  assert.equal(policy.evaluate([{ click: { text: '发送' } }], { process: 'notepad.exe' }).decision, 'allow');
});

test('all-side-effects mode confirms otherwise unmatched input', () => {
  const policy = new RiskPolicy({ mode: 'all-side-effects', rules: [] });
  const result = policy.evaluate([{ kbseq: ['ESC'] }], { window: '1' });
  assert.equal(result.decision, 'confirm');
  assert.equal(result.summary.actionTypes[0], 'kbseq');
});
