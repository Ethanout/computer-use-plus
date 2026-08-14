'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const unitDir = path.join(root, 'tests', 'unit');
const tests = fs.readdirSync(unitDir)
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => path.join(unitDir, file));

tests.push(
  path.join(root, 'tests', 'integration', 'protocol.test.js'),
  path.join(root, 'tests', 'integration', 'agent-stdio.test.js')
);
const child = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
process.exit(child.status ?? 1);
