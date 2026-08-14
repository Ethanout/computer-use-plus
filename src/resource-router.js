'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');

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

  async probe() {
    const base = this.snapshot();
    const [battery, gpu] = await Promise.all([probeBattery(), probeGpu()]);
    return { ...base, battery, gpu };
  }

  choose(request = {}) {
    const state = request.resources || this.snapshot();
    const requested = String(request.mode || 'auto');
    if (requested !== 'auto') return { strategy: requested, reason: 'explicit', resources: compact(state) };
    if (state.battery?.onBattery && this.batteryPolicy === 'avoid-heavy') return { strategy: 'uia-ocr', reason: 'battery_saver', resources: compact(state) };
    if (state.freeMemoryBytes < this.lowMemoryBytes || Number(state.load1m || 0) > this.lowCpuPercent || (state.gpu?.memoryFreeBytes !== undefined && state.gpu.memoryFreeBytes < 512 * 1024 * 1024)) return { strategy: 'uia-ocr', reason: 'resource_pressure', resources: compact(state) };
    if (request.visionAvailable && request.isolated) return { strategy: 'uia-omniparser-vision', reason: 'resources_available', resources: compact(state) };
    if (request.ocrAvailable) return { strategy: 'uia-ocr', reason: 'local_fallback', resources: compact(state) };
    return { strategy: 'uia', reason: 'deterministic_only', resources: compact(state) };
  }
}

function detectBattery() {
  if (process.platform !== 'win32') return { known: false };
  return { known: false, reason: 'battery_probe_not_configured' };
}
function compact(value) { return { freeMemoryBytes: value.freeMemoryBytes, memoryUsedRatio: value.memoryUsedRatio, load1m: value.load1m, battery: value.battery || null, gpu: value.gpu || null }; }
function runProbe(command, args, parser) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && command === 'powershell.exe') return resolve(null);
    execFile(command, args, { windowsHide: true, timeout: 1500, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(error ? null : parser(String(stdout))));
  });
}
function probeBattery() {
  if (process.platform !== 'win32') return Promise.resolve({ known: false });
  return runProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress"], (text) => {
    try { const value = JSON.parse(text); const item = Array.isArray(value) ? value[0] : value; return { known: Boolean(item), onBattery: Boolean(item && Number(item.BatteryStatus) !== 2), chargePercent: item?.EstimatedChargeRemaining == null ? null : Number(item.EstimatedChargeRemaining) }; } catch (_) { return { known: false }; }
  }).then((value) => value || { known: false });
}
function probeGpu() {
  return runProbe('nvidia-smi.exe', ['--query-gpu=name,memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits'], (text) => {
    const [name, total, free, utilization] = text.trim().split(',').map((value) => value.trim());
    if (!name) return { known: false };
    return { known: true, name, memoryTotalBytes: Number(total) * 1024 * 1024, memoryFreeBytes: Number(free) * 1024 * 1024, utilizationPercent: Number(utilization) };
  }).then((value) => value || { known: false });
}

module.exports = { ResourceRouter, detectBattery, probeBattery, probeGpu };
