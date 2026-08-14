'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ExecutionDesktopManager } = require('../../src/drivers/execution');

test('execution data housekeeping is bounded and only removes owned files', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-housekeeping-'));
  const currentAgent = path.join(dataDir, 'desktop-agent-aaaaaaaaaaaa.exe');
  const oldAgent = path.join(dataDir, 'desktop-agent-bbbbbbbbbbbb.exe');
  const oldCapture = path.join(dataDir, 'capture-11111111111111111111111111111111.png');
  const newestLog = path.join(dataDir, 'execution-agent-new.log');
  const oldLog = path.join(dataDir, 'execution-agent-old.log');
  const unrelated = path.join(dataDir, 'keep-me.txt');
  for (const file of [currentAgent, oldAgent, oldCapture, newestLog, oldLog, unrelated]) fs.writeFileSync(file, 'data');
  const oldTime = new Date(Date.now() - 10_000);
  fs.utimesSync(oldCapture, oldTime, oldTime);
  fs.utimesSync(oldLog, oldTime, oldTime);

  const manager = new ExecutionDesktopManager({
    dataDir,
    captureTtlMs: 100,
    logTtlMs: 60_000,
    maxLogs: 1,
    maxAgentBinaries: 1
  });
  const result = manager.cleanupDataDir(currentAgent);

  assert.equal(fs.existsSync(currentAgent), true);
  assert.equal(fs.existsSync(oldAgent), false);
  assert.equal(fs.existsSync(oldCapture), false);
  assert.equal(fs.existsSync(newestLog), true);
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(result.removed, 3);
  assert.ok(result.reclaimedBytes > 0);
});

test('foreground UIA clicks fall back when a control lacks InvokePattern', () => {
  const scriptPath = path.join(__dirname, '..', '..', 'src', 'drivers', 'desktop.ps1');
  const script = fs.readFileSync(scriptPath, 'utf8');
  assert.match(script, /try \{\s*\$invoker = \$target\.GetCurrentPattern\([\s\S]*?\} catch \{\s*# Some WebView/);
  assert.match(script, /win32\.click\.invoke-fallback/);
});
