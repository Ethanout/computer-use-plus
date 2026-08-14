'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS, SERVER_INFO, toolsForProfile } = require('../../src/protocol');

test('MCP surface stays intentionally small', () => {
  assert.equal(SERVER_INFO.name, 'computer-use-plus');
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    'agent.run', 'agent.status', 'agent.cancel', 'agent.capabilities',
    'computer.state', 'computer.inspect', 'computer.wait', 'computer.screenshot',
    'computer.invoke', 'shortcut.run', 'computer.verify', 'computer.cancel',
    'computer.act', 'computer.fast', 'computer.shortcut', 'computer.execution', 'computer.browser'
  ]);
});

test('fast-agent profile exposes only the one-call task surface', () => {
  assert.deepEqual(toolsForProfile('fast-agent').map((tool) => tool.name), [
    'agent.run', 'agent.status', 'agent.cancel', 'agent.capabilities'
  ]);
});

test('internal intervention is exposed only by its explicit profile', () => {
  assert.equal(TOOLS.some((tool) => tool.name === 'agent.internal'), false);
  assert.deepEqual(toolsForProfile('intervention-agent').map((tool) => tool.name), [
    'agent.run', 'agent.status', 'agent.cancel', 'agent.capabilities', 'agent.internal'
  ]);
  const defaultRun = TOOLS.find((tool) => tool.name === 'agent.run');
  const intervention = toolsForProfile('intervention-agent');
  const interventionRun = intervention.find((tool) => tool.name === 'agent.run');
  const internal = intervention.find((tool) => tool.name === 'agent.internal');
  assert.equal(defaultRun.inputSchema.properties.pauseBeforeActions, undefined);
  assert.equal(interventionRun.inputSchema.properties.pauseBeforeActions.type, 'boolean');
  assert.deepEqual(internal.inputSchema.properties.op.enum, [
    'inspect', 'audit', 'pause', 'resume', 'replace-action', 'skip-action', 'cancel', 'select-window'
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
