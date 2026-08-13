'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BenchmarkSuiteRunner, loadSuite } = require('../src/benchmark-suite');
const { ComputerEngine } = require('../src/engine');

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: node scripts/run-benchmark-suite.js <suite.json> [--execute] [--output FILE]\n');
  process.exitCode = 2;
} else {
  const execute = process.argv.includes('--execute');
  const outputIndex = process.argv.indexOf('--output');
  const engine = execute ? new ComputerEngine() : null;
  const callTool = engine ? async (name, args) => dispatch(engine, name, args) : null;
  const runner = new BenchmarkSuiteRunner({ callTool });
  runner.run(loadSuite(file), { dryRun: !execute }).then(async (result) => {
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (outputIndex >= 0 && process.argv[outputIndex + 1]) fs.writeFileSync(path.resolve(process.argv[outputIndex + 1]), json, 'utf8');
    else process.stdout.write(json);
    if (!result.ok) process.exitCode = 1;
    if (engine) {
      await engine.execution.destroy().catch(() => {});
      engine.browserLauncher?.stop();
      engine.ocr.close();
    }
  }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
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
