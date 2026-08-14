'use strict';

const fs = require('node:fs');
const path = require('node:path');

class VisualAliasStore {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.maxEntries = Math.max(10, Number(options.maxEntries || 2000));
    this.minSuccesses = Math.max(1, Number(options.minSuccesses || 3));
    this.entries = new Map();
    this.load();
  }
  key(scope, caption, role = '') { return `${String(scope)}|${normalize(caption)}|${normalize(role)}`; }
  record({ scopeKey, caption, role, alias, success = false }) {
    if (!scopeKey || !caption || !alias || !success) return { accepted: false, reason: 'unverified' };
    const key = this.key(scopeKey, caption, role); const old = this.entries.get(key) || { scopeKey: String(scopeKey), caption: normalize(caption), role: normalize(role), alias: String(alias).slice(0, 120), successes: 0, failures: 0, lastUsedAt: 0 };
    if (old.alias !== String(alias)) { old.failures += 1; return { accepted: false, reason: 'alias_conflict' }; }
    old.successes += 1; old.lastUsedAt = Date.now(); this.entries.set(key, old); this.trim(); this.save();
    return { accepted: true, stable: old.successes >= this.minSuccesses, successes: old.successes };
  }
  resolve({ scopeKey, caption, role }) {
    const value = this.entries.get(this.key(scopeKey, caption, role));
    if (!value || value.successes < this.minSuccesses) return null;
    value.lastUsedAt = Date.now(); this.save(); return { alias: value.alias, confidence: Math.min(0.99, 0.7 + value.successes / 100), successes: value.successes };
  }
  stats() { return { entries: this.entries.size, stable: [...this.entries.values()].filter((item) => item.successes >= this.minSuccesses).length, maxEntries: this.maxEntries }; }
  trim() { while (this.entries.size > this.maxEntries) { const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0]; this.entries.delete(oldest[0]); } }
  load() { try { const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); for (const item of Array.isArray(value) ? value : []) this.entries.set(this.key(item.scopeKey, item.caption, item.role), item); } catch (_) { } }
  save() { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); const temp = `${this.filePath}.tmp-${process.pid}`; fs.writeFileSync(temp, JSON.stringify([...this.entries.values()]), 'utf8'); fs.renameSync(temp, this.filePath); }
}
function normalize(value) { return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ').slice(0, 160); }
module.exports = { VisualAliasStore, normalize };
