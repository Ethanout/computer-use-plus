'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const vm = require('node:vm');

const CAPABILITIES = new Set(['window-control', 'filesystem', 'network', 'process']);
const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 30000, maxOutputBytes: 256 * 1024, maxCodeBytes: 128 * 1024, maxProcesses: 4 });

class ScriptRunner {
  constructor(engine, options = {}) {
    if (!engine) throw new Error('script_engine_required');
    this.engine = engine;
    this.dataDir = path.resolve(options.dataDir || engine.execution?.dataDir || '.data');
    this.rootDir = path.resolve(options.rootDir || path.join(this.dataDir, 'scripts'));
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  async run(args = {}) {
    const language = String(args.language || 'javascript').toLowerCase();
    if (!['javascript', 'powershell', 'python'].includes(language)) throw new Error('script_language_invalid');
    const code = String(args.code || '');
    if (!code.trim()) throw new Error('script_code_required');
    if (Buffer.byteLength(code, 'utf8') > this.limits.maxCodeBytes) throw new Error('script_code_too_large');
    const capabilities = normalizeCapabilities(args.capabilities);
    if (capabilities.has('process') && !capabilities.has('filesystem')) throw new Error('script_capability_requires_filesystem');
    if (capabilities.has('network') || capabilities.has('process')) {
      const operation = { type: 'script', language, digest: crypto.createHash('sha256').update(code).digest('hex'), capabilities: [...capabilities].sort() };
      if (typeof this.engine.consumeConfirmation === 'function' && !this.engine.consumeConfirmation(args.confirm_token, operation)) {
        const token = this.engine.createConfirmation(operation);
        return { ok: false, requiresConfirmation: true, confirmation: { token, risks: ['script_capability'], rules: ['script-process-or-network'], summary: { language, capabilities: [...capabilities] }, expiresInSeconds: 120 } };
      }
    }
    if (language === 'python' && !findPython(args.python)) throw new Error('python_not_available');
    const taskId = safeTaskId(args.taskId);
    const workspaceDir = path.join(this.rootDir, taskId);
    await fsp.mkdir(workspaceDir, { recursive: false }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const limits = normalizeLimits(args, this.limits);
    const cleanup = args.keepWorkspace !== true;
    try {
      if (language === 'javascript') return await this.runJavaScript(code, args, capabilities, workspaceDir, limits);
      return await this.runProcess(language, code, args, capabilities, workspaceDir, limits);
    } finally {
      if (cleanup) await fsp.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async runJavaScript(code, args, capabilities, workspaceDir, limits) {
    let steps = 0;
    let outputBytes = 0;
    const callTool = async (name, input = {}) => {
      if (!capabilities.has('window-control')) throw new Error('script_capability_not_allowed:window-control');
      if (++steps > limits.maxSteps) throw new Error('script_step_budget_exceeded');
      const value = await dispatchTool(this.engine, name, input);
      outputBytes += Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
      if (outputBytes > limits.maxOutputBytes) throw new Error('script_output_budget_exceeded');
      return value;
    };
    const api = Object.freeze({
      call: callTool,
      workspace: workspaceDir,
      readFile: capabilities.has('filesystem') ? restrictedRead(workspaceDir) : undefined,
      writeFile: capabilities.has('filesystem') ? restrictedWrite(workspaceDir, limits.maxFileBytes) : undefined
    });
    const context = vm.createContext({ api, params: Object.freeze(safeObject(args.params)), result: null }, { codeGeneration: { strings: false, wasm: false } });
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'computer-use-plus.script.js' });
    const execution = Promise.resolve(script.runInContext(context, { timeout: Math.min(limits.timeoutMs, 30000) }));
    return finalize(await withTimeout(execution, limits.timeoutMs, 'script_timeout'), steps, null);
  }

  async runProcess(language, code, args, capabilities, workspaceDir, limits) {
    if (!capabilities.has('process')) throw new Error('script_capability_not_allowed:process');
    const command = language === 'powershell' ? 'powershell.exe' : findPython(args.python);
    const scriptName = language === 'powershell' ? 'script.ps1' : 'script.py';
    const scriptPath = path.join(workspaceDir, scriptName);
    await fsp.writeFile(scriptPath, code, 'utf8');
    const argv = language === 'powershell'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
      : ['-I', scriptPath];
    const result = await spawnBounded(command, argv, { cwd: workspaceDir, timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes, maxProcesses: limits.maxProcesses });
    return { ok: result.exitCode === 0, language, workspaceDir, exitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
  }
}

function dispatchTool(engine, name, args) {
  const aliases = { state: 'computer.state', inspect: 'computer.inspect', invoke: 'computer.invoke', shortcut: 'shortcut.run', verify: 'computer.verify', wait: 'computer.wait', cancel: 'computer.cancel' };
  const canonical = aliases[String(name)] || String(name);
  if (canonical === 'computer.state') return engine.state(args);
  if (canonical === 'computer.inspect') return engine.inspect(args);
  if (canonical === 'computer.invoke') return engine.invokeToolCall({ type: 'tool_call', name: canonical, arguments: args });
  if (canonical === 'shortcut.run') return engine.invokeToolCall({ type: 'tool_call', name: canonical, arguments: args });
  if (canonical === 'computer.verify') return engine.verify(args);
  if (canonical === 'computer.wait') return engine.waitForTarget(args);
  if (canonical === 'computer.cancel') return engine.cancelConfirmation(args);
  throw new Error('script_tool_not_allowed');
}

function restrictedPath(root, candidate) {
  const resolved = path.resolve(root, String(candidate || ''));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('script_workspace_escape');
  return resolved;
}
function restrictedRead(root) { return async (file) => fsp.readFile(restrictedPath(root, file), 'utf8'); }
function restrictedWrite(root, maxBytes) { return async (file, value) => { const data = String(value ?? ''); if (Buffer.byteLength(data) > maxBytes) throw new Error('script_file_too_large'); await fsp.writeFile(restrictedPath(root, file), data, 'utf8'); return { ok: true }; }; }
function normalizeCapabilities(value) {
  if (value === undefined) return new Set(['window-control']);
  if (!Array.isArray(value) || value.length > CAPABILITIES.size) throw new Error('script_capabilities_invalid');
  const result = new Set(value.map(String));
  for (const item of result) if (!CAPABILITIES.has(item)) throw new Error(`script_capability_unknown:${item}`);
  return result;
}
function normalizeLimits(args, defaults) { return { timeoutMs: bounded(args.timeoutMs, 100, 120000, defaults.timeoutMs), maxOutputBytes: bounded(args.maxOutputBytes, 1024, 4 * 1024 * 1024, defaults.maxOutputBytes), maxCodeBytes: defaults.maxCodeBytes, maxSteps: bounded(args.maxSteps, 1, 200, 50), maxFileBytes: bounded(args.maxFileBytes, 1024, 16 * 1024 * 1024, 2 * 1024 * 1024), maxProcesses: bounded(args.maxProcesses, 1, 8, defaults.maxProcesses) }; }
function bounded(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }
function safeTaskId(value) { const raw = String(value || crypto.randomUUID()); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(raw)) throw new Error('script_task_id_invalid'); return raw; }
function safeObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}; }
function findPython(preferred) { const value = preferred || process.env.CUP_PYTHON || 'python'; try { require('node:child_process').execFileSync(value, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 3000 }); return value; } catch (_) { return null; } }
function finalize(value, steps, workspaceDir) { return { ok: true, language: 'javascript', steps, result: value ?? null, ...(workspaceDir ? { workspaceDir } : {}) }; }
function withTimeout(promise, timeoutMs, reason) { let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), timeoutMs); }); return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)); }

function spawnBounded(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.PATH || '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let bytes = 0; let done = false;
    const finish = (value, error) => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const collect = (target) => (chunk) => { bytes += chunk.length; if (bytes > options.maxOutputBytes) { child.kill(); finish(null, new Error('script_output_budget_exceeded')); return; } if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8'); };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', (error) => finish(null, error));
    child.on('close', (exitCode, signal) => finish({ ok: exitCode === 0, exitCode, signal, stdout, stderr }));
    const timer = setTimeout(() => { child.kill(); finish(null, new Error('script_timeout')); }, options.timeoutMs); timer.unref?.();
  });
}

module.exports = { ScriptRunner, CAPABILITIES, DEFAULT_LIMITS, restrictedPath, normalizeCapabilities };
