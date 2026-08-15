'use strict';

const { spawn } = require('node:child_process');

class WorkerSupervisor {
  constructor(options = {}) {
    this.command = options.command || process.execPath;
    this.args = Array.isArray(options.args) ? options.args.slice() : [];
    this.cwd = options.cwd;
    this.env = options.env ? { ...process.env, ...options.env } : process.env;
    this.protocolVersion = String(options.protocolVersion || '1');
    this.transport = options.transport === 'stdio' ? 'stdio' : 'ipc';
    this.maxMessageBytes = bounded(options.maxMessageBytes, 1024, 16 * 1024 * 1024, 1024 * 1024);
    this.maxRestarts = bounded(options.maxRestarts, 0, 20, 3);
    this.restartWindowMs = bounded(options.restartWindowMs, 1000, 24 * 60 * 60 * 1000, 60 * 1000);
    this.startTimeoutMs = bounded(options.startTimeoutMs, 100, 120000, 10000);
    this.child = null;
    this.started = false;
    this.stopping = false;
    this.restartCount = 0;
    this.restartWindowStartedAt = 0;
    this.lastError = null;
    this.startPromise = null;
    this.restartTimer = null;
    this.pending = new Map();
    this.requestSequence = 0;
    this.workerStatus = null;
  }

  async start() {
    if (this.started && this.child) return this.status();
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = new Promise((resolve, reject) => {
      const stdio = this.transport === 'stdio' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore', 'ipc'];
      const child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio, windowsHide: true });
      this.child = child;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.lastError = 'worker_ready_timeout';
        child.kill();
        reject(new Error(this.lastError));
      }, this.startTimeoutMs);
      timer.unref?.();
      child.once('error', (error) => {
        this.lastError = error.message === 'spawn UNKNOWN' ? 'worker_spawn_failed' : 'worker_spawn_failed';
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(this.lastError)); }
      });
      const handleMessage = (message) => {
        if (message?.type === 'response' && message.id) {
          const pending = this.pending.get(String(message.id));
          if (pending) { this.pending.delete(String(message.id)); clearTimeout(pending.timer); if (message.error) pending.reject(new Error(String(message.error))); else pending.resolve(message.result); }
          return;
        }
        if (!message || message.type !== 'ready') return;
        if (String(message.protocolVersion || '') !== this.protocolVersion) {
          this.lastError = 'worker_protocol_mismatch';
          child.kill();
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error(this.lastError)); }
          return;
        }
        this.started = true;
        this.workerStatus = message.status && typeof message.status === 'object' ? { ...message.status } : null;
        this.lastError = null;
        if (!settled) { settled = true; clearTimeout(timer); resolve(this.status()); }
      };
      if (this.transport === 'stdio') {
        let buffer = '';
        child.stderr.resume();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer, 'utf8') > this.maxMessageBytes) {
            this.lastError = 'worker_message_too_large';
            buffer = '';
            child.kill();
            return;
          }
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try { handleMessage(JSON.parse(line)); }
            catch (_) { this.lastError = 'worker_message_invalid'; }
          }
        });
      } else child.on('message', handleMessage);
      child.on('exit', (code, signal) => {
        const expected = this.stopping;
        this.child = null;
        this.started = false;
        this.workerStatus = null;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('worker_restarted')); }
        this.pending.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (!expected) reject(new Error(this.lastError || `worker_exit_${code ?? signal ?? 'unknown'}`));
        }
        if (!expected && !this.stopping) this.scheduleRestart();
      });
    }).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async send(message) {
    if (!this.started || !this.child) throw new Error('worker_not_ready');
    await this.writeMessage(message);
  }

  async request(payload, options = {}) {
    if (!this.started || !this.child) throw new Error('worker_not_ready');
    const id = `${process.pid}-${++this.requestSequence}`;
    const timeoutMs = bounded(options.timeoutMs, 100, 120000, 30000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('worker_request_timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage({ type: 'request', id, payload }).catch(() => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('worker_send_failed'));
      });
    });
  }

  writeMessage(message) {
    if (!this.child) return Promise.reject(new Error('worker_not_ready'));
    if (this.transport === 'stdio') {
      const encoded = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(encoded, 'utf8') > this.maxMessageBytes) return Promise.reject(new Error('worker_message_too_large'));
      return new Promise((resolve, reject) => this.child.stdin.write(encoded, (error) => error ? reject(new Error('worker_send_failed')) : resolve()));
    }
    return new Promise((resolve, reject) => this.child.send(message, (error) => error ? reject(new Error('worker_send_failed')) : resolve()));
  }

  scheduleRestart() {
    const now = Date.now();
    if (!this.restartWindowStartedAt || now - this.restartWindowStartedAt > this.restartWindowMs) {
      this.restartWindowStartedAt = now;
      this.restartCount = 0;
    }
    if (this.restartCount >= this.maxRestarts) {
      this.lastError = 'worker_restart_limit_exceeded';
      return;
    }
    this.restartCount += 1;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; void this.start().catch(() => {}); }, Math.min(5000, 100 * 2 ** (this.restartCount - 1)));
    this.restartTimer.unref?.();
  }

  status() {
    return {
      configured: true,
      running: Boolean(this.started && this.child),
      pid: this.child?.pid || null,
      protocolVersion: this.protocolVersion,
      transport: this.transport,
      restartCount: this.restartCount,
      maxRestarts: this.maxRestarts,
      lastError: this.lastError,
      workerStatus: this.workerStatus ? { ...this.workerStatus } : null
    };
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) { this.started = false; return; }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
    this.child = null;
    this.started = false;
  }
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

module.exports = { WorkerSupervisor };
