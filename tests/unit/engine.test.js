'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ComputerEngine } = require('../../src/engine');
const { MockDriver } = require('../../src/drivers/mock');
const { MemoryStore } = require('../../src/memory');

test('act executes a compact action batch and stores a locator', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-'));
  const engine = new ComputerEngine({ driver: new MockDriver(), memory: new MemoryStore(path.join(dir, 'memory.json')) });
  const output = await engine.act({ window: 'mock-1', actions: [{ click: { text: '保存', role: 'button' } }, { keys: ['w', 'a'] }] });
  assert.equal(output.ok, true);
  assert.equal(output.actions.length, 2);
  assert.equal(engine.memory.stats().records, 1);
  assert.ok(engine.memory.lookup('mock|mock', { text: '保存', role: 'button' }));
});

test('encodes function-key shortcuts for Windows SendKeys', () => {
  const engine = new ComputerEngine({ driver: new MockDriver(), memory: { stats: () => ({ records: 0 }) } });
  assert.equal(engine.encodeHotkey(['ALT', 'F4']), '%{F4}');
});

test('accepts compact kbseq and absolute-time kbops actions', async () => {
  const driver = new MockDriver();
  const engine = new ComputerEngine({ driver, memory: { stats: () => ({ records: 0 }) } });
  const output = await engine.act({
    window: 'mock-1',
    actions: [
      { kbseq: ['w', 'a'] },
      { kbops: [{ op: 's', at: 100 }, { op: 'd', at: 250 }] }
    ]
  });
  assert.equal(output.ok, true);
  assert.equal(output.actions.length, 2);
});

test('stale cached locators are demoted before UIA rediscovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-stale-cache-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  const driver = new MockDriver();
  const queries = [];
  driver.click = async (_windowId, query) => {
    queries.push(query);
    if (query.automationId === 'stale') throw new Error('target_not_found');
    return { ok: true, strategy: 'uia.invoke', element: { name: '保存', role: 'button', automationId: 'fresh' } };
  };
  memory.recordSuccess('mock|mock', { text: '保存', role: 'button' }, { automationId: 'stale', role: 'button' }, 'clicked');
  const engine = new ComputerEngine({ driver, memory });

  const output = await engine.act({ window: 'mock-1', actions: [{ click: { text: '保存', role: 'button' } }] });

  assert.equal(output.actions[0].strategy, 'uia.rediscovered');
  assert.equal(queries.some((query) => query.automationId === 'stale'), true);
  assert.equal(queries.some((query) => !query.automationId), true);
  assert.equal(memory.lookup('mock|mock', { text: '保存', role: 'button' }).automationId, 'fresh');
});

test('setValue reuses an automatically learned locator', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-value-cache-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  const driver = new MockDriver();
  let receivedQuery;
  driver.setValue = async (_windowId, query) => {
    receivedQuery = query;
    return { ok: true, strategy: 'uia.value', element: { name: '名称', role: 'edit', automationId: 'nameInput' } };
  };
  memory.recordSuccess('mock|mock', { text: '名称', role: 'edit' }, { automationId: 'nameInput', role: 'edit' }, 'value_set');
  const engine = new ComputerEngine({ driver, memory });

  const output = await engine.act({ window: 'mock-1', actions: [{ setValue: { label: '名称', value: 'alice' } }] });

  assert.equal(output.actions[0].strategy, 'cached-uia.value');
  assert.equal(receivedQuery.automationId, 'nameInput');
});

test('state can return one action-ready UI snapshot with reusable refs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-snapshot-'));
  const engine = new ComputerEngine({
    driver: new MockDriver(),
    memory: new MemoryStore(path.join(dir, 'memory.json'))
  });

  const state = await engine.state({ window: 'mock-1', includeUi: true, maxNodes: 10 });
  const snapshot = state.snapshot.windows[0];
  const button = snapshot.nodes.find((node) => node.interactive);
  assert.ok(button?.ref);
  assert.equal(snapshot.window, 'mock-1');
  assert.equal(snapshot.nodes.length, 1);

  const acted = await engine.act({ window: 'mock-1', actions: [{ click: { ref: button.ref } }] });
  assert.equal(acted.ok, true);
});

