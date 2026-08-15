'use strict';

const path = require('node:path');
const { BenchmarkSuiteRunner, loadSuite } = require('./benchmark-suite');

class BenchmarkMatrixRunner {
  constructor(options = {}) {
    this.createEngine = options.createEngine || (() => null);
    this.load = options.load || loadSuite;
    this.env = options.env || process.env;
    this.platform = options.platform || process.platform;
    this.baseDir = options.baseDir || process.cwd();
  }

  validate(matrix) {
    if (!matrix || typeof matrix !== 'object') throw new Error('benchmark_matrix_required');
    if (!String(matrix.name || '').trim()) throw new Error('benchmark_matrix_name_required');
    if (!Array.isArray(matrix.profiles) || !matrix.profiles.length || matrix.profiles.length > 16) throw new Error('benchmark_matrix_profiles_invalid');
    const ids = new Set();
    for (const profile of matrix.profiles) {
      const id = String(profile?.id || '').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(id) || ids.has(id)) throw new Error('benchmark_matrix_profile_id_invalid');
      if (!profile.suite) throw new Error('benchmark_matrix_suite_required');
      ids.add(id);
    }
    return matrix;
  }

  async run(matrix, options = {}) {
    this.validate(matrix);
    const dryRun = options.dryRun !== false;
    const results = [];
    for (const profile of matrix.profiles) {
      const suitePath = path.isAbsolute(profile.suite)
        ? profile.suite
        : path.resolve(this.baseDir, profile.suite);
      const suite = this.load(suitePath);
      const engine = dryRun ? null : await this.createEngine(profile);
      try {
        const runner = new BenchmarkSuiteRunner({
          callTool: engine ? async (name, args) => dispatch(engine, name, args) : null,
          readMetrics: engine ? () => engine.metrics : null,
          env: { ...this.env, ...(profile.env || {}) },
          platform: profile.platform || this.platform
        });
        const result = await runner.run(suite, { dryRun });
        results.push({ id: profile.id, device: String(profile.device || 'unknown'), mode: String(profile.mode || 'auto'), application: suite.application || 'unknown', ok: result.ok, summary: result.summary, requirements: result.requirements, tasks: result.tasks });
      } finally {
        if (engine?.close) await Promise.resolve(engine.close()).catch(() => {});
        if (engine?.execution?.destroy) await Promise.resolve(engine.execution.destroy()).catch(() => {});
        if (engine?.browserLauncher?.stop) await Promise.resolve(engine.browserLauncher.stop()).catch(() => {});
        if (engine?.ocr?.close) await Promise.resolve(engine.ocr.close()).catch(() => {});
      }
    }
    return { name: matrix.name, dryRun, profiles: results, ok: results.every((result) => result.ok) };
  }
}

async function dispatch(engine, name, args) {
  if (name === 'computer.state') return engine.state(args);
  if (name === 'computer.inspect') return engine.inspect(args);
  if (name === 'computer.wait') return engine.waitForTarget(args);
  if (name === 'computer.screenshot') return engine.screenshot(args);
  if (name === 'computer.act') return engine.act(args);
  if (name === 'computer.fast') return engine.fastAct(args);
  if (name === 'computer.invoke' || name === 'shortcut.run') return engine.invokeToolCall({ type: 'tool_call', name, arguments: args });
  if (name === 'computer.verify') return engine.verify(args);
  if (name === 'computer.cancel') return engine.cancelConfirmation(args);
  if (name === 'computer.shortcut') return engine.manageShortcut(args);
  if (name === 'computer.execution') return engine.manageExecution(args);
  if (name === 'computer.browser') return engine.manageBrowser(args);
  throw new Error('benchmark_tool_not_allowed');
}

module.exports = { BenchmarkMatrixRunner, dispatch };
