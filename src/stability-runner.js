'use strict';

const SAFE_TOOLS = new Set(['computer.state', 'computer.inspect']);

class StabilityRunner {
  constructor(options = {}) {
    this.createEngine = options.createEngine || (() => null);
    this.callTool = options.callTool || null;
    this.getResource = options.getResource || defaultResource;
    this.now = options.now || (() => Date.now());
  }

  validate(config) {
    if (!config || typeof config !== 'object') throw new Error('stability_config_required');
    const iterations = optionalInteger(config.iterations, 1, 100000);
    const durationMs = integer(config.durationMs, 0, 24 * 60 * 60 * 1000, 0);
    if (!iterations && !durationMs) throw new Error('stability_bound_required');
    const task = config.task || { tool: 'computer.state', arguments: {} };
    if (!SAFE_TOOLS.has(task.tool)) throw new Error('stability_tool_not_allowed');
    if (task.arguments !== undefined && (!task.arguments || typeof task.arguments !== 'object' || Array.isArray(task.arguments))) throw new Error('stability_arguments_invalid');
    return {
      iterations,
      durationMs,
      task,
      maxHeapGrowthBytes: integer(config.maxHeapGrowthBytes, 0, 8 * 1024 * 1024 * 1024, 256 * 1024 * 1024),
      maxActiveHandleGrowth: integer(config.maxActiveHandleGrowth, 0, 10000, 20)
    };
  }

  async run(config, options = {}) {
    const input = this.validate(config);
    if (options.dryRun) return { ok: true, dryRun: true, ...input, samples: 0, failures: 0 };
    const engine = await this.createEngine(config);
    const call = this.callTool || ((name, args) => dispatch(engine, name, args));
    const startedAt = this.now();
    const baseline = this.getResource();
    let samples = 0;
    let failures = 0;
    const latencies = [];
    let firstError = null;
    try {
      while ((input.iterations === null || samples < input.iterations) && (!input.durationMs || this.now() - startedAt < input.durationMs)) {
        const sampleStarted = this.now();
        try { await call(input.task.tool, input.task.arguments || {}); }
        catch (error) { failures += 1; firstError ||= stableError(error); }
        latencies.push(this.now() - sampleStarted);
        samples += 1;
      }
    } finally { if (engine?.close) await Promise.resolve(engine.close()).catch(() => {}); }
    const final = this.getResource();
    const heapGrowthBytes = Math.max(0, Number(final.heapUsed || 0) - Number(baseline.heapUsed || 0));
    const rssGrowthBytes = Number(final.rss || 0) - Number(baseline.rss || 0);
    const activeHandleGrowth = resourceDifference(final.activeHandles, baseline.activeHandles);
    return {
      ok: failures === 0 && heapGrowthBytes <= input.maxHeapGrowthBytes && (activeHandleGrowth === null || activeHandleGrowth <= input.maxActiveHandleGrowth),
      samples,
      failures,
      firstError,
      elapsedMs: this.now() - startedAt,
      averageLatencyMs: average(latencies),
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      baseline,
      final,
      heapGrowthBytes,
      rssGrowthBytes,
      activeHandleGrowth,
      maxHeapGrowthBytes: input.maxHeapGrowthBytes,
      maxActiveHandleGrowth: input.maxActiveHandleGrowth
    };
  }
}

async function dispatch(engine, name, args) {
  if (name === 'computer.state') return engine.state(args);
  if (name === 'computer.inspect') return engine.inspect(args);
  throw new Error('stability_tool_not_allowed');
}

function defaultResource() {
  const memory = process.memoryUsage();
  return { rss: memory.rss, heapUsed: memory.heapUsed, activeHandles: typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : null };
}

function integer(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('stability_limit_invalid');
  return number;
}

function optionalInteger(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  return integer(value, min, max, min);
}

function resourceDifference(value, baseline) {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(baseline))) return null;
  return Number(value) - Number(baseline);
}

function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function stableError(error) { return String(error?.message || 'stability_task_failed').slice(0, 160); }

module.exports = { StabilityRunner, SAFE_TOOLS, dispatch };
