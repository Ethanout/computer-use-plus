'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

class PowerShellDriver {
  constructor(scriptPath = path.join(__dirname, 'desktop.ps1')) {
    this.scriptPath = scriptPath;
    this.command = process.platform === 'win32' ? 'powershell.exe' : null;
  }

  async call(operation, params = {}) {
    if (!this.command) throw new Error('Windows driver is only available on win32');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Operation', operation];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string') args.push(`-${key}`, value);
      else args.push(`-${key}Base64`, Buffer.from(JSON.stringify(value), 'utf8').toString('base64'));
    }
    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await execFileAsync(this.command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
    } catch (error) {
      const payload = this.parsePayload(error.stdout || '');
      if (payload?.error) throw new Error(payload.error);
      throw error;
    }
    if (stderr.trim()) process.stderr.write(`[powershell] ${stderr.trim()}\n`);
    const payload = this.parsePayload(stdout);
    if (payload?.error) throw new Error(payload.error);
    return payload;
  }

  parsePayload(stdout) {
    const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  }

  async listWindows() { return this.asArray(await this.call('listWindows')); }
  async inspect(windowId, query) { return this.asArray(await this.call('findElements', { WindowId: windowId, QueryJson: query || {} })); }
  click(windowId, query) { return this.call('click', { WindowId: windowId, QueryJson: query || {} }); }
  setValue(windowId, query, value) { return this.call('setValue', { WindowId: windowId, QueryJson: query || {}, Value: value }); }
  sendKeys(windowId, keys) { return this.call('sendKeys', { WindowId: windowId, KeysJson: keys }); }
  focus(windowId) { return this.call('focus', { WindowId: windowId }); }
  clickAt(windowId, bounds) { return this.call('clickAt', { WindowId: windowId, BoundsJson: bounds }); }

  asArray(value) { return Array.isArray(value) ? value : (value ? [value] : []); }
}

module.exports = { PowerShellDriver };
