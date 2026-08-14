'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { AgentRuntime } = require('./agent-runtime');
const { SERVER_INFO, toolsForProfile, canonicalToolName, result, error, toolResult } = require('./protocol');

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

class HttpMcpRuntime {
  constructor(engine, options = {}) {
    if (!engine) throw new Error('http_engine_required');
    this.engine = engine;
    this.host = options.host || '127.0.0.1';
    this.port = Number.isInteger(options.port) ? options.port : 0;
    this.defaultProfile = String(options.profile || 'fast-agent').toLowerCase();
    this.defaultAllowedWindows = options.allowedWindows || [];
    this.tokens = normalizeConnections(options.connections, this.defaultProfile, this.defaultAllowedWindows);
    if (!this.tokens.length && options.token) {
      this.tokens = [{ token: String(options.token), profile: this.defaultProfile, allowedWindows: this.defaultAllowedWindows }];
    }
    if (!this.tokens.length && options.allowUnauthenticated !== true) throw new Error('http_connection_token_required');
    this.sessions = new Map();
    this.worker = options.worker || null;
    this.server = null;
  }

  async start() {
    if (this.server) return this.address();
    if (this.worker) await this.worker.start();
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((errorValue) => this.sendError(response, null, -32603, errorValue.message));
    });
    await new Promise((resolve, reject) => {
      const onError = (errorValue) => { this.server.off('listening', onListening); reject(errorValue); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    return this.address();
  }

  address() {
    const value = this.server?.address();
    return { host: this.host, port: typeof value === 'object' && value ? value.port : this.port, path: '/mcp' };
  }

  async handle(request, response) {
    this.cleanup();
    if (request.method === 'GET' && request.url === '/health') {
      return this.sendJson(response, 200, { ok: true, name: SERVER_INFO.name, sessions: this.sessions.size, ...(this.worker ? { worker: this.worker.status() } : {}) });
    }
    if (request.url === '/admin/providers') return this.handleProviders(request, response);
    if (request.url !== '/mcp' || request.method !== 'POST') return this.sendJson(response, 404, { ok: false, reason: 'not_found' });
    const connection = this.authenticate(request);
    if (!connection) return this.sendJson(response, 401, { ok: false, reason: 'http_unauthorized' });
    let body;
    try { body = await readJson(request); }
    catch (errorValue) { return this.sendJson(response, 400, error(null, -32700, errorValue.message)); }
    const sessionId = String(request.headers['mcp-session-id'] || body.params?.sessionId || crypto.randomBytes(12).toString('base64url'));
    let session;
    try { session = this.getSession(sessionId, connection); }
    catch (errorValue) { return this.sendJson(response, 403, { ok: false, reason: errorValue.message }); }
    response.setHeader('MCP-Session-Id', sessionId);
    response.setHeader('MCP-Protocol-Version', '2024-11-05');
    if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') return this.sendJson(response, 202, {});
    const value = await this.dispatch(session, body);
    if (body.id === undefined) return this.sendJson(response, 202, {});
    return this.sendJson(response, 200, value?.__rpcError ? value.__rpcError : result(body.id, value));
  }

  authenticate(request) {
    const header = String(request.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!this.tokens.length && token === '') return { token: '', profile: this.defaultProfile, allowedWindows: this.defaultAllowedWindows };
    return this.tokens.find((item) => item.token === token) || null;
  }

  async handleProviders(request, response) {
    const connection = this.authenticate(request);
    if (!connection) return this.sendJson(response, 401, { ok: false, reason: 'http_unauthorized' });
    if (!this.engine.providerConfig) return this.sendJson(response, 503, { ok: false, reason: 'provider_config_unavailable' });
    if (request.method === 'GET') return this.sendJson(response, 200, { ok: true, ...this.engine.providerConfig.list() });
    if (request.method !== 'POST') return this.sendJson(response, 405, { ok: false, reason: 'method_not_allowed' });
    let body;
    try { body = await readJson(request); }
    catch (errorValue) { return this.sendJson(response, 400, { ok: false, reason: errorValue.message }); }
    try {
      if (body.action === 'upsert') {
        const profile = this.engine.providerConfig.upsert(body.profile, body.revision);
        const reload = this.engine.reloadProvider?.();
        return this.sendJson(response, 200, { ok: true, profile, ...(reload ? { reload } : {}) });
      }
      if (body.action === 'remove') {
        const value = this.engine.providerConfig.remove(body.id, body.revision);
        const reload = value.ok ? this.engine.reloadProvider?.() : null;
        return this.sendJson(response, 200, { ...value, ...(reload ? { reload } : {}) });
      }
      if (body.action === 'activate') {
        const value = this.engine.providerConfig.activate(body.id, body.revision);
        const reload = this.engine.reloadProvider?.();
        return this.sendJson(response, 200, { ...value, ...(reload ? { reload } : {}) });
      }
      return this.sendJson(response, 400, { ok: false, reason: 'provider_action_invalid' });
    } catch (errorValue) {
      const status = errorValue.message === 'provider_revision_conflict' ? 409 : 400;
      return this.sendJson(response, status, { ok: false, reason: errorValue.message });
    }
  }

  getSession(id, connection) {
    const existing = this.sessions.get(id);
    if (existing && existing.token === connection.token) {
      existing.updatedAt = Date.now();
      return existing;
    }
    if (existing) throw new Error('http_session_token_mismatch');
    const runtime = new AgentRuntime(this.engine, {
      internalEnabled: connection.profile === 'intervention-agent',
      allowedWindows: connection.allowedWindows
    });
    const session = { id, token: connection.token, profile: connection.profile, allowedWindows: connection.allowedWindows, runtime, updatedAt: Date.now() };
    this.sessions.set(id, session);
    return session;
  }

  async dispatch(session, request) {
    if (!request || request.jsonrpc !== '2.0') return resultPayload(error(request?.id, -32600, 'Invalid Request'));
    if (request.method === 'initialize') return resultPayload({
      protocolVersion: request.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    });
    const tools = toolsForProfile(session.profile);
    if (request.method === 'tools/list') return resultPayload({ tools });
    if (request.method !== 'tools/call') return resultPayload(error(request.id, -32601, `Unknown method: ${request.method}`));
    const requestedName = request.params?.name;
    if (!tools.some((tool) => tool.name === requestedName)) return resultPayload(error(request.id, -32601, `Unknown tool: ${requestedName}`));
    const name = canonicalToolName(requestedName);
    const args = request.params?.arguments || {};
    try {
      const value = await this.callTool(session, name, args);
      return resultPayload(toolResult(value));
    } catch (errorValue) {
      this.engine.metrics.failures += 1;
      return resultPayload(toolResult({ ok: false, reason: errorValue.message }, true));
    }
  }

  async callTool(session, name, args) {
    if (name === 'agent.run') return session.runtime.run(args);
    if (name === 'agent.status') return session.runtime.status(args);
    if (name === 'agent.cancel') return session.runtime.cancel(args);
    if (name === 'agent.capabilities') return session.runtime.capabilities();
    if (name === 'agent.internal') return session.runtime.internal(args);
    if (name === 'computer.ptc') return this.engine.runPtc(args);
<<<<<<< HEAD
    if (name === 'computer.script') return this.engine.runScript(args);
    if (name === 'agent.components') return this.engine.manageComponents(args);
    if (name === 'agent.visual_alias') return this.engine.manageVisualAlias(args);
=======
>>>>>>> origin/main
    if (name === 'computer.state') return this.engine.state(args);
    if (name === 'computer.inspect') return this.engine.inspect(args);
    if (name === 'computer.wait') return this.engine.waitForTarget(args);
    if (name === 'computer.screenshot') return this.engine.screenshot(args);
    if (name === 'computer.act') return this.engine.act(args);
    if (name === 'computer.fast') return this.engine.fastAct(args);
    if (name === 'computer.invoke' || name === 'shortcut.run') return this.engine.invokeToolCall({ type: 'tool_call', name, arguments: args });
    if (name === 'computer.verify') return this.engine.verify(args);
    if (name === 'computer.cancel') return this.engine.cancelConfirmation(args);
    if (name === 'computer.shortcut') return this.engine.manageShortcut(args);
    if (name === 'computer.execution') return this.engine.manageExecution(args);
    if (name === 'computer.browser') return this.engine.manageBrowser(args);
    throw new Error(`Unknown tool: ${name}`);
  }

  cleanup(now = Date.now()) {
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt <= SESSION_TTL_MS) continue;
      session.runtime.close().catch(() => {});
      this.sessions.delete(id);
    }
  }

  sendError(response, id, code, message) {
    return this.sendJson(response, 500, error(id, code, message));
  }

  sendJson(response, status, payload) {
    if (response.headersSent) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload));
  }

  async close() {
    await Promise.allSettled([...this.sessions.values()].map((session) => session.runtime.close()));
    this.sessions.clear();
    await this.worker?.stop?.();
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }
}

function normalizeConnections(value, defaultProfile, defaultAllowedWindows) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== 'object' || !String(item.token || '').trim()) throw new Error('http_connection_invalid');
    const profile = String(item.profile || defaultProfile).toLowerCase();
    if (!['fast-agent', 'intervention-agent', ''].includes(profile)) throw new Error('http_connection_profile_invalid');
    return { token: String(item.token), profile: profile || defaultProfile, allowedWindows: item.allowedWindows || defaultAllowedWindows };
  });
}

function resultPayload(value) {
  if (value?.jsonrpc === '2.0' && 'error' in value) return { __rpcError: value };
  return value?.jsonrpc === '2.0' && 'result' in value ? value.result : value;
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('http_body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid_json'); }
}

module.exports = { HttpMcpRuntime, normalizeConnections };
