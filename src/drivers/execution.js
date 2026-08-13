'use strict';

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const net = require('node:net');

const execFileAsync = promisify(execFile);

class ExecutionDesktopManager {
  constructor(options = {}) {
    this.script = options.script || path.join(__dirname, 'execution-desktop.ps1');
    this.compileScript = options.compileScript || path.join(__dirname, 'compile-desktop-agent.ps1');
    this.agentSource = options.agentSource || path.join(__dirname, 'desktop-agent.cs');
    this.dataDir = options.dataDir || path.resolve('.data');
    this.powershell = options.powershell || 'powershell.exe';
    this.captureTtlMs = options.captureTtlMs || 60 * 60 * 1000;
    this.logTtlMs = options.logTtlMs || 7 * 24 * 60 * 60 * 1000;
    this.maxLogs = options.maxLogs || 20;
    this.maxAgentBinaries = options.maxAgentBinaries || 2;
    this.housekeeping = { removed: 0, reclaimedBytes: 0, lastRunAt: null };
    this.active = null;
  }

  async control(operation, args = {}) {
    const command = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Operation', operation];
    for (const [key, value] of Object.entries(args)) if (value) command.push(`-${key}`, String(value));
    try {
      const { stdout } = await execFileAsync(this.powershell, command, { windowsHide: true });
      const output = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
      if (!output.ok) throw new Error(output.error || 'execution_desktop_failed');
      return output;
    } catch (error) {
      const lines = String(error.stdout || '').trim().split(/\r?\n/).filter(Boolean);
      if (lines.length) {
        try {
          const output = JSON.parse(lines.at(-1));
          if (output?.error) throw new Error(output.error);
        } catch (parsedError) {
          if (!(parsedError instanceof SyntaxError)) throw parsedError;
        }
      }
      throw new Error(error.message);
    }
  }

  async create() {
    if (process.platform !== 'win32') throw new Error('execution_desktop_requires_windows');
    if (this.active) return { ...this.active, reused: true };
    const agentPath = await this.ensureAgentBinary();
    const created = await this.control('create', { AgentPath: agentPath, DataDir: this.dataDir });
    this.active = {
      desktop: created.desktop,
      pipe: created.pipe,
      agentPid: created.agentPid,
      agentPath,
      logPath: created.logPath,
      createdAt: Date.now(),
      ready: Boolean(created.agentReady)
    };
    return this.active;
  }

  async launch(commandLine) {
    const active = await this.ensureReady();
    const launched = await this.request({ operation: 'launch', commandLine, workingDirectory: process.cwd() }, 10000);
    if (!launched?.ok) throw new Error(launched?.error || 'execution_launch_failed');
    return { ...launched, desktop: active.desktop };
  }

  async diagnose() {
    const active = await this.ensureReady();
    const diagnosed = await this.request({ operation: 'diagnose' }, 10000);
    if (!diagnosed?.ok) throw new Error(diagnosed?.error || 'execution_diagnostics_failed');
    return { ...diagnosed, desktop: diagnosed.desktop || active.desktop };
  }

  async destroy() {
    if (!this.active) return { ok: true, destroyed: false };
    const active = this.active;
    try { await this.request({ operation: 'shutdown' }); } catch (_) { /* Agent may already be gone. */ }
    let forced = false;
    if (!(await this.waitForProcessExit(active.agentPid, 1500))) {
      try { process.kill(active.agentPid); forced = true; } catch (_) { }
      await this.waitForProcessExit(active.agentPid, 1000);
    }
    this.active = null;
    const destroyed = await this.control('destroy', { DesktopName: active.desktop });
    return { ...destroyed, forced };
  }

  status() {
    return this.active
      ? { enabled: true, ...this.active, housekeeping: this.housekeeping }
      : { enabled: false, housekeeping: this.housekeeping };
  }

  ping(timeoutMs = 3000) {
    return this.request({ operation: 'ping' }, timeoutMs);
  }

  async ensureReady() {
    const active = await this.create();
    if (active.ready) return active;
    const ping = await this.ping(3000);
    if (!ping?.ok) throw new Error(ping?.error || 'execution_agent_not_ready');
    if (this.active) this.active.ready = true;
    return active;
  }

