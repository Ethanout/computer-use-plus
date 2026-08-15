'use strict';

const path = require('node:path');
const { WorkerSupervisor } = require('./worker-supervisor');

class ComponentWorkerManager {
  constructor(componentManager, options = {}) {
    if (!componentManager) throw new Error('component_manager_required');
    this.components = componentManager;
    this.workers = new Map();
    this.maxWorkers = Math.max(1, Math.min(Number(options.maxWorkers) || 4, 16));
  }

  status() {
    return Object.fromEntries([...this.workers.entries()].map(([id, worker]) => [id, worker.status()]));
  }

  async start(id) {
    const manifest = this.components.activeManifest(id);
    if (!manifest?.runtime) throw new Error('component_runtime_not_declared');
    if (this.workers.has(manifest.id)) return { ok: true, id: manifest.id, reused: true, worker: this.workers.get(manifest.id).status() };
    if (this.workers.size >= this.maxWorkers) throw new Error('component_worker_limit_exceeded');
    const entrypoint = path.resolve(manifest.versionDir, manifest.runtime.entrypoint);
    if (!entrypoint.startsWith(`${path.resolve(manifest.versionDir)}${path.sep}`)) throw new Error('component_runtime_entrypoint_invalid');
    const command = !manifest.runtime.command
      ? process.execPath
      : manifest.runtime.command === process.execPath
      ? process.execPath
      : path.resolve(manifest.versionDir, manifest.runtime.command);
    if (command !== process.execPath && !command.startsWith(`${path.resolve(manifest.versionDir)}${path.sep}`)) throw new Error('component_runtime_command_invalid');
    const worker = new WorkerSupervisor({
      command,
      args: [entrypoint, ...manifest.runtime.args],
      cwd: manifest.versionDir,
      protocolVersion: manifest.runtime.protocolVersion,
      transport: manifest.runtime.transport,
      maxRestarts: 3
    });
    this.workers.set(manifest.id, worker);
    try {
      await worker.start();
      return { ok: true, id: manifest.id, worker: worker.status() };
    } catch (error) {
      this.workers.delete(manifest.id);
      await worker.stop().catch(() => {});
      throw error;
    }
  }

  async request(id, payload, options = {}) {
    const worker = this.workers.get(String(id));
    if (!worker) throw new Error('component_worker_not_running');
    return worker.request(payload, options);
  }

  async stop(id) {
    const key = String(id);
    const worker = this.workers.get(key);
    if (!worker) return { ok: true, stopped: false, id: key };
    await worker.stop();
    this.workers.delete(key);
    return { ok: true, stopped: true, id: key };
  }

  async stopAll() {
    await Promise.allSettled([...this.workers.keys()].map((id) => this.stop(id)));
  }
}

module.exports = { ComponentWorkerManager };
