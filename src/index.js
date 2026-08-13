'use strict';

const readline = require('node:readline');
const { ComputerEngine } = require('./engine');
const { SERVER_INFO, toolsForProfile, canonicalToolName, result, error, toolResult } = require('./protocol');

const engine = new ComputerEngine();
const toolProfile = process.env.COMPUTER_USE_PLUS_TOOL_PROFILE || '';
const tools = toolsForProfile(toolProfile);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = Promise.resolve();
let shuttingDown = false;

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
        : '优先调用 shortcut.run 或 computer.invoke；已命中本地 shortcut 时不要重复读取完整 UI。computer.act 保留用于兼容和调试。'
    }));
  }
  if (request.method === 'tools/list') return send(result(request.id, { tools }));
  if (request.method === 'tools/call') {
    const name = canonicalToolName(request.params?.name);
    try {
      let value;
      if (name === 'computer.state') value = await engine.state(request.params?.arguments || {});
      else if (name === 'computer.inspect') value = await engine.inspect(request.params?.arguments || {});
      else if (name === 'computer.wait') value = await engine.waitForTarget(request.params?.arguments || {});
      else if (name === 'computer.screenshot') value = await engine.screenshot(request.params?.arguments || {});
      else if (name === 'computer.act') value = await engine.act(request.params?.arguments || {});
      else if (name === 'computer.fast') value = await engine.fastAct(request.params?.arguments || {});
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
  pending = pending
    .then(() => handle(request))
    .catch((err) => send(error(request.id, -32603, err.message)));
});

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await pending;
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
