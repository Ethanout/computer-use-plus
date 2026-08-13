#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { trimManifest } = require('../src/media-trimmer');

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const manifest = process.argv[2];
  if (!manifest || manifest.startsWith('-')) throw new Error('usage: node scripts/trim-local-media.js <manifest.json> [--output-dir DIR] [--concurrency N]');
  const result = await trimManifest(path.resolve(manifest), { outputDir: arg('output-dir'), concurrency: arg('concurrency'), retries: arg('retries'), diskBudgetBytes: arg('disk-budget-bytes') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.results.some((item) => item.status === 'failed')) process.exitCode = 2;
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