  async ensureAgentBinary() {
    const source = fs.readFileSync(this.agentSource);
    const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const outputPath = path.join(this.dataDir, `desktop-agent-${hash}.exe`);
    if (!fs.existsSync(outputPath)) {
      await execFileAsync(this.powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.compileScript,
        '-SourcePath', this.agentSource, '-OutputPath', outputPath
      ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    }
    if (!fs.existsSync(outputPath)) throw new Error('execution_agent_compile_failed');
    this.cleanupDataDir(outputPath);
    return outputPath;
  }

  cleanupDataDir(currentAgentPath) {
    const now = Date.now();
    const current = currentAgentPath ? path.resolve(currentAgentPath).toLocaleLowerCase() : null;
    const entries = [];
    try {
      for (const item of fs.readdirSync(this.dataDir, { withFileTypes: true })) {
        if (!item.isFile()) continue;
        const filePath = path.join(this.dataDir, item.name);
        try { entries.push({ name: item.name, path: filePath, stat: fs.statSync(filePath) }); } catch (_) { }
      }
    } catch (_) { return this.housekeeping; }

    const remove = (entry) => {
      try {
        fs.unlinkSync(entry.path);
        this.housekeeping.removed += 1;
        this.housekeeping.reclaimedBytes += entry.stat.size;
      } catch (_) { }
    };
    for (const entry of entries) {
      if (/^capture-[0-9a-f]{32}\.png$/i.test(entry.name) && now - entry.stat.mtimeMs > this.captureTtlMs) remove(entry);
    }

    const logs = entries
      .filter((entry) => /^execution-agent-.+\.log$/i.test(entry.name))
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    logs.forEach((entry, index) => {
      if (index >= this.maxLogs || now - entry.stat.mtimeMs > this.logTtlMs) remove(entry);
    });

    const agents = entries
      .filter((entry) => /^desktop-agent-[0-9a-f]{12}\.exe$/i.test(entry.name))
      .sort((left, right) => {
        const leftCurrent = path.resolve(left.path).toLocaleLowerCase() === current;
        const rightCurrent = path.resolve(right.path).toLocaleLowerCase() === current;
        if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
        return right.stat.mtimeMs - left.stat.mtimeMs;
      });
    agents.slice(this.maxAgentBinaries).forEach(remove);
    this.housekeeping.lastRunAt = now;
    return this.housekeeping;
  }

  async waitForProcessExit(processId, timeoutMs) {
    if (!Number.isInteger(Number(processId)) || Number(processId) <= 0) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      try { process.kill(Number(processId), 0); }
      catch (_) { return true; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  request(payload, timeoutMs = 3000) {
    if (!this.active) return Promise.reject(new Error('execution_desktop_not_created'));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(`\\\\.\\pipe\\${this.active.pipe}`);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('agent_timeout')); }, timeoutMs);
      let buffer = '';
      socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
      socket.on('data', (data) => {
        buffer += data.toString('utf8');
        if (!buffer.includes('\n')) return;
        clearTimeout(timer); socket.end(); resolve(JSON.parse(buffer.trim()));
      });
      socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }
}

class ExecutionDesktopDriver {
  constructor(manager) { this.manager = manager; }

  async call(operation, params = {}) {
    await this.manager.ensureReady();
    const response = await this.manager.request({ operation: 'driver', driverOperation: operation, params }, 10000);
    if (!response?.ok) throw new Error(response?.error || 'execution_driver_failed');
    if (Object.prototype.hasOwnProperty.call(response, 'value')) return response.value;
    return response;
  }

  async listWindows() { return this.asArray(await this.call('listWindows')); }
  async inspect(windowId, query) { return this.asArray(await this.call('findElements', { WindowId: String(windowId), QueryJson: query || {} })); }
  click(windowId, query) { return this.call('click', { WindowId: String(windowId), QueryJson: query || {} }); }
  setValue(windowId, query, value) { return this.call('setValue', { WindowId: String(windowId), QueryJson: query || {}, Value: value }); }
  sendKeys(windowId, keys) { return this.call('sendKeys', { WindowId: String(windowId), KeysJson: keys }); }
  focus(windowId) { return this.call('focus', { WindowId: String(windowId) }); }
  clickAt(windowId, bounds) { return this.call('clickAt', { WindowId: String(windowId), BoundsJson: bounds }); }
  async capture(windowId) {
    await this.manager.ensureReady();
    const response = await this.manager.request({ operation: 'capture', windowId: String(windowId) }, 10000);
    if (!response?.ok) throw new Error(response?.error || 'execution_capture_failed');
    return response;
  }
  asArray(value) { return Array.isArray(value) ? value : (value ? [value] : []); }
}

module.exports = { ExecutionDesktopManager, ExecutionDesktopDriver };
