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

test('screenshot coordinate grid schema stays bounded', () => {
  const screenshot = TOOLS.find((tool) => tool.name === 'computer.screenshot');
  const properties = screenshot.inputSchema.properties;
  assert.equal(properties.coordinateGrid.type, 'boolean');
  assert.deepEqual(properties.tickPixels, {
    type: 'integer',
    minimum: 50,
    maximum: 500,
    description: '坐标标尺刻度间距，默认 100 像素。'
  });
});
