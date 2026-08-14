'use strict';

const os = require('node:os');

class ResourceRouter {
  constructor(options = {}) {
    this.lowMemoryBytes = Number(options.lowMemoryBytes || 2 * 1024 * 1024 * 1024);
    this.lowCpuPercent = Number(options.lowCpuPercent || 85);
    this.batteryPolicy = options.batteryPolicy || 'avoid-heavy';
  }

  snapshot() {
    const total = os.totalmem(); const free = os.freemem();
    return { platform: process.platform, arch: process.arch, cpuCount: os.cpus().length, load1m: os.loadavg()[0], totalMemoryBytes: total, freeMemoryBytes: free, memoryUsedRatio: total ? 1 - free / total : 0, battery: detectBattery() };
  }

  choose(request = {}) {
    const state = request.resources || this.snapshot();
    const requested = String(request.mode || 'auto');
    if (requested !== 'auto') return { strategy: requested, reason: 'explicit', resources: compact(state) };
    if (state.battery?.onBattery && this.batteryPolicy === 'avoid-heavy') return { strategy: 'uia-ocr', reason: 'battery_saver', resources: compact(state) };
    if (state.freeMemoryBytes < this.lowMemoryBytes || Number(state.load1m || 0) > this.lowCpuPercent) return { strategy: 'uia-ocr', reason: 'resource_pressure', resources: compact(state) };
    if (request.visionAvailable && request.isolated) return { strategy: 'uia-omniparser-vision', reason: 'resources_available', resources: compact(state) };
    if (request.ocrAvailable) return { strategy: 'uia-ocr', reason: 'local_fallback', resources: compact(state) };
    return { strategy: 'uia', reason: 'deterministic_only', resources: compact(state) };
  }
}

function detectBattery() {
  if (process.platform !== 'win32') return { known: false };
  return { known: false, reason: 'battery_probe_not_configured' };
}
function compact(value) { return { freeMemoryBytes: value.freeMemoryBytes, memoryUsedRatio: value.memoryUsedRatio, load1m: value.load1m, battery: value.battery || null }; }

module.exports = { ResourceRouter, detectBattery };
