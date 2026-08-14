'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ComputerEngine } = require('../../src/engine');
const { MockDriver } = require('../../src/drivers/mock');
const { ScriptRunner } = require('../../src/script-runner');

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-script-'));
  const engine = new ComputerEngine({ dataDir, driver: new MockDriver(), providerReloadIntervalMs: 0 });
  return { engine, runner: new ScriptRunner(engine, { dataDir }) };
}

test('javascript script composes registered tools and cleans its workspace', async () => {
  const { engine, runner } = setup();
  try {
    const result = await runner.run({ language: 'javascript', code: "const state = await api.call('state', {}); return state.windows.length;" });
    assert.equal(result.ok, true);
    assert.equal(result.result, 1);
    assert.equal(fs.readdirSync(path.join(engine.dataDir, 'scripts')).length, 0);
  } finally { await engine.close(); }
});

test('filesystem capability is scoped to the task workspace', async () => {
  const { engine, runner } = setup();
  try {
    const result = await runner.run({ language: 'javascript', capabilities: ['filesystem'], code: "await api.writeFile('x.txt', 'ok'); return await api.readFile('x.txt');" });
    assert.equal(result.result, 'ok');
    await assert.rejects(() => runner.run({ language: 'javascript', capabilities: ['filesystem'], code: "return api.writeFile('../escape.txt', 'x');" }), /script_workspace_escape/);
  } finally { await engine.close(); }
});

test('process capability requires an explicit confirmation proposal', async () => {
  const { engine, runner } = setup();
  try {
    const result = await runner.run({ language: 'powershell', capabilities: ['process', 'filesystem'], code: 'Write-Output ok' });
    assert.equal(result.requiresConfirmation, true);
    assert.ok(result.confirmation.token);
  } finally { await engine.close(); }
});

test('script limits timeout and rejects unknown capabilities', async () => {
  const { engine, runner } = setup();
  try {
    await assert.rejects(() => runner.run({ language: 'javascript', capabilities: ['unknown'], code: 'return 1;' }), /script_capability_unknown/);
    await assert.rejects(() => runner.run({ language: 'javascript', timeoutMs: 100, code: 'await new Promise(() => {});' }), /script_timeout|Script execution timed out/);
  } finally { await engine.close(); }
});
