'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('fast-agent stdio profile serves the compact high-level MCP surface', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-agent-stdio-'));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      CUP_MOCK: '1',
      COMPUTER_USE_PLUS_DATA_DIR: dataDir,
      COMPUTER_USE_PLUS_TOOL_PROFILE: 'fast-agent'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (const request of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent.capabilities', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent.run', arguments: { goal: 'unknown local task', window: 'mock-1', budget: { maxSeconds: 1 } } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent.internal', arguments: { taskId: 'x', op: 'inspect' } } }
  ]) child.stdin.write(`${JSON.stringify(request)}\n`);

  const responses = await waitForResponses(() => stdout, 5, 5000);
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`stdio_child_timeout: ${stderr}`)); }, 5000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, stderr);
  const byId = new Map(responses.map((item) => [item.id, item]));
  assert.deepEqual(byId.get(2).result.tools.map((tool) => tool.name), [
    'agent.run', 'agent.status', 'agent.cancel', 'agent.capabilities'
  ]);
  const capabilities = JSON.parse(byId.get(3).result.content[0].text);
  assert.equal(capabilities.ok, true);
  assert.doesNotMatch(JSON.stringify(capabilities), /apiKey|deepseek\.txt/i);
  const run = JSON.parse(byId.get(4).result.content[0].text);
  assert.equal(run.status, 'needs_reasoning');
  assert.equal(run.needs_reasoning, 'planner_unavailable');
  assert.equal(byId.get(5).error.code, -32601);
});

test('invalid window allowlist fails closed without echoing its value', async () => {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      CUP_MOCK: '1',
      COMPUTER_USE_PLUS_AGENT_ALLOWED_WINDOWS: 'not-json-sensitive-value'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /must be valid JSON/);
  assert.doesNotMatch(stderr, /not-json-sensitive-value/);
});

async function waitForResponses(read, count, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const lines = read().split(/\r?\n/).filter(Boolean);
    if (lines.length >= count) return lines.slice(0, count).map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`stdio_response_timeout: ${read()}`);
}
