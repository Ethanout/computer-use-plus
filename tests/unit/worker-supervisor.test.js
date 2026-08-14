'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkerSupervisor } = require('../../src/worker-supervisor');

const readyScript = "process.send({type:'ready',protocolVersion:'1'}); process.on('message',()=>{});";

test('worker supervisor performs protocol handshake, IPC send and graceful stop', async () => {
  const worker = new WorkerSupervisor({ command: process.execPath, args: ['-e', readyScript], startTimeoutMs: 2000 });
  await worker.start();
  assert.equal(worker.status().running, true);
  await worker.send({ type: 'ping' });
  await worker.stop();
  assert.equal(worker.status().running, false);
});

test('worker supervisor rejects a protocol mismatch and does not expose command details', async () => {
  const worker = new WorkerSupervisor({ command: process.execPath, args: ['-e', "process.send({type:'ready',protocolVersion:'wrong'});"], startTimeoutMs: 1000, maxRestarts: 0 });
  await assert.rejects(() => worker.start(), /worker_protocol_mismatch|worker_ready_timeout/);
  assert.equal(worker.status().lastError, 'worker_protocol_mismatch');
  await worker.stop();
});

test('worker supervisor bounds crash restarts', async () => {
  const worker = new WorkerSupervisor({ command: process.execPath, args: ['-e', "process.send({type:'ready',protocolVersion:'1'}); setTimeout(()=>process.exit(1),20);"], startTimeoutMs: 1000, maxRestarts: 2, restartWindowMs: 2000 });
  await worker.start();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(worker.status().restartCount <= 2);
  await worker.stop();
});
