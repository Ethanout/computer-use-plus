'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentRuntime } = require('../../src/agent-runtime');
const { ComputerEngine } = require('../../src/engine');
const { MockDriver } = require('../../src/drivers/mock');
const { MemoryStore } = require('../../src/memory');

function fakeEngine(overrides = {}) {
  const calls = [];
  const engine = {
    driver: {
      async listWindows() {
        return overrides.windows || [{ id: '1', process: 'QQ', title: 'QQ', className: 'Chrome_WidgetWin' }];
      }
    },
    fastAi: { status: () => ({ configured: true, apiKey: 'must-not-leak' }) },
    executionMode: 'backgroundOnly',
    isolated: true,
    actionClassifier: {},
    ocr: { available: true },
    vision: { available: false },
    validateActionBatch() {},
    riskPolicy: { evaluate: () => ({ decision: 'allow', risks: [], summary: '' }) },
    cancelConfirmation() {},
    async fastAct(args) {
      calls.push(args);
      if (overrides.fastAct) return overrides.fastAct(args);
      return {
        ok: true,
        source: 'local-shortcut',
        shortcut: 'open contacts',
        execution: { execution: { ok: true, actions: [{ ok: true, strategy: 'uia' }], snapshot: 'private' } }
      };
    }
  };
  return { engine, calls };
}

test('agent.run resolves a unique fuzzy window scope and returns a compact result', async () => {
  const { engine, calls } = fakeEngine();
  const runtime = new AgentRuntime(engine);
  const output = await runtime.run({ goal: '打开联系人', windowScope: 'qq', budget: { maxSeconds: 2, maxActions: 4 } });
  assert.equal(output.ok, true);
  assert.equal(output.status, 'completed');
  assert.equal(output.window, '1');
  assert.equal(output.actions, 1);
  assert.equal(output.strategy, 'uia');
  assert.equal(output.externalRoundTrips, 1);
  assert.equal(calls[0].maxActions, 4);
  assert.doesNotMatch(JSON.stringify(output), /snapshot|must-not-leak/);
});

test('agent.run reports compact candidates instead of guessing an ambiguous window', async () => {
  const { engine, calls } = fakeEngine({ windows: [
    { id: '1', process: 'QQ', title: 'QQ A', className: 'QQ' },
    { id: '2', process: 'QQ', title: 'QQ B', className: 'QQ' }
  ] });
  const runtime = new AgentRuntime(engine);
  const output = await runtime.run({ goal: '打开联系人', windowScope: { process: 'qq' } });
  assert.equal(output.status, 'needs_reasoning');
  assert.equal(output.needs_reasoning, 'window_ambiguous');
  assert.deepEqual(output.candidates.map((item) => item.id), ['1', '2']);
  assert.equal(calls.length, 0);
});

test('agent.run rejects an unknown explicit window without falling back to another window', async () => {
  const { engine } = fakeEngine();
  const runtime = new AgentRuntime(engine);
  const output = await runtime.run({ goal: 'test', window: 'missing' });
  assert.equal(output.needs_reasoning, 'window_not_found');
});

