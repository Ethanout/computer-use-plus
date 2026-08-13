'use strict';

class BenchmarkRecorder {
  constructor(metadata = {}) {
    this.metadata = { ...metadata };
    this.samples = [];
  }

  record(sample = {}) {
    const normalized = {
      name: String(sample.name || 'unnamed').slice(0, 120),
      application: String(sample.application || 'unknown').slice(0, 80),
      strategy: String(sample.strategy || 'unknown').slice(0, 80),
      success: sample.success === true,
      latencyMs: finite(sample.latencyMs),
      inputTokens: finite(sample.inputTokens),
      outputTokens: finite(sample.outputTokens),
      mcpRoundTrips: finite(sample.mcpRoundTrips),
      screenshots: finite(sample.screenshots),
      screenshotBytes: finite(sample.screenshotBytes),
      estimatedCostUsd: finite(sample.estimatedCostUsd),
      recoveryCount: finite(sample.recoveryCount),
      failureReason: sample.success === true ? null : String(sample.failureReason || 'unknown').slice(0, 200)
    };
    this.samples.push(normalized);
    return normalized;
  }

  summary() {
    const latencies = this.samples.map((item) => item.latencyMs).sort((a, b) => a - b);
    const successful = this.samples.filter((item) => item.success).length;
    return {
      metadata: this.metadata,
      generatedAt: new Date().toISOString(),
      samples: this.samples.length,
      successes: successful,
      successRate: this.samples.length ? successful / this.samples.length : 0,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) || 0 },
      totals: {
        inputTokens: sum(this.samples, 'inputTokens'), outputTokens: sum(this.samples, 'outputTokens'),
        mcpRoundTrips: sum(this.samples, 'mcpRoundTrips'), screenshots: sum(this.samples, 'screenshots'),
        screenshotBytes: sum(this.samples, 'screenshotBytes'), estimatedCostUsd: sum(this.samples, 'estimatedCostUsd'),
        recoveryCount: sum(this.samples, 'recoveryCount')
      },
      byStrategy: group(this.samples, 'strategy'),
      byApplication: group(this.samples, 'application')
    };
  }
}

function finite(value) { const number = Number(value || 0); return Number.isFinite(number) && number >= 0 ? number : 0; }
function sum(items, key) { return items.reduce((total, item) => total + finite(item[key]), 0); }
function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}
function group(items, key) {
  const result = {};
  for (const value of new Set(items.map((item) => item[key]))) {
    const selected = items.filter((item) => item[key] === value);
    const latencies = selected.map((item) => item.latencyMs).sort((a, b) => a - b);
    result[value] = { samples: selected.length, successRate: selected.filter((item) => item.success).length / selected.length, p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95) };
  }
  return result;
}

module.exports = { BenchmarkRecorder, percentile };
