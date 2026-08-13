'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolsForProfile, canonicalToolName } = require('../../src/protocol');

test('harness profile exposes only stable high-level names', () => {
  const tools = toolsForProfile('harness');
  assert.deepEqual(tools.map((tool) => tool.name), [
    'computer_state',
    'computer_inspect',
    'computer_invoke',
    'shortcut_run',
    'computer_verify',
    'computer_cancel'
  ]);
  assert.equal(tools.some((tool) => tool.name.includes('.')), false);
  assert.equal(canonicalToolName('shortcut_run'), 'shortcut.run');
  assert.equal(canonicalToolName('computer_invoke'), 'computer.invoke');
});

test('Harness Cordis entry launches the stdio server in harness profile', () => {
  const config = fs.readFileSync(path.join(__dirname, '../../adapters/deepseek-harness/cordis.yml'), 'utf8');
  assert.match(config, /- insert:\r?\n\s+- id: mcp-computer-use-plus/);
  assert.match(config, /@deepseek-ai\/dsh-mcp-client/);
  assert.match(config, /serverName: computer_use_plus/);
  assert.match(config, /args: \['src\/index\.js'\]/);
  assert.match(config, /COMPUTER_USE_PLUS_TOOL_PROFILE: harness/);
  assert.doesNotMatch(config, /API_KEY|deepseek\.txt/i);
});

test('Harness documentation distinguishes dependency install from composition entry', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../../adapters/deepseek-harness/README.md'), 'utf8');
  assert.match(readme, /plugin --profile headless add @deepseek-ai\/dsh-mcp-client/);
  assert.match(readme, /can be passed directly to DSH/);
  assert.match(readme, /Node\.js `\^22\.19\.0` or `>=24`/);
});
