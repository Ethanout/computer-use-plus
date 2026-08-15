'use strict';

const path = require('node:path');
const { WorkerSupervisor } = require('./worker-supervisor');
const { ProviderConfigStore } = require('./provider-config');

class ProviderWorkerClient {
  constructor(options = {}) {
    this.configFile = path.resolve(options.configFile || path.join(options.dataDir || '.data', 'providers.json'));
    this.configStore = options.configStore || new ProviderConfigStore(this.configFile);
    this.startOptions = options.startOptions || {};
    this.supervisor = options.supervisor || new WorkerSupervisor({
      command: options.command || process.execPath,
      args: options.args || [path.join(__dirname, 'provider-worker.js')],
      cwd: options.cwd,
      env: { COMPUTER_USE_PLUS_PROVIDER_CONFIG_FILE: this.configFile, ...(options.env || {}) },
      maxRestarts: options.maxRestarts,
      startTimeoutMs: options.startTimeoutMs,
      protocolVersion: '1'
    });
  }

  get configured() { return this.publicProviderStatus().configured; }
  get inputUsdPerMillion() { return Number(this.publicProviderStatus().inputUsdPerMillion || 0); }
  get outputUsdPerMillion() { return Number(this.publicProviderStatus().outputUsdPerMillion || 0); }

  publicProviderStatus() {
    const workerStatus = this.supervisor.status().workerStatus;
    try {
      const listed = this.configStore.list();
      const active = listed.profiles.find((profile) => profile.id === listed.active);
      const configured = active ? { configured: active.configured, model: active.model, protocol: active.protocol, inputUsdPerMillion: active.inputUsdPerMillion, outputUsdPerMillion: active.outputUsdPerMillion } : { configured: false };
      return workerStatus ? { ...configured, ...workerStatus } : configured;
    } catch { return { configured: false }; }
  }

  status() {
    const status = this.supervisor.status();
    const provider = this.publicProviderStatus();
    return { ...provider, configured: provider.configured === true, running: status.running, pid: status.pid, worker: status };
  }

  async start() { await this.supervisor.start(); return this.status(); }
  async close() { await this.supervisor.stop(); }
  async request(method, args = {}, timeoutMs) {
    await this.start();
    return this.supervisor.request({ method, args: serializableArgs(args) }, { timeoutMs });
  }
  async planToolCall(args) { return this.request('planToolCall', args, args.timeoutMs); }
  async planToolCallStream(args) {
    const result = await this.request('planToolCallStream', args, args.timeoutMs);
    if (typeof args.onToolCall === 'function') await args.onToolCall(result);
    return result;
  }
  async plan(args) { return this.request('plan', args, args.timeoutMs); }
  async organize(args) { return this.request('organize', args, args.timeoutMs); }
}

function serializableArgs(args) {
  const output = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (typeof value === 'function' || key === 'signal') continue;
    output[key] = value;
  }
  return output;
}

module.exports = { ProviderWorkerClient, serializableArgs };
