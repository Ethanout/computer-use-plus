'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentAuditStore, sanitizeEvent } = require('../../src/agent-audit');

test('audit sanitizes sensitive action payloads and retains bounded metadata', () => {
  const record = sanitizeEvent({
    taskId: 'task_1', event: 'task.paused', goal: 'secret goal', params: { value: 'secret' },
    action: { setValue: { value: 'password' } }, key: 'Ctrl+Alt+X', screenshot: 'base64',
    candidateHash: 'abc', index: 1, total: 2
  });
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /secret|password|Ctrl|base64/i);
  assert.equal(record.candidateHash, 'abc');
  assert.equal(record.index, 1);
});

test('audit store rotates while keeping records readable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  const store = new AgentAuditStore(file, { maxBytes: 4096 });
  for (let i = 0; i < 100; i += 1) store.append({ taskId: `task_${i}`, event: 'task.created', status: 'queued', revision: 1 });
  assert.ok(fs.statSync(file).size <= 4096);
  const events = store.query('', 100);
  assert.ok(events.length > 0);
  assert.ok(events.every((item) => item.event === 'task.created'));
});
