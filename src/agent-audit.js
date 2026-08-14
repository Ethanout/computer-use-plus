'use strict';

const fs = require('node:fs');
const path = require('node:path');

class AgentAuditStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.maxBytes = boundedInteger(options.maxBytes, 4096, 16 * 1024 * 1024, 1024 * 1024);
    if (this.filePath) fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  append(event = {}) {
    if (!this.filePath) return;
    const record = sanitizeEvent(event);
    const line = `${JSON.stringify(record)}\n`;
    this.rotateIfNeeded(Buffer.byteLength(line));
    fs.appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
  }

  query(taskId, limit = 50) {
    if (!this.filePath || !fs.existsSync(this.filePath)) return [];
    const safeLimit = boundedInteger(limit, 1, 100, 50);
    const lines = fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    const output = [];
    for (let index = lines.length - 1; index >= 0 && output.length < safeLimit; index -= 1) {
      try {
        const item = JSON.parse(lines[index]);
        if (!taskId || item.taskId === String(taskId)) output.push(item);
      } catch (_) { }
    }
    return output.reverse();
  }

  rotateIfNeeded(incomingBytes) {
    if (!fs.existsSync(this.filePath)) return;
    const size = fs.statSync(this.filePath).size;
    if (size + incomingBytes <= this.maxBytes) return;
    const bytes = fs.readFileSync(this.filePath);
    const keepBytes = Math.max(0, this.maxBytes - incomingBytes - Math.floor(this.maxBytes / 4));
    let start = Math.max(0, bytes.length - keepBytes);
    if (start > 0) {
      const newline = bytes.indexOf(0x0a, start);
      start = newline < 0 ? bytes.length : newline + 1;
    }
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, bytes.subarray(start), { mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
  }
}

function sanitizeEvent(event) {
  const allowed = [
    'taskId', 'event', 'status', 'revision', 'op', 'outcome', 'reason',
    'window', 'process', 'className', 'actionType', 'candidateHash', 'index', 'total'
  ];
  const record = { at: new Date().toISOString() };
  for (const key of allowed) {
    const value = event[key];
    if (value === undefined || value === null || value === '') continue;
    if (['revision', 'index', 'total'].includes(key)) record[key] = Number(value);
    else record[key] = String(value).slice(0, 160);
  }
  return record;
}

function boundedInteger(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error('agent_audit_limit_invalid');
  return number;
}

module.exports = { AgentAuditStore, sanitizeEvent };
