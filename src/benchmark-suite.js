'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BenchmarkRecorder } = require('./benchmark');

const ALLOWED_TOOLS = new Set([
  'computer.state', 'computer.inspect', 'computer.wait', 'computer.screenshot',
  'computer.invoke', 'shortcut.run', 'computer.verify', 'computer.cancel',
  'computer.act', 'computer.fast', 'computer.shortcut', 'computer.execution', 'computer.browser'
]);

class BenchmarkSuiteRunner {
  constructor(options = {}) {
    this.callTool = options.callTool || null;
    this.env = options.env || process.env;
    this.platform = options.platform || process.platform;
    this.exists = options.exists || fs.existsSync;
    this.readMetrics = options.readMetrics || null;
  }

  validate(suite) {
    if (!suite || typeof suite !== 'object') throw new Error('benchmark_suite_required');
    if (!String(suite.name || '').trim()) throw new Error('benchmark_suite_name_required');
    if (!Array.isArray(suite.tasks) || !suite.tasks.length) throw new Error('benchmark_suite_tasks_required');
    if (suite.tasks.length > 100) throw new Error('benchmark_suite_tasks_limit');
    const ids = new Set();
    for (const task of suite.tasks) {
      const id = String(task?.id || '').trim();
      if (!id || ids.has(id)) throw new Error('benchmark_task_id_invalid');
      ids.add(id);
      if (!Array.isArray(task.steps) || !task.steps.length || task.steps.length > 100) throw new Error('benchmark_task_steps_invalid');
      for (const step of task.steps) {
        if (!ALLOWED_TOOLS.has(step?.tool)) throw new Error('benchmark_tool_not_allowed');
        if (step.arguments !== undefined && (!step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments))) throw new Error('benchmark_arguments_invalid');
        if (step.expect !== undefined && (!step.expect || typeof step.expect !== 'object' || Array.isArray(step.expect))) throw new Error('benchmark_expect_invalid');
      }
    }
    return suite;
  }

  checkRequirements(requirements = {}) {
    const checks = [];
    if (requirements.platform) checks.push(check('platform', requirements.platform, this.platform, String(requirements.platform) === this.platform));
    for (const variable of requirements.env || []) checks.push(check(`env:${variable}`, 'configured', this.env[variable] ? 'configured' : 'missing', Boolean(this.env[variable])));
    for (const file of requirements.files || []) checks.push(check(`file:${file}`, true, this.exists(path.resolve(file)), this.exists(path.resolve(file))));
    return { ok: checks.every((item) => item.passed), checks };
  }

  async run(input, options = {}) {
    const suite = this.validate(input);
    const dryRun = options.dryRun !== false;
    const requirements = this.checkRequirements(suite.requirements || {});
    const recorder = new BenchmarkRecorder({ suite: suite.name, application: suite.application || 'unknown', dryRun });
    const tasks = [];
    for (const task of suite.tasks) {
      const repeats = Math.max(1, Math.min(Number(task.repeats || suite.repeats || 1), 20));
      for (let iteration = 1; iteration <= repeats; iteration += 1) {
        const started = Date.now();
        const metricsBefore = await this.metricSnapshot();
        let success = requirements.ok;
        let failureReason = requirements.ok ? null : 'requirements_not_met';
        const steps = [];
        if (requirements.ok) {
          for (const step of task.steps) {
            if (dryRun) {
              steps.push({ tool: step.tool, ok: true, dryRun: true });
              continue;
            }
            if (!this.callTool) throw new Error('benchmark_call_tool_required');
            try {
              const result = await this.callTool(step.tool, interpolateEnvironment(step.arguments || {}, this.env));
              const passed = result?.ok !== false && result?.isError !== true && resultMatches(result, step.expect);
              steps.push({ tool: step.tool, ok: passed, result: compactResult(result), ...(step.expect ? { expect: step.expect } : {}) });
              if (!passed) { success = false; failureReason = result?.reason || expectationFailure(step.expect) || `${step.tool}_failed`; break; }
            } catch (error) {
              success = false; failureReason = error.message; steps.push({ tool: step.tool, ok: false, reason: error.message }); break;
            }
          }
        }
        const metricDelta = metricsDifference(metricsBefore, await this.metricSnapshot());
        const sample = recorder.record({
          name: task.id, application: suite.application || 'unknown', strategy: task.strategy || 'mixed',
          success, latencyMs: Date.now() - started, mcpRoundTrips: dryRun ? 0 : steps.length,
          failureReason,
          inputTokens: metricDelta.modelInputTokens,
          outputTokens: metricDelta.modelOutputTokens,
          screenshots: metricDelta.screenshots || steps.filter((item) => item.tool === 'computer.screenshot').length,
          screenshotBytes: metricDelta.screenshotBytes,
          ocrCalls: metricDelta.ocrCalls,
          ocrLatencyMs: metricDelta.ocrLatencyMs,
          modelCalls: metricDelta.modelCalls,
          toolCalls: metricDelta.toolCalls,
          shortcutHits: metricDelta.shortcutHits,
          classifierCalls: metricDelta.classifierCalls,
          classifierHits: metricDelta.classifierHits,
          classifierLatencyMs: metricDelta.classifierLatencyMs,
          actions: metricDelta.actions,
          engineFailures: metricDelta.failures,
          strategyCounts: metricDelta.strategy
        });
        tasks.push({ id: task.id, iteration, success, failureReason, steps, sample });
      }
    }
    return { ok: requirements.ok && tasks.every((item) => item.success), dryRun, requirements, tasks, summary: recorder.summary() };
  }

  async metricSnapshot() {
    if (!this.readMetrics) return {};
    try { return cloneMetrics(await this.readMetrics()); } catch (_) { return {}; }
  }
}

