'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HttpMcpRuntime } = require('../../src/http-runtime');

function fakeEngine() {
  return {
    metrics: { failures: 0 },
    executionMode: 'backgroundOnly',
    isolated: true,
    driver: {
      async listWindows() { return [{ id: 'w1', process: 'qq', title: 'QQ', className: 'QQ' }]; }
    },
    fastAi: { status: () => ({ configured: false }) },
    actionClassifier: null,
    ocr: { available: false },
    vision: { available: false },
    async fastAct() { return { ok: true, source: 'local', execution: { actions: [] } }; },
    async state() { return { ok: true, state: 'test' }; }
  };
}

function request(address, token, payload, sessionId = '') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (sessionId) headers['MCP-Session-Id'] = sessionId;
    const req = http.request({ hostname: address.host, port: address.port, path: '/mcp', method: 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP MCP runtime requires a token and serves initialize/tools/call', async () => {
  const runtime = new HttpMcpRuntime(fakeEngine(), { port: 0, token: 'token-a', profile: 'fast-agent' });
  const address = await runtime.start();
  try {
    const unauthorized = await request(address, 'wrong', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(unauthorized.status, 401);
    const initialized = await request(address, 'token-a', { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    assert.equal(initialized.body.result.serverInfo.name, 'computer-use-plus');
    const sessionId = initialized.headers['mcp-session-id'];
    assert.ok(sessionId);
    const listed = await request(address, 'token-a', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, sessionId);
    assert.equal(listed.headers['mcp-session-id'], sessionId);
    assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ['agent.run', 'agent.status', 'agent.cancel', 'agent.capabilities']);
    const called = await request(address, 'token-a', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent.capabilities', arguments: {} } });
    assert.equal(called.body.result.content[0].type, 'text');
  } finally {
    await runtime.close();
  }
});

test('HTTP sessions isolate intervention profile and window policy', async () => {
  const runtime = new HttpMcpRuntime(fakeEngine(), {
    port: 0,
    connections: [
      { token: 'fast', profile: 'fast-agent' },
      { token: 'intervene', profile: 'intervention-agent', allowedWindows: [{ process: 'qq' }] }
    ]
  });
  const address = await runtime.start();
  try {
    const fast = await request(address, 'fast', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(fast.body.result.tools.some((tool) => tool.name === 'agent.internal'), false);
    const intervention = await request(address, 'intervene', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(intervention.body.result.tools.some((tool) => tool.name === 'agent.internal'), true);
    const sessionId = intervention.headers['mcp-session-id'];
    const hijack = await request(address, 'fast', { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, sessionId);
    assert.equal(hijack.status, 403);
    assert.equal(hijack.body.reason, 'http_session_token_mismatch');
    const denied = await request(address, 'fast', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent.internal', arguments: { taskId: 'x', op: 'inspect' } } });
    assert.equal(denied.body.error.code, -32601);
  } finally {
    await runtime.close();
  }
});
