'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rankElements } = require('../../src/matcher');

test('ranks exact semantic text and role first', () => {
  const result = rankElements([
    { name: '保存草稿', role: 'Button' },
    { name: '保存', role: 'Button' },
    { name: '保存', role: 'Text' }
  ], { text: '保存', role: 'button' });
  assert.equal(result[0].name, '保存');
  assert.equal(result.length, 2);
});

test('filters cached automation identifiers and class names before ranking', () => {
  const result = rankElements([
    { name: '保存', role: 'Button', automationId: 'save-old', className: 'Button' },
    { name: '保存', role: 'Button', automationId: 'save-new', className: 'Button' },
    { name: '保存', role: 'Button', automationId: 'save-new', className: 'Other' }
  ], { text: '保存', role: 'button', automationId: 'save-new', className: 'Button' });
  assert.equal(result.length, 1);
  assert.equal(result[0].automationId, 'save-new');
});
