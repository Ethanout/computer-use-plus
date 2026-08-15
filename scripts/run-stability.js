'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StabilityRunner } = require('../src/stability-runner');
const { ComputerEngine } = require('../src/engine');

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: node scripts/run-stability.js <config.json> [--dry-run] [--output FILE]\n');
  process.exitCode = 2;
} else {
  try {
    const config = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const dryRun = process.argv.includes('--dry-run');
    const outputIndex = process.argv.indexOf('--output');
    const runner = new StabilityRunner({ createEngine: () => new ComputerEngine() });
    runner.run(config, { dryRun }).then((result) => {
      const output = `${JSON.stringify(result, null, 2)}\n`;
      if (outputIndex >= 0 && process.argv[outputIndex + 1]) fs.writeFileSync(path.resolve(process.argv[outputIndex + 1]), output, 'utf8');
      else process.stdout.write(output);
      if (!result.ok) process.exitCode = 1;
    }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
