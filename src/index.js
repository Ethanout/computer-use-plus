'use strict';

const readline = require('node:readline');
const { ComputerEngine } = require('./engine');
const { AgentRuntime } = require('./agent-runtime');
const { HttpMcpRuntime } = require('./http-runtime');
const { WorkerSupervisor } = require('./worker-supervisor');
const { SERVER_INFO, toolsForProfile, canonicalToolName, result, error, toolResult } = require('./protocol');

const toolProfile = process.env.COMPUTER_USE_PLUS_TOOL_PROFILE || '';
const engine = new ComputerEngine();
const agentRuntime = new AgentRuntime(engine, {
  internalEnabled: toolProfile.toLowerCase() === 'intervention-agent',
  allowedWindows: parseAllowedWindows(process.env.COMPUTER_USE_PLUS_AGENT_ALLOWED_WINDOWS)
});
const httpRuntime = createHttpRuntime(engine);
const tools = toolsForProfile(toolProfile);
const allowedToolNames = new Set(tools.map((tool) => tool.name));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
let shuttingDown = false;

function parseAllowedWindows(value) {
  if (!value) return [];
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('COMPUTER_USE_PLUS_AGENT_ALLOWED_WINDOWS must be valid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('COMPUTER_USE_PLUS_AGENT_ALLOWED_WINDOWS must be a JSON array');
  return parsed;
}

function createHttpRuntime(currentEngine) {
  const rawPort = process.env.COMPUTER_USE_PLUS_HTTP_PORT;
  if (rawPort === undefined || rawPort === '') return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('COMPUTER_USE_PLUS_HTTP_PORT must be an integer from 0 to 65535');
  let connections = [];
  const rawConnections = process.env.COMPUTER_USE_PLUS_HTTP_CONNECTIONS;
  if (rawConnections) {
    try { connections = JSON.parse(rawConnections); }
    catch { throw new Error('COMPUTER_USE_PLUS_HTTP_CONNECTIONS must be valid JSON'); }
  }
  const runtime = new HttpMcpRuntime(currentEngine, {
    host: process.env.COMPUTER_USE_PLUS_HTTP_HOST || '127.0.0.1',
    port,
    token: process.env.COMPUTER_USE_PLUS_HTTP_TOKEN,
    connections,
    profile: toolProfile.toLowerCase() || 'fast-agent',
    allowedWindows: parseAllowedWindows(process.env.COMPUTER_USE_PLUS_AGENT_ALLOWED_WINDOWS),
    worker: createOptionalWorker()
  });
  runtime.start().then((address) => {
    process.stderr.write(`[http] listening on ${address.host}:${address.port}/mcp\n`);
  }).catch((error) => {
    process.stderr.write(`[http] ${error.message}\n`);
    process.exitCode = 1;
  });
  return runtime;
}

function createOptionalWorker() {
  const command = process.env.COMPUTER_USE_PLUS_WORKER_COMMAND;
  if (!command) return null;
  let args = [];
  if (process.env.COMPUTER_USE_PLUS_WORKER_ARGS) {
    try { args = JSON.parse(process.env.COMPUTER_USE_PLUS_WORKER_ARGS); }
    catch { throw new Error('COMPUTER_USE_PLUS_WORKER_ARGS must be a JSON array'); }
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw new Error('COMPUTER_USE_PLUS_WORKER_ARGS must be a JSON array of strings');
  }
  return new WorkerSupervisor({
    command,
    args,
    protocolVersion: process.env.COMPUTER_USE_PLUS_WORKER_PROTOCOL || '1',
    maxRestarts: process.env.COMPUTER_USE_PLUS_WORKER_MAX_RESTARTS,
    restartWindowMs: process.env.COMPUTER_USE_PLUS_WORKER_RESTART_WINDOW_MS
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request) {
  if (!request || request.jsonrpc !== '2.0') return;
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return;
  if (request.method === 'initialize') {
    return send(result(request.id, {
      protocolVersion: request.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: toolProfile.toLowerCase() === 'harness'
        ? '优先调用 shortcut_run，其次 computer_invoke。先用一次 computer_state 获取紧凑状态；已命中 shortcut 时不要重复观察 UI。动作后用 computer_verify 验证。'
        : toolProfile.toLowerCase() === 'fast-agent'
          ? '默认只调用一次 agent.run 完成目标；仅异步任务需要 agent.status，必要时使用 agent.cancel。'
          : '优先调用 agent.run 一次完成目标；需要底层控制时再使用 shortcut.run 或 computer.invoke。computer.act 保留用于兼容和调试。'
    }));
  }
  if (request.method === 'tools/list') return send(result(request.id, { tools }));
  if (request.method === 'tools/call') {
    const requestedName = request.params?.name;
    if (!allowedToolNames.has(requestedName)) return send(error(request.id, -32601, `Unknown tool: ${requestedName}`));
    const name = canonicalToolName(requestedName);
    try {
      let value;
      if (name === 'agent.run') value = await agentRuntime.run(request.params?.arguments || {});
      else if (name === 'agent.status') value = agentRuntime.status(request.params?.arguments || {});
      else if (name === 'agent.cancel') value = agentRuntime.cancel(request.params?.arguments || {});
      else if (name === 'agent.capabilities') value = agentRuntime.capabilities();
      else if (name === 'agent.internal') value = agentRuntime.internal(request.params?.arguments || {});
      else if (name === 'computer.state') value = await engine.state(request.params?.arguments || {});
      else if (name === 'computer.inspect') value = await engine.inspect(request.params?.arguments || {});
      else if (name === 'computer.wait') value = await engine.waitForTarget(request.params?.arguments || {});
      else if (name === 'computer.screenshot') value = await engine.screenshot(request.params?.arguments || {});
      else if (name === 'computer.act') value = await engine.act(request.params?.arguments || {});
  else if (name === 'computer.fast') value = await engine.fastAct(request.params?.arguments || {});
<<<<<<< HEAD
       else if (name === 'computer.ptc') value = await engine.runPtc(request.params?.arguments || {});
       else if (name === 'computer.script') value = await engine.runScript(request.params?.arguments || {});
       else if (name === 'agent.components') value = await engine.manageComponents(request.params?.arguments || {});
       else if (name === 'agent.visual_alias') value = engine.manageVisualAlias(request.params?.arguments || {});
=======
      else if (name === 'computer.ptc') value = await engine.runPtc(request.params?.arguments || {});
>>>>>>> origin/main
      else if (name === 'computer.invoke' || name === 'shortcut.run') {
        const args = request.params?.arguments || {};
        const call = name === 'shortcut.run'
          ? { type: 'tool_call', name, arguments: args }
          : { type: 'tool_call', name, arguments: args };
        value = await engine.invokeToolCall(call);
      }
      else if (name === 'computer.verify') value = await engine.verify(request.params?.arguments || {});
      else if (name === 'computer.cancel') value = engine.cancelConfirmation(request.params?.arguments || {});
      else if (name === 'computer.shortcut') value = await engine.manageShortcut(request.params?.arguments || {});
      else if (name === 'computer.execution') value = await engine.manageExecution(request.params?.arguments || {});
      else if (name === 'computer.browser') value = await engine.manageBrowser(request.params?.arguments || {});
      else return send(error(request.id, -32601, `Unknown tool: ${name}`));
      return send(result(request.id, toolResult(value)));
    } catch (err) {
      engine.metrics.failures += 1;
      return send(result(request.id, toolResult({ ok: false, reason: err.message, ...(err.actionResult ? { action: err.actionResult } : {}) }, true)));
    }
  }
  if (request.id !== undefined) send(error(request.id, -32601, `Unknown method: ${request.method}`));
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch (err) {
    return send(error(null, -32700, 'Invalid JSON'));
  }
  const operation = Promise.resolve(handle(request))
    .catch((err) => send(error(request.id, -32603, err.message)))
    .finally(() => pending.delete(operation));
  pending.add(operation);
});

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await agentRuntime.close();
    await httpRuntime?.close();
    await Promise.allSettled([...pending]);
    await engine.close?.();
    await engine.execution.destroy();
    engine.browserLauncher?.stop();
    engine.ocr.close();
  } catch (error) {
    process.stderr.write(`[shutdown] ${error.message}\n`);
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}

rl.on('close', () => shutdown(0));
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
