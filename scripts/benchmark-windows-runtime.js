'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { ComputerEngine } = require('../src/engine');
const { ExecutionDesktopManager } = require('../src/drivers/execution');
const { MemoryStore } = require('../src/memory');
const { percentile } = require('../src/benchmark');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.data', 'windows-runtime-benchmark');

if (process.platform !== 'win32') {
  process.stderr.write('windows_runtime_benchmark_requires_windows\n');
  process.exitCode = 2;
} else {
  run().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

async function run() {
  fs.mkdirSync(dataDir, { recursive: true });
  const fixture = path.join(dataDir, 'isolated-window.exe');
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'src/drivers/compile-desktop-agent.ps1'),
    '-SourcePath', path.join(root, 'tests/fixtures/isolated-window.cs'), '-OutputPath', fixture
  ], { windowsHide: true });
  const manager = new ExecutionDesktopManager({ dataDir });
  const memory = new MemoryStore(path.join(dataDir, 'memory.json'));
  const engine = new ComputerEngine({ execution: manager, dataDir, memory });
  const tag = Date.now().toString(36);
  try {
    await manager.launch(`"${fixture}" ${tag}`);
    const window = await waitFor(async () => (await engine.state()).windowDetails.find((item) => item.title === `ComputerUsePlus-Isolated-${tag}`));
    if (!window) throw new Error('benchmark_fixture_window_missing');
    const query = { text: 'Fixture Button', role: 'button' };
    const uia = await measure(20, () => engine.inspect({ window: window.id, query }));
    const scope = await engine.getWindowKey(window.id);
    memory.recordWorkflow('activate fixture button', scope, [{ click: query }], { aliases: ['activate button'] });
    const shortcut = await measure(20, () => engine.fastAct({ window: window.id, goal: 'activate fixture button' }));
    await engine.inspect({ window: window.id, mode: 'ocr', query: { text: 'Button' } });
    const ocr = await measure(5, () => engine.inspect({ window: window.id, mode: 'ocr', query: { text: 'Button' } }));
    const output = {
      generatedAt: new Date().toISOString(),
      execution: { backgroundOnly: true, desktop: manager.status().desktop },
      uia: summarize(uia), shortcut: summarize(shortcut), ocrWarm: summarize(ocr),
      metrics: { ...engine.metrics, uptimeMs: Date.now() - engine.metrics.startedAt }
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    engine.ocr.close();
    await manager.destroy().catch(() => {});
  }
}

async function measure(repeats, operation) {
  const samples = [];
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    try {
      const result = await operation();
      samples.push({ success: result?.ok !== false && Number(result?.count ?? 1) > 0, latencyMs: performance.now() - started });
    } catch (error) { samples.push({ success: false, latencyMs: performance.now() - started, reason: error.message }); }
  }
  return samples;
}

function summarize(samples) {
  const latencies = samples.map((item) => item.latencyMs).sort((left, right) => left - right);
  return {
    samples: samples.length,
    successes: samples.filter((item) => item.success).length,
    successRate: samples.filter((item) => item.success).length / samples.length,
    p50Ms: round(percentile(latencies, 0.5)), p95Ms: round(percentile(latencies, 0.95)), maxMs: round(latencies.at(-1) || 0),
    failures: samples.filter((item) => !item.success).map((item) => item.reason || 'operation_failed')
  };
}

function round(value) { return Math.round(Number(value) * 100) / 100; }
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}
