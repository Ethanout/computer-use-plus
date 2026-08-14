'use strict';

const { spawn } = require('node:child_process');

class WorkerSupervisor {
  constructor(options = {}) {
    this.command = options.command || process.execPath;
    this.args = Array.isArray(options.args) ? options.args.slice() : [];
    this.cwd = options.cwd;
    this.env = options.env ? { ...process.env, ...options.env } : process.env;
    this.protocolVersion = String(options.protocolVersion || '1');
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
  }

  async start() {
    if (this.started && this.child) return this.status();
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
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
      child.on('message', (message) => {
        if (!message || message.type !== 'ready') return;
        if (String(message.protocolVersion || '') !== this.protocolVersion) {
          this.lastError = 'worker_protocol_mismatch';
          child.kill();
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error(this.lastError)); }
          return;
        }
        this.started = true;
        this.lastError = null;
        if (!settled) { settled = true; clearTimeout(timer); resolve(this.status()); }
      });
      child.on('exit', (code, signal) => {
        const expected = this.stopping;
        this.child = null;
        this.started = false;
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
    await new Promise((resolve, reject) => this.child.send(message, (error) => error ? reject(new Error('worker_send_failed')) : resolve()));
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
      restartCount: this.restartCount,
      maxRestarts: this.maxRestarts,
      lastError: this.lastError
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
