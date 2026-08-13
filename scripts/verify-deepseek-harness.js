'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.env.COMPUTER_USE_PLUS_ROOT || process.cwd());
const dshNode = process.env.COMPUTER_USE_PLUS_DSH_NODE || process.execPath;
const dshBin = process.env.COMPUTER_USE_PLUS_DSH_BIN || '';
const overlay = path.join(root, 'adapters', 'deepseek-harness', 'cordis.yml');
const expectedTools = [
  'mcp__computer_use_plus__computer_cancel',
  'mcp__computer_use_plus__computer_inspect',
  'mcp__computer_use_plus__computer_invoke',
  'mcp__computer_use_plus__computer_state',
  'mcp__computer_use_plus__computer_verify',
  'mcp__computer_use_plus__shortcut_run'
];
const expectedShortTools = expectedTools.map((name) => name.replace('mcp__computer_use_plus__', ''));

if (!dshBin || !fs.existsSync(dshBin)) {
  process.stderr.write('Set COMPUTER_USE_PLUS_DSH_BIN to @deepseek-ai/dsh/lib/bin.js.\n');
  process.exitCode = 2;
} else if (!fs.existsSync(overlay)) {
  process.stderr.write(`Harness overlay not found: ${overlay}\n`);
  process.exitCode = 2;
} else {
  const args = [dshBin, '--profile', process.env.COMPUTER_USE_PLUS_DSH_PROFILE || 'headless', '--patch', overlay,
    'List only the available computer-use-plus MCP tool names, then stop.'];
  const child = spawn(dshNode, args, {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      COMPUTER_USE_PLUS_ROOT: root,
      DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE || 'DISABLED'
    }
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => finish(error));
  child.on('close', (code) => {
    if (code !== 0) return finish(new Error(`dsh_exit_${code}`));
    const full = expectedTools.every((tool) => output.includes(tool));
    const short = expectedShortTools.every((tool) => output.includes(tool));
    if (!full && !short) {
      const missing = expectedTools.filter((tool, index) => !output.includes(tool) && !output.includes(expectedShortTools[index]));
      return finish(new Error(`harness_tools_missing:${missing.join(',')}`));
    }
    process.stdout.write(`${JSON.stringify({ ok: true, tools: full ? expectedTools : expectedShortTools, presentation: full ? 'server-qualified' : 'short', profile: process.env.COMPUTER_USE_PLUS_DSH_PROFILE || 'headless' })}\n`);
  });

  function finish(error) {
    process.stderr.write(`${error.message}\n`);
    if (output) process.stderr.write(output);
    process.exitCode = 1;
  }
}
