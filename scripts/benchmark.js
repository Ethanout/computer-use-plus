'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BenchmarkRecorder } = require('../src/benchmark');

const input = process.argv[2];
if (!input) {
  process.stderr.write('Usage: node scripts/benchmark.js <samples.json> [summary.json]\n');
  process.exitCode = 2;
} else {
  const samples = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  if (!Array.isArray(samples)) throw new Error('benchmark_input_must_be_array');
  const recorder = new BenchmarkRecorder({ source: path.resolve(input) });
  for (const sample of samples) recorder.record(sample);
  const output = `${JSON.stringify(recorder.summary(), null, 2)}\n`;
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), output, 'utf8');
  else process.stdout.write(output);
}
