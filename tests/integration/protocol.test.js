'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS, SERVER_INFO } = require('../../src/protocol');

test('MCP surface stays intentionally small', () => {
  assert.equal(SERVER_INFO.name, 'computer-use-plus');
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    'computer.state', 'computer.inspect', 'computer.wait', 'computer.screenshot',
    'computer.invoke', 'shortcut.run', 'computer.verify', 'computer.cancel',
    'computer.act', 'computer.fast', 'computer.shortcut', 'computer.execution', 'computer.browser'
  ]);
});
