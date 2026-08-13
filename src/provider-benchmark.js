'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ToolCallProvider } = require('./providers');
const { TOOL_DEFINITIONS } = require('./tool-call');
const { BLOCKED_KEY_FILES } = require('./fast-ai');

const SYSTEM = 'Return exactly one native computer tool call. Do not return prose.';
const USER = {
  goal: 'Inspect the Save button in window 42',
  window: '42',
  snapshot: { windows: [{ id: '42', title: 'Editor', nodes: [{ ref: 's1n1', name: 'Save', role: 'button', interactive: true }] }] }
};

class ProviderBenchmark {
  constructor(options = {}) { this.fetch = options.fetch || globalThis.fetch; this.env = options.env || process.env; }

  async run(config) {
    if (!config || !Array.isArray(config.providers) || !config.providers.length) throw new Error('provider_benchmark_config_required');
    const repeats = bounded(config.repeats, 1, 20, 3);
    const samples = [];
    for (const definition of config.providers) {
      const key = resolveKey(definition, this.env);
      if (!key) {
        samples.push({ provider: definition.name || definition.model, configured: false, reason: 'api_key_missing' });
        continue;
      }
      const provider = new ToolCallProvider({ ...definition, apiKey: key, fetch: this.fetch });
      for (const mode of definition.modes || ['standard', 'stream']) {
        for (let iteration = 1; iteration <= repeats; iteration += 1) {
          samples.push(await measure(provider, definition, mode, iteration));
        }
      }
    }
    return { generatedAt: new Date().toISOString(), repeats, samples, summary: summarize(samples) };
  }
}

async function measure(provider, definition, mode, iteration) {
  const started = performance.now();
  let dispatchMs = null;
  try {
    const call = mode === 'stream'
      ? await provider.callStream({ system: SYSTEM, user: USER, tools: TOOL_DEFINITIONS, onToolCall: () => { if (dispatchMs === null) dispatchMs = performance.now() - started; } })
      : await provider.call({ system: SYSTEM, user: USER, tools: TOOL_DEFINITIONS });
    const latencyMs = performance.now() - started;
    const valid = ['computer.inspect', 'computer.state'].includes(call.name) && String(call.arguments.window || '') === '42';
    const inputTokens = number(call.usage?.input_tokens ?? call.usage?.prompt_tokens);
    const outputTokens = number(call.usage?.output_tokens ?? call.usage?.completion_tokens);
    return {
      provider: definition.name || definition.model, model: definition.model, protocol: provider.protocol, mode, iteration,
      success: valid, latencyMs, dispatchMs: dispatchMs ?? latencyMs, inputTokens, outputTokens,
      estimatedCostUsd: estimateCost(inputTokens, outputTokens, definition), ...(valid ? {} : { reason: 'unexpected_tool_call' })
    };
  } catch (error) {
    return { provider: definition.name || definition.model, model: definition.model, protocol: provider.protocol, mode, iteration, success: false, latencyMs: performance.now() - started, dispatchMs, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, reason: String(error.message || error).slice(0, 200) };
  }
}

function resolveKey(definition, env) {
  if (definition.apiKeyEnv) return String(env[definition.apiKeyEnv] || '').trim();
  if (!definition.apiKeyFile) return '';
  const resolved = path.resolve(String(definition.apiKeyFile)).toLocaleLowerCase();
  if (BLOCKED_KEY_FILES.has(resolved)) throw new Error('provider_benchmark_key_file_blocked');
  try { return fs.readFileSync(definition.apiKeyFile, 'utf8').trim(); } catch (_) { return ''; }
}

function summarize(samples) {
  const configured = samples.filter((sample) => sample.configured !== false);
  const groups = {};
  for (const sample of configured) {
    const key = `${sample.provider}:${sample.mode}`;
    (groups[key] ||= []).push(sample);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, values]) => {
    const latencies = values.map((item) => item.latencyMs).sort((a, b) => a - b);
    const dispatches = values.map((item) => item.dispatchMs).filter(Number.isFinite).sort((a, b) => a - b);
    return [key, {
      samples: values.length, successRate: values.filter((item) => item.success).length / values.length,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
      dispatchMs: { p50: percentile(dispatches, 0.5), p95: percentile(dispatches, 0.95) },
      inputTokens: values.reduce((total, item) => total + item.inputTokens, 0),
      outputTokens: values.reduce((total, item) => total + item.outputTokens, 0),
      estimatedCostUsd: values.reduce((total, item) => total + item.estimatedCostUsd, 0)
    }];
  }));
}

function estimateCost(inputTokens, outputTokens, definition) {
  return inputTokens / 1e6 * number(definition.inputUsdPerMillion) + outputTokens / 1e6 * number(definition.outputUsdPerMillion);
}
function bounded(value, min, max, fallback) { const n = Number(value); return Math.max(min, Math.min(Number.isFinite(n) ? n : fallback, max)); }
function number(value) { const n = Number(value || 0); return Number.isFinite(n) && n >= 0 ? n : 0; }
function percentile(sorted, ratio) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] : 0; }

module.exports = { ProviderBenchmark, resolveKey, summarize, estimateCost, SYSTEM, USER };
