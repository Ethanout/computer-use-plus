'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ProviderBenchmark } = require('../src/provider-benchmark');

const input = process.argv[2];
const outputIndex = process.argv.indexOf('--output');
if (!input) {
  process.stderr.write('Usage: node scripts/benchmark-providers.js <config.json> [--output FILE]\n');
  process.exitCode = 2;
} else {
  const config = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  new ProviderBenchmark().run(config).then((result) => {
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (outputIndex >= 0 && process.argv[outputIndex + 1]) fs.writeFileSync(path.resolve(process.argv[outputIndex + 1]), json, 'utf8');
    else process.stdout.write(json);
    if (!Object.keys(result.summary).length || Object.values(result.summary).some((item) => item.successRate < 1)) process.exitCode = 1;
  }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
