'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ComputerEngine } = require('../../src/engine');
const { MockDriver } = require('../../src/drivers/mock');
const { PtcRunner } = require('../../src/ptc-runner');

function runner() {
  const engine = new ComputerEngine({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cup-ptc-')), driver: new MockDriver(), providerReloadIntervalMs: 0 });
  return { engine, ptc: new PtcRunner(engine) };
}

test('PTC composes local state and verify calls in one bounded execution', async () => {
  const { engine, ptc } = runner();
  try {
    const output = await ptc.run({ code: "const state = await tools.call('computer_state', {}); return { windows: state.windows.length };" });
    assert.equal(output.result.windows, 1);
    assert.equal(output.steps, 1);
  } finally { await engine.close(); }
});

test('PTC rejects unavailable capabilities and enforces step budget', async () => {
  const { engine, ptc } = runner();
  try {
    await assert.rejects(() => ptc.run({ code: "return tools.call('computer_act', {});", capabilities: ['computer_act'] }), /ptc_capability_not_available/);
    await assert.rejects(() => ptc.run({ maxSteps: 1, code: "await tools.call('computer_state', {}); await tools.call('computer_state', {});" }), /ptc_step_budget_exceeded/);
  } finally { await engine.close(); }
});

test('PTC sandbox does not provide process, require or arbitrary network tools', async () => {
  const { engine, ptc } = runner();
  try {
    const processType = await ptc.run({ code: "return typeof process;" });
    const requireType = await ptc.run({ code: "return typeof require;" });
    assert.equal(processType.result, 'undefined');
    assert.equal(requireType.result, 'undefined');
  } finally { await engine.close(); }
});
