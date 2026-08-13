'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { ComputerEngine } = require('../../src/engine');
const { ExecutionDesktopManager, ExecutionDesktopDriver } = require('../../src/drivers/execution');
const { PowerShellDriver } = require('../../src/drivers/powershell');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

test('dedicated desktop isolates windows and executes UIA actions', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-execution-'));
  const fixture = path.join(dataDir, 'isolated-window.exe');
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'src/drivers/compile-desktop-agent.ps1'),
    '-SourcePath', path.join(root, 'tests/fixtures/isolated-window.cs'), '-OutputPath', fixture
  ], { windowsHide: true });

  const manager = new ExecutionDesktopManager({ dataDir });
  const engine = new ComputerEngine({ execution: manager, dataDir });
  const tag = Date.now().toString(36);
  const initialTitle = `ComputerUsePlus-Isolated-${tag}`;
  const ocrTitle = `ComputerUsePlus-Clicked-${tag}-`;
  const valueTitle = `ComputerUsePlus-Clicked-${tag}-value`;
  const clickedTitle = `ComputerUsePlus-Clicked-${tag}-xy`;
  let processId;

  try {
    const launched = await manager.launch(`"${fixture}" ${tag}`);
    processId = launched.processId;
    const window = await waitFor(async () => {
      const state = await engine.state();
      return state.windows.find((item) => item[2] === initialTitle);
    });
    assert.ok(window, 'fixture must be visible to the execution desktop agent');
    const diagnostics = await manager.diagnose();
    assert.equal(diagnostics.desktop.startsWith('ComputerUsePlus-'), true);
    assert.equal(diagnostics.windows.some((item) => item.title === initialTitle), true);
    assert.equal(diagnostics.processes.some((item) => item.processId === processId), true);

    const secondTag = `${tag}-second`;
    await manager.launch(`"${fixture}" ${secondTag}`);
    assert.equal(await waitFor(async () => (await engine.state()).windows.some((item) => item[2] === `ComputerUsePlus-Isolated-${secondTag}`)), true);
    const multiWindowMetadata = await engine.screenshot({ mode: 'metadata' });
    assert.ok(multiWindowMetadata.count >= 2);
    assert.ok(new Set(multiWindowMetadata.screens.map((item) => item.window)).size >= 2);

    const capture = await new ExecutionDesktopDriver(manager).capture(window[0]);
    assert.ok(capture.bounds.width > 0 && capture.bounds.height > 0);
    assert.ok(fs.statSync(capture.path).size > 1000, 'isolated PrintWindow capture must contain pixels');
    fs.unlinkSync(capture.path);
    const screenshot = await engine.screenshot({ window: window[0], mode: 'image' });
    assert.equal(screenshot.count, 1);
    assert.ok(screenshot.screens[0].imageBase64.length > 1000);
    assert.equal(fs.readdirSync(dataDir).some((name) => name.startsWith('capture-') && name.endsWith('.png')), false);
    const coordinateScreenshot = await engine.screenshot({ window: window[0], mode: 'image', coordinateGrid: true, tickPixels: 100 });
    assert.equal(coordinateScreenshot.screens[0].coordinates.origin, 'window-top-left');
    assert.equal(coordinateScreenshot.screens[0].coordinates.grid, true);
    assert.equal(coordinateScreenshot.screens[0].coordinates.tickPixels, 100);
    assert.ok(coordinateScreenshot.screens[0].imageBase64.length > 1000);

    const ocrClick = await engine.clickWithOcr(window[0], { text: 'Button' });
    assert.equal(ocrClick.ok, true);
    assert.equal(ocrClick.strategy, 'win32.mousemessage');
    assert.equal(await waitFor(async () => (await engine.state()).windows.some((item) => item[2] === ocrTitle)), true);
    assert.equal(fs.readdirSync(dataDir).some((name) => name.startsWith('capture-') && name.endsWith('.png')), false);

    const userWindows = await new PowerShellDriver().listWindows();
    assert.equal(userWindows.some((item) => item.title === initialTitle), false, 'fixture must not appear on the user desktop');
    const foregroundProbe = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CupProbe { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); }'; [CupProbe]::GetForegroundWindow().ToInt64()"
    ], { windowsHide: true });
    const userWindowId = Number(foregroundProbe.stdout.trim());
    if (Number.isInteger(userWindowId) && userWindowId > 0) {
      await assert.rejects(
        () => new ExecutionDesktopDriver(manager).inspect(String(userWindowId), { limit: 1 }),
        /window_not_(?:on_execution_desktop|found)/
      );
    }

    const inspected = await engine.inspect({ window: window[0], query: { text: 'Fixture Button', role: 'button' } });
    assert.equal(inspected.count, 1);
    const cachedLocatorQuery = await engine.inspect({ window: window[0], query: { automationId: 'fixtureButton', role: 'button' } });
    assert.equal(cachedLocatorQuery.count, 1);
    const valueAction = await engine.act({
      window: window[0],
      actions: [
        { setValue: { label: 'Fixture Input', value: 'value' } },
        { click: { text: 'Fixture Button', role: 'button' } }
      ]
    });
    assert.equal(valueAction.ok, true);
    assert.equal(await waitFor(async () => (await engine.state()).windows.some((item) => item[2] === valueTitle)), true);

    const acted = await engine.act({
      window: window[0],
      actions: [
        { setValue: { label: 'Fixture Input', value: '' } },
        { click: { text: 'Fixture Input', role: 'edit' } },
        { kbseq: ['x', 'y'] },
        { click: { text: 'Fixture Button', role: 'button' } }
      ]
    });
    assert.equal(acted.ok, true);
    assert.equal(acted.actions[0].strategy, 'cached-uia.value');
    assert.ok(['uia.focus', 'cached-uia'].includes(acted.actions[1].strategy));
    assert.equal(acted.actions[2].strategy, 'win32.keymessage');
    assert.ok(['win32.message', 'cached-uia'].includes(acted.actions[3].strategy));

    const changed = await waitFor(async () => (await engine.state()).windows.some((item) => item[2] === clickedTitle));
    assert.equal(changed, true);
  } finally {
    const destroyed = await manager.destroy();
    engine.ocr.close();
    assert.equal(destroyed.ok, true);
  }

  assert.throws(() => process.kill(processId, 0), /ESRCH|not found/i);
});

test('MCP stdio shutdown reclaims its execution desktop agent', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [path.join(root, 'src/index.js')], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data.toString('utf8'); });
  child.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'computer.state', arguments: {} } })}\n`);
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  assert.equal(exitCode, 0, stderr);
  const responses = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const stateResponse = responses.find((item) => item.id === 2);
  const state = JSON.parse(stateResponse.result.content[0].text);
  assert.equal(state.execution.enabled, true);
  assert.throws(() => process.kill(state.execution.agentPid, 0), /ESRCH|not found/i);
});
