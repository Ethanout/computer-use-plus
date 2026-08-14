'use strict';

const vm = require('node:vm');

const DEFAULT_TOOLS = new Set(['computer_state', 'computer_inspect', 'computer_invoke', 'shortcut_run', 'computer_wait', 'computer_verify', 'computer_cancel']);

class PtcRunner {
  constructor(engine, options = {}) {
    if (!engine) throw new Error('ptc_engine_required');
    this.engine = engine;
    this.maxSteps = bounded(options.maxSteps, 1, 200, 30);
    this.maxOutputBytes = bounded(options.maxOutputBytes, 1024, 1024 * 1024, 256 * 1024);
    this.timeoutMs = bounded(options.timeoutMs, 100, 120000, 15000);
    this.allowedTools = new Set(options.allowedTools || DEFAULT_TOOLS);
  }

  async run(args = {}) {
    const code = String(args.code || '');
    if (!code.trim()) throw new Error('ptc_code_required');
    if (code.length > 128 * 1024) throw new Error('ptc_code_too_large');
    const maxSteps = bounded(args.maxSteps, 1, this.maxSteps, this.maxSteps);
    const timeoutMs = bounded(args.timeoutMs, 100, this.timeoutMs, this.timeoutMs);
    const capabilities = normalizeCapabilities(args.capabilities, this.allowedTools);
    let steps = 0;
    let outputBytes = 0;
    const call = async (name, input = {}) => {
      const canonical = String(name || '');
      if (!capabilities.has(canonical)) throw new Error('ptc_tool_not_allowed');
      steps += 1;
      if (steps > maxSteps) throw new Error('ptc_step_budget_exceeded');
      const value = await dispatch(this.engine, canonical, input);
      outputBytes += Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
      if (outputBytes > this.maxOutputBytes) throw new Error('ptc_output_budget_exceeded');
      return value;
    };
    const context = vm.createContext({
      tools: Object.freeze({ call }),
      params: Object.freeze(safeObject(args.params)),
      result: null
    }, { codeGeneration: { strings: false, wasm: false } });
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'computer-use-plus.ptc.js' });
    const execution = Promise.resolve(script.runInContext(context, { timeout: Math.min(timeoutMs, 30000) }));
    let timerId;
    const timer = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error('ptc_timeout')), timeoutMs);
      timerId.unref?.();
    });
    try {
      const value = await Promise.race([execution, timer]);
      const serialized = JSON.stringify(value ?? null);
      if (Buffer.byteLength(serialized, 'utf8') > this.maxOutputBytes) throw new Error('ptc_output_budget_exceeded');
      return { ok: true, steps, result: value ?? null };
    } finally {
      clearTimeout(timerId);
    }
  }
}

async function dispatch(engine, name, args) {
  if (name === 'computer_state') return engine.state(args);
  if (name === 'computer_inspect') return engine.inspect(args);
  if (name === 'computer_invoke') return engine.invokeToolCall({ type: 'tool_call', name: 'computer.invoke', arguments: args });
  if (name === 'shortcut_run') return engine.invokeToolCall({ type: 'tool_call', name: 'shortcut.run', arguments: args });
  if (name === 'computer_wait') return engine.waitForTarget(args);
  if (name === 'computer_verify') return engine.verify(args);
  if (name === 'computer_cancel') return engine.cancelConfirmation(args);
  throw new Error('ptc_tool_not_allowed');
}

function normalizeCapabilities(value, allowed) {
  if (value === undefined) return new Set(allowed);
  if (!Array.isArray(value) || value.length > allowed.size) throw new Error('ptc_capabilities_invalid');
  const result = new Set(value.map(String));
  for (const item of result) if (!allowed.has(item)) throw new Error('ptc_capability_not_available');
  return result;
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

module.exports = { PtcRunner, DEFAULT_TOOLS };