test('state explicitly reports whether execution is isolated from the foreground desktop', async () => {
  const engine = new ComputerEngine({ driver: new MockDriver(), memory: { stats: () => ({ records: 0 }) }, executionMode: 'backgroundOnly' });
  const state = await engine.state();
  assert.equal(state.execution.mode, 'backgroundOnly');
  assert.equal(state.execution.backgroundOnly, true);
});

test('verify supports title, element, fingerprint and bounded file assertions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-verify-'));
  const file = path.join(dir, 'result.txt');
  fs.writeFileSync(file, 'done', 'utf8');
  const engine = new ComputerEngine({ driver: new MockDriver(), dataDir: dir, verifyRoots: dir, memory: new MemoryStore(path.join(dir, 'memory.json')) });
  const state = await engine.state({ window: 'mock-1', includeUi: true });
  const fingerprint = state.snapshot.windows[0].fingerprint;
  const output = await engine.verify({ window: 'mock-1', assertions: [
    { type: 'title', includes: 'Mock' },
    { type: 'element', query: { text: '保存', role: 'button' }, state: 'present', enabled: true },
    { type: 'fingerprint', equals: fingerprint },
    { type: 'file', path: file, exists: true, minBytes: 4 }
  ] });
  assert.equal(output.ok, true);
  assert.equal(output.assertions.length, 4);
  assert.equal(output.assertions.every((item) => item.passed), true);
  await assert.rejects(() => engine.verify({ assertions: [{ type: 'file', path: path.join(os.tmpdir(), 'outside.txt'), exists: false }] }), /verification_file_outside_allowed_roots/);
});

test('state reuses a verified transition snapshot before reading UIA', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-predict-state-'));
  const driver = new MockDriver();
  const memory = new MemoryStore(path.join(dir, 'memory.json'), { predictionMinUses: 2 });
  const before = { fingerprint: 'menu', nodes: [{ role: 'button', name: '资源包' }], environment: { process: 'mock', className: 'Mock' } };
  const after = { fingerprint: 'packs', nodes: [{ role: 'button', name: '完成', bounds: { x: 10, y: 10, width: 40, height: 20 } }], environment: { process: 'mock', className: 'Mock' } };
  memory.recordTransition('mock|mock', 'click:button:资源包', before, after);
  memory.recordTransition('mock|mock', 'click:button:资源包', before, after);
  let inspectCalls = 0;
  const original = driver.inspect.bind(driver);
  driver.inspect = async (...args) => { inspectCalls += 1; return original(...args); };
  const engine = new ComputerEngine({ driver, memory });
  const state = await engine.state({ window: 'mock-1', includeUi: true, actionSignature: 'click:button:资源包' });
  assert.equal(state.snapshot.windows[0].prediction.source, 'memory');
  assert.equal(inspectCalls, 0);
});

test('wait.seconds accepts fractional seconds and converts them internally', async () => {
  const engine = new ComputerEngine({ driver: new MockDriver(), memory: { stats: () => ({ records: 0 }) } });
  const started = Date.now();
  const output = await engine.waitFor('mock-1', { seconds: 0.01 });
  const elapsed = Date.now() - started;
  assert.equal(output.ok, true);
  assert.ok(elapsed >= 5, `expected a short delay, received ${elapsed}ms`);
  assert.ok(elapsed < 500, `fractional seconds should not become a long delay: ${elapsed}ms`);
});

test('wait discovers a window and matching element without fixed sleeps', async () => {
  const engine = new ComputerEngine({ driver: new MockDriver(), memory: { stats: () => ({ records: 0 }) } });
  const result = await engine.waitForTarget({
    windowQuery: { process: 'mock' },
    query: { text: '淇濆瓨', role: 'button' },
    timeoutMs: 500,
    pollMs: 50
  });
  assert.equal(result.ok, true);
  assert.equal(result.windows[0].process, 'mock');
  assert.equal(result.windows[0].elements[0].role, 'button');
});

