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
  assert.match(config, /reconnect:\r?\n\s+enabled: true/);
  assert.doesNotMatch(config, /API_KEY|deepseek\.txt/i);
});

test('Harness documentation distinguishes dependency install from composition entry', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../../adapters/deepseek-harness/README.md'), 'utf8');
  assert.match(readme, /plugin --profile headless add @deepseek-ai\/dsh-mcp-client/);
  assert.match(readme, /can be passed directly to DSH/);
  assert.match(readme, /Node\.js `\^22\.19\.0` or `>=24`/);
});

test('Harness verification script checks the exact low-token tool surface', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'verify-deepseek-harness.js'), 'utf8');
  for (const name of ['computer_cancel', 'computer_inspect', 'computer_invoke', 'computer_state', 'computer_verify', 'shortcut_run']) {
    assert.match(source, new RegExp(`mcp__computer_use_plus__${name}`));
  }
  assert.match(source, /DSH_TELEMETRY_MODE/);
  assert.match(source, /expectedShortTools/);
  assert.match(source, /--dump-config/);
  assert.match(source, /computer_state exactly once/);
  assert.match(source, /harness_computer_state_invalid/);
  assert.doesNotMatch(source, /deepseek\.txt/i);
});

test('migration guide separates normal MCP and Harness tool names without key migration', () => {
  const guide = fs.readFileSync(path.join(__dirname, '../../docs/migration.md'), 'utf8');
  assert.match(guide, /D:\\projects\\computer-use-plus/);
  assert.match(guide, /computer\.invoke/);
  assert.match(guide, /shortcut_run/);
  assert.match(guide, /不要迁移或扫描旧 key/);
  assert.doesNotMatch(guide, /deepseek\.txt/i);
});