test('async agent task can be observed and cancelled before a later action', async () => {
  const { engine } = fakeEngine({
    fastAct: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  const runtime = new AgentRuntime(engine);
  const started = await runtime.run({ goal: 'wait', window: '1', async: true });
  assert.equal(started.status, 'running');
  const cancelled = runtime.cancel({ taskId: started.taskId });
  assert.equal(cancelled.cancelled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.status({ taskId: started.taskId }).status, 'cancelled');
});

test('agent task enforces wall-clock timeout', async () => {
  const { engine } = fakeEngine({
    fastAct: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  const runtime = new AgentRuntime(engine);
  const output = await runtime.run({ goal: 'wait', window: '1', budget: { maxSeconds: 0.05 } });
  assert.equal(output.status, 'failed');
  assert.equal(output.reason, 'task_timeout');
});

test('shortcut expansion cannot exceed the agent action budget', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-agent-budget-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  memory.recordWorkflow('two steps', 'mock|mock', [{ keys: ['A'] }, { keys: ['B'] }]);
  const engine = new ComputerEngine({ driver: new MockDriver(), memory, actionClassifier: false });
  const runtime = new AgentRuntime(engine);
  const output = await runtime.run({ goal: 'two steps', shortcut_id: 'two steps', window: 'mock-1', budget: { maxActions: 1 } });
  assert.equal(output.status, 'needs_reasoning');
  assert.equal(output.needs_reasoning, 'action_budget_exceeded');
  clearInterval(engine.maintenanceTimer);
});

test('high-risk shortcut remains behind the existing confirmation gate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-agent-confirm-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  memory.recordWorkflow('submit', 'mock|mock', [{ click: { text: 'Submit' } }]);
  const riskPolicy = { evaluate: () => ({ decision: 'confirm', risks: ['external_side_effect'], rules: ['test'], summary: 'confirm test' }) };
  const engine = new ComputerEngine({ driver: new MockDriver(), memory, actionClassifier: false, riskPolicy });
  const runtime = new AgentRuntime(engine);
  const first = await runtime.run({ goal: 'submit', shortcut_id: 'submit', window: 'mock-1' });
  assert.equal(first.status, 'waiting_confirmation');
  assert.equal(first.requiresConfirmation, true);
  assert.ok(first.confirmation.token);
  const confirmed = await runtime.run({ goal: 'submit', shortcut_id: 'submit', window: 'mock-1', confirm_token: first.confirmation.token });
  assert.equal(confirmed.status, 'completed');
  clearInterval(engine.maintenanceTimer);
});

test('agent capabilities never expose provider secrets', () => {
  const { engine } = fakeEngine();
  const runtime = new AgentRuntime(engine);
  const output = runtime.capabilities();
  assert.equal(output.routing.fastAiConfigured, true);
  assert.doesNotMatch(JSON.stringify(output), /must-not-leak|apiKey/i);
});

test('bounded task storage evicts old terminal tasks', async () => {
  const { engine } = fakeEngine();
  const runtime = new AgentRuntime(engine, { maxTasks: 2 });
  const first = await runtime.run({ goal: 'one', window: '1' });
  await runtime.run({ goal: 'two', window: '1' });
  await runtime.run({ goal: 'three', window: '1' });
  assert.equal(runtime.tasks.size, 2);
  assert.equal(runtime.status({ taskId: first.taskId }).reason, 'task_not_found');
});

test('agent runtime close cancels active tasks', async () => {
  const { engine } = fakeEngine({
    fastAct: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  });
  const runtime = new AgentRuntime(engine);
  const started = await runtime.run({ goal: 'wait', window: '1', async: true });
  await runtime.close();
  assert.equal(runtime.status({ taskId: started.taskId }).status, 'cancelled');
});

test('optional internal intervention resumes only a returned window candidate at the current revision', async () => {
  const { engine, calls } = fakeEngine({ windows: [
    { id: '1', process: 'QQ', title: 'QQ A', className: 'QQ' },
    { id: '2', process: 'QQ', title: 'QQ B', className: 'QQ' }
  ] });
  const runtime = new AgentRuntime(engine, { internalEnabled: true });
  const ambiguous = await runtime.run({ goal: 'open contacts', windowScope: 'qq' });
  const stale = runtime.internal({ taskId: ambiguous.taskId, op: 'select-window', revision: ambiguous.revision - 1, window: '2' });
  assert.equal(stale.reason, 'revision_conflict');
  const invalid = runtime.internal({ taskId: ambiguous.taskId, op: 'select-window', revision: ambiguous.revision, window: '9' });
  assert.equal(invalid.reason, 'window_not_in_candidate_set');
  const resumed = runtime.internal({ taskId: ambiguous.taskId, op: 'select-window', revision: ambiguous.revision, window: '2' });
  assert.equal(resumed.window, '2');
  await new Promise((resolve) => setImmediate(resolve));
  const completed = runtime.status({ taskId: ambiguous.taskId });
  assert.equal(completed.status, 'completed');
  assert.equal(calls[0].window, '2');
});

test('internal intervention is disabled unless the connection profile enables it', () => {
  const { engine } = fakeEngine();
  const runtime = new AgentRuntime(engine);
  assert.throws(() => runtime.internal({ taskId: 'x', op: 'inspect' }), /agent_internal_disabled/);
});

test('intervention profile can pause, inspect, replace and resume a safe candidate', async () => {
  const { engine, calls } = fakeEngine({
    fastAct: async ({ beforeAction }) => {
      const decision = await beforeAction({ index: 0, total: 1, action: { click: { text: 'Blue' } } });
      calls.push(decision);
      return { ok: true, source: 'local', execution: { actions: [{ ok: true, strategy: 'uia' }] } };
    }
  });
  const runtime = new AgentRuntime(engine, { internalEnabled: true });
  const started = await runtime.run({ goal: 'click blue', window: '1', async: true, pauseBeforeActions: true });
  await new Promise((resolve) => setImmediate(resolve));
  const paused = runtime.status({ taskId: started.taskId });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.currentStep.actionType, 'click');
  const inspect = runtime.internal({ taskId: started.taskId, op: 'inspect' });
  const replaced = runtime.internal({ taskId: started.taskId, op: 'replace-action', revision: inspect.revision, action: { click: { text: 'Green' } } });
  assert.equal(replaced.status, 'paused');
  await runtime.tasks.get(started.taskId).promise;
  assert.equal(runtime.status({ taskId: started.taskId }).status, 'completed');
  assert.deepEqual(calls[1], { action: { click: { text: 'Green' } } });
});

test('paused action can be skipped and cancellation wakes the waiter', async () => {
  let invoked = 0;
  const { engine } = fakeEngine({
    fastAct: async ({ beforeAction, signal }) => {
      const decision = await beforeAction({ index: 0, total: 1, action: { wait: { seconds: 1 } }, signal });
      if (!decision?.skip) invoked += 1;
      return { ok: true, source: 'local', execution: { actions: [] } };
    }
  });
  const runtime = new AgentRuntime(engine, { internalEnabled: true });
  const started = await runtime.run({ goal: 'wait', window: '1', async: true, pauseBeforeActions: true });
  await new Promise((resolve) => setImmediate(resolve));
  const paused = runtime.status({ taskId: started.taskId });
  const skipped = runtime.internal({ taskId: started.taskId, op: 'skip-action', revision: paused.revision });
  assert.equal(skipped.status, 'paused');
  await runtime.tasks.get(started.taskId).promise;
  assert.equal(invoked, 0);

  const second = await runtime.run({ goal: 'wait again', window: '1', async: true, pauseBeforeActions: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.status({ taskId: second.taskId }).status, 'paused');
  runtime.cancel({ taskId: second.taskId });
  await runtime.tasks.get(second.taskId).promise;
  assert.equal(runtime.status({ taskId: second.taskId }).status, 'cancelled');
});

test('window policy blocks a reused handle whose application identity changed', async () => {
  const { engine } = fakeEngine({ windows: [{ id: '1', process: 'QQ', title: 'QQ', className: 'A' }] });
  const runtime = new AgentRuntime(engine, { allowedWindows: [{ process: 'qq', className: 'a' }] });
  const output = await runtime.run({ goal: 'test', window: '1' });
  assert.equal(output.status, 'completed');
  engine.driver.listWindows = async () => [{ id: '1', process: 'Other', title: 'QQ', className: 'A' }];
  const second = await runtime.run({ goal: 'test', window: '1' });
  assert.equal(second.status, 'needs_reasoning');
  assert.equal(second.needs_reasoning, 'window_not_permitted');
});