test('optional fast AI executes the current plan without writing long-term workflows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-fast-current-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  const engine = new ComputerEngine({
    driver: new MockDriver(),
    memory,
    fastAi: {
      status: () => ({ configured: true, model: 'mock-fast' }),
      plan: async () => ({ model: 'mock-fast', actions: [{ click: { text: '保存', role: 'button' } }] })
    }
  });
  const output = await engine.fastAct({ window: 'mock-1', goal: '保存' });
  assert.equal(output.ok, true);
  assert.equal(memory.stats().workflows, 0);
});

test('opt-in streamed fast AI executes the first complete tool call only once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-fast-stream-'));
  let callbacks = 0;
  const engine = new ComputerEngine({
    driver: new MockDriver(),
    memory: new MemoryStore(path.join(dir, 'memory.json')),
    fastAi: {
      status: () => ({ configured: true, model: 'mock-fast' }),
      planToolCallStream: async ({ onToolCall }) => {
        const call = { type: 'tool_call', id: 'stream-1', name: 'computer.invoke', arguments: { actions: [{ kbseq: ['A'] }] }, model: 'mock-fast' };
        callbacks += 1;
        await onToolCall(call);
        return call;
      }
    }
  });
  const output = await engine.fastAct({ window: 'mock-1', goal: 'press A', stream: true });
  assert.equal(output.ok, true);
  assert.equal(output.source, 'fast-ai-tool-call-stream');
  assert.equal(callbacks, 1);
  assert.equal(engine.metrics.toolCalls, 1);
});

test('shortcut run uses saved defaults and lets callers override fractional seconds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-shortcut-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  memory.recordWorkflow('switch resource pack', 'mock|mock', [
    { wait: { seconds: '{{mywait}}' } }
  ], { parameters: { name: 'objmc', mywait: 0.3 } });
  const engine = new ComputerEngine({ driver: new MockDriver(), memory });
  const waits = [];
  engine.waitFor = async (_window, wait) => {
    waits.push(wait.seconds);
    return { ok: true, strategy: 'delay' };
  };

  await engine.manageShortcut({ action: 'run', window: 'mock-1', name: 'switch resource pack' });
  await engine.manageShortcut({ action: 'run', window: 'mock-1', name: 'switch resource pack', params: { mywait: 1.25 } });
  assert.deepEqual(waits, [0.3, 1.25]);
});

test('main AI can save aliases and run a shortcut without fast AI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-save-shortcut-'));
  const engine = new ComputerEngine({ driver: new MockDriver(), memory: new MemoryStore(path.join(dir, 'memory.json')) });
  const saved = await engine.manageShortcut({
    action: 'save', window: 'mock-1', name: '切换资源包', aliases: ['切换材质包'],
    params: { mywait: 0.01 }, actions: [{ wait: { seconds: '{{mywait}}' } }]
  });
  assert.equal(saved.ok, true);
  const listed = await engine.manageShortcut({ action: 'list', window: 'mock-1' });
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.shortcuts[0].aliases, ['切换材质包']);
  const replay = await engine.manageShortcut({ action: 'run', window: 'mock-1', name: '切换材质包' });
  assert.equal(replay.ok, true);
  assert.equal(replay.parameters.mywait, 0.01);
});

