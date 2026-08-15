'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateLayout, StructuredVisionClient } = require('../../src/vision');
const { CdpDriver } = require('../../src/drivers/cdp');

test('structured vision rejects malformed layout and normalizes node source', () => {
  assert.throws(() => validateLayout({ windows: [{ id: 'w', nodes: [{ bounds: { x: 0, y: 0, width: 1, height: 1 }, confidence: 2 }] }] }), /vision_invalid_confidence/);
  const layout = validateLayout({ windows: [{ id: 'w', nodes: [{ id: 'n', role: 'button', text: '完成', bounds: { x: 0, y: 0, width: 10, height: 20 }, confidence: .96, source: 'free-text' }] }] });
  assert.equal(layout.windows[0].nodes[0].source, 'vision');
  assert.equal(layout.windows[0].nodes[0].parent, null);
});

test('vision provider validates injected local parser without exposing image bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-vision-'));
  const image = path.join(dir, 'capture.png'); fs.writeFileSync(image, Buffer.from('png-fixture'));
  let received;
  const vision = new StructuredVisionClient({ parse: async (value) => { received = value; return { windows: [{ id: 'w', nodes: [{ role: 'button', text: '完成', bounds: { x: 1, y: 2, width: 3, height: 4 }, confidence: .9 }] }] }; } });
  const result = await vision.inspectImage(image, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(result.windows[0].nodes[0].text, '完成');
  assert.ok(received.dataUrl.startsWith('data:image/png;base64,'));
});

test('CDP driver exposes page targets and structured DOM actions', async () => {
  const calls = [];
  const client = {
    async targets() { return [{ id: 'tab-1', type: 'page', title: 'Bilibili', url: 'https://www.bilibili.com/', webSocketDebuggerUrl: 'ws://test' }]; },
    async send(target, method, params) {
      calls.push({ target: target.id, method, params });
      if (method === 'Runtime.evaluate') return { result: { value: { elements: [{ id: 'n1', name: '搜索', text: '搜索', role: 'button', bounds: { x: 1, y: 2, width: 20, height: 10 }, enabled: true }] } } };
      return {};
    }
  };
  const driver = new CdpDriver({ client, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cup-cdp-')) });
  assert.equal((await driver.listWindows())[0].backend, 'cdp');
  const elements = await driver.inspect('tab-1', { text: '搜索' });
  assert.equal(elements[0].role, 'button');
  await driver.click('tab-1', { text: '搜索' });
  assert.equal(calls.filter((call) => call.method === 'Runtime.evaluate').length, 3);
  assert.equal(calls.filter((call) => call.method === 'Accessibility.getFullAXTree').length, 2);
});

test('browser management selects a sole CDP page when a window id is omitted', async () => {
  const { ComputerEngine } = require('../../src/engine');
  const browserDriver = {
    async listWindows() { return [{ id: 'page-1', title: 'Example', url: 'https://example.com/' }]; },
    async inspect(window, query) { return [{ name: query.text, role: 'heading', id: window }]; }
  };
  const engine = new ComputerEngine({ driver: { listWindows: async () => [] }, browserDriver, memory: { stats: () => ({}) } });
  const result = await engine.manageBrowser({ action: 'inspect', query: { text: 'Example' } });
  assert.equal(result.window, 'page-1');
  assert.equal(result.elements[0].name, 'Example');
});

test('browser launcher cleanup accepts execution-desktop process handles', () => {
  const { BrowserCdpLauncher } = require('../../src/drivers/cdp');
  const launcher = new BrowserCdpLauncher();
  launcher.child = { pid: 12, killed: false };
  launcher.stop();
  assert.equal(launcher.child, null);
});

test('CDP driver waits until the page document is ready', async () => {
  let calls = 0;
  const client = {
    async targets() { return [{ id: 'tab', type: 'page', webSocketDebuggerUrl: 'ws://test' }]; },
    async send(_target, method) {
      if (method !== 'Runtime.evaluate') return {};
      calls += 1;
      return { result: { value: calls > 1 ? 'complete' : 'loading' } };
    }
  };
  const driver = new CdpDriver({ client });
  await driver.listWindows();
  const ready = await driver.waitForReady('tab', 1000);
  assert.equal(ready.ok, true);
  assert.equal(ready.readyState, 'complete');
});

test('CDP driver constrains site permission origin and setting', async () => {
  const calls = [];
  const client = {
    async targets() { return [{ id: 'tab', type: 'page', webSocketDebuggerUrl: 'ws://test' }]; },
    async send(_target, method, params) { calls.push({ method, params }); return {}; }
  };
  const driver = new CdpDriver({ client });
  await driver.listWindows();
  const result = await driver.setPermission('tab', 'https://example.test', 'notifications', 'denied');
  assert.equal(result.setting, 'denied');
  assert.equal(calls.at(-1).method, 'Browser.setPermission');
  await assert.rejects(() => driver.setPermission('tab', 'file:///secret', 'notifications', 'granted'), /cdp_permission_origin_invalid/);
  await assert.rejects(() => driver.setPermission('tab', 'https://example.test', 'camera', 'unknown'), /cdp_permission_setting_invalid/);
});
