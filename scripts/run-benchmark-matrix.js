'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BenchmarkMatrixRunner } = require('../src/benchmark-matrix');
const { ComputerEngine } = require('../src/engine');

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: node scripts/run-benchmark-matrix.js <matrix.json> [--execute] [--output FILE]\n');
  process.exitCode = 2;
} else {
  const matrixPath = path.resolve(file);
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  const execute = process.argv.includes('--execute');
  const outputIndex = process.argv.indexOf('--output');
  const runner = new BenchmarkMatrixRunner({
    baseDir: path.dirname(matrixPath),
    createEngine: (profile) => new ComputerEngine({ executionMode: profile.executionMode || undefined, providerWorker: profile.providerWorker === true })
  });
  runner.run(matrix, { dryRun: !execute }).then((result) => {
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (outputIndex >= 0 && process.argv[outputIndex + 1]) fs.writeFileSync(path.resolve(process.argv[outputIndex + 1]), output, 'utf8');
    else process.stdout.write(output);
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
