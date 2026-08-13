'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

class OcrDriver {
  constructor(options = {}) {
    this.python = options.python || process.env.COMPUTER_USE_PLUS_PYTHON || 'python';
    this.script = options.script || path.join(__dirname, 'ocr_worker.py');
    this.child = null;
    this.pending = [];
    this.buffer = '';
    this.available = process.platform === 'win32';
  }

  start() {
    if (!this.available) throw new Error('ocr_unavailable');
    if (this.child) return;
    this.child = spawn(this.python, [this.script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => process.stderr.write(`[ocr] ${chunk}`));
    this.child.on('exit', (code) => {
      const error = new Error(`ocr_worker_exited:${code}`);
      for (const pending of this.pending.splice(0)) pending.reject(error);
      this.child = null;
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const pending = this.pending.shift();
      if (!pending) continue;
      try {
        const payload = JSON.parse(line);
        if (payload.error) pending.reject(new Error(payload.error));
        else pending.resolve(payload);
      } catch (error) { pending.reject(error); }
    }
  }

  request(message) {
    this.start();
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async inspect(bounds, query = {}) {
    const response = await this.request({ op: 'capture', bounds, query });
    return response.elements || [];
  }

  async inspectImage(imagePath, origin, query = {}) {
    const response = await this.request({ op: 'image', path: imagePath, origin, query });
    return response.elements || [];
  }

  close() { this.child?.kill(); }
}

module.exports = { OcrDriver };