test('cross-window shortcuts use a separate ordered window scope', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-cross-shortcut-'));
  const driver = new MockDriver();
  driver.windows.push({ id: 'mock-2', title: 'Second', process: 'other', className: 'Other', isForeground: false });
  const engine = new ComputerEngine({ driver, memory: new MemoryStore(path.join(dir, 'memory.json')) });
  const saved = await engine.manageShortcut({
    action: 'save', scope: 'cross', windows: { browser: 'mock-1', explorer: 'mock-2' }, name: '下载并打开',
    actions: [{ window: 'browser', keys: ['CTRL', 'L'] }, { window: 'explorer', keys: ['ENTER'] }]
  });
  assert.equal(saved.ok, true);
  const single = await engine.manageShortcut({ action: 'list', window: 'mock-1' });
  assert.equal(single.count, 0);
  const replay = await engine.manageShortcut({ action: 'run', scope: 'cross', windows: { browser: 'mock-1', explorer: 'mock-2' }, name: '下载并打开' });
  assert.equal(replay.ok, true);
  assert.equal(replay.execution.windows.length, 2);
});

test('cross-window shortcut replay follows the saved route when window object order changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-cross-route-'));
  const driver = new MockDriver();
  driver.windows.push({ id: 'mock-2', title: 'Second', process: 'other', className: 'Other', isForeground: false });
  const engine = new ComputerEngine({ driver, memory: new MemoryStore(path.join(dir, 'memory.json')) });
  await engine.manageShortcut({
    action: 'save', scope: 'cross', windows: { browser: 'mock-1', explorer: 'mock-2' }, name: 'ordered download',
    actions: [{ window: 'browser', keys: ['CTRL', 'L'] }, { window: 'explorer', keys: ['ENTER'] }]
  });
  const replay = await engine.manageShortcut({
    action: 'run', scope: 'cross', windows: { explorer: 'mock-2', browser: 'mock-1' }, name: 'ordered download'
  });
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.execution.windows.map((item) => item.window), ['browser', 'explorer']);
});

test('organize exposes ambiguous candidates and applies only explicit main-AI operations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-organize-'));
  const engine = new ComputerEngine({ driver: new MockDriver(), memory: new MemoryStore(path.join(dir, 'memory.json')) });
  const common = { window: 'mock-1', beforeFingerprint: 'menu', afterFingerprint: 'done' };
  await engine.manageShortcut({ action: 'save', ...common, name: 'open settings', actions: [{ kbseq: ['ESC'] }, { click: { text: 'Options' } }, { click: { text: 'Done' } }] });
  await engine.manageShortcut({ action: 'save', ...common, name: 'open resource settings', actions: [{ kbseq: ['ESC'] }, { click: { text: 'Options' } }, { click: { text: 'Resource Packs' } }, { click: { text: 'Done' } }] });

  const candidates = await engine.manageShortcut({ action: 'organize', window: 'mock-1' });
  assert.equal(candidates.candidates.length, 1);
  assert.equal(engine.memory.stats().workflows, 2);
  const applied = await engine.manageShortcut({ action: 'organize', window: 'mock-1', apply: [{ op: 'merge', keep: 'open settings', remove: ['open resource settings'] }] });
  assert.equal(applied.ok, true);
  assert.equal(engine.memory.stats().workflows, 1);
});

test('organize AI returns a proposal without applying it unless applyAi is explicit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-organize-ai-'));
  const memory = new MemoryStore(path.join(dir, 'memory.json'));
  const engine = new ComputerEngine({
    driver: new MockDriver(),
    memory,
    fastAi: {
      organize: async () => ({ model: 'mock-organizer', operations: [{ op: 'archive', name: 'old shortcut' }] })
    }
  });
  await engine.manageShortcut({ action: 'save', window: 'mock-1', name: 'old shortcut', actions: [{ keys: ['ESC'] }] });
  const proposal = await engine.manageShortcut({ action: 'organize', window: 'mock-1', useAi: true });
  assert.equal(proposal.applied.length, 0);
  assert.equal(proposal.proposal.operations[0].op, 'archive');
  assert.equal(memory.stats().workflows, 1);
  const applied = await engine.manageShortcut({ action: 'organize', window: 'mock-1', useAi: true, applyAi: true });
  assert.equal(applied.applied.length, 1);
  assert.equal(memory.listWorkflows('mock|mock').length, 0);
});