function check(name, expected, actual, passed) { return { name, expected, actual, passed: Boolean(passed) }; }
function compactResult(value) {
  const json = JSON.stringify(value ?? null);
  return json.length <= 2000 ? value : { truncated: true, bytes: Buffer.byteLength(json, 'utf8') };
}

function resultMatches(result, expect = null) {
  if (!expect) return true;
  if (expect.minElements !== undefined && Number(result?.elements?.length || 0) < Number(expect.minElements)) return false;
  if (expect.minWindows !== undefined && Number(result?.windows?.length || 0) < Number(expect.minWindows)) return false;
  if (expect.ok !== undefined && Boolean(result?.ok) !== Boolean(expect.ok)) return false;
  for (const [key, expected] of Object.entries(expect.equals || {})) {
    if (result?.[key] !== expected) return false;
  }
  return true;
}

function expectationFailure(expect) {
  if (!expect) return null;
  if (expect.minElements !== undefined) return 'benchmark_expected_elements_missing';
  if (expect.minWindows !== undefined) return 'benchmark_expected_windows_missing';
  return 'benchmark_expectation_failed';
}

function loadSuite(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function interpolateEnvironment(value, env) {
  if (Array.isArray(value)) return value.map((item) => interpolateEnvironment(item, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateEnvironment(item, env)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => env[key] === undefined ? _match : String(env[key]));
}

function cloneMetrics(value) { return JSON.parse(JSON.stringify(value && typeof value === 'object' ? value : {})); }
function metricsDifference(before = {}, after = {}) {
  const output = {};
  for (const key of ['actions', 'failures', 'screenshots', 'screenshotBytes', 'ocrCalls', 'ocrLatencyMs', 'modelCalls', 'modelInputTokens', 'modelOutputTokens', 'classifierCalls', 'classifierHits', 'classifierLatencyMs', 'toolCalls', 'shortcutHits']) {
    output[key] = Math.max(0, Number(after[key] || 0) - Number(before[key] || 0));
  }
  output.strategy = {};
  for (const key of new Set([...Object.keys(before.strategy || {}), ...Object.keys(after.strategy || {})])) {
    const difference = Math.max(0, Number(after.strategy?.[key] || 0) - Number(before.strategy?.[key] || 0));
    if (difference) output.strategy[key] = difference;
  }
  return output;
}

module.exports = { BenchmarkSuiteRunner, loadSuite, interpolateEnvironment, resultMatches, metricsDifference, ALLOWED_TOOLS };
