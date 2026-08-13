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
  verify().catch(finish);

  async function verify() {
    const profile = process.env.COMPUTER_USE_PLUS_DSH_PROFILE || 'headless';
    const config = await runDsh(['--profile', profile, '--patch', overlay, '--dump-config']);
    if (!config.includes('mcp-computer-use-plus') || !config.includes('computer_use_plus')) {
      throw new Error('harness_overlay_not_loaded');
    }
    const output = await runDsh(['--profile', profile, '--patch', overlay,
      'List all computer-use-plus MCP tool names, call computer_state exactly once, then output only one JSON object: {"tools":[all tool names],"backgroundOnly":execution.backgroundOnly,"windowCount":windows.length}.']);
    const full = expectedTools.every((tool) => output.includes(tool));
    const short = expectedShortTools.every((tool) => output.includes(tool));
    if (!full && !short) {
      const missing = expectedTools.filter((tool, index) => !output.includes(tool) && !output.includes(expectedShortTools[index]));
      throw new Error(`harness_tools_missing:${missing.join(',')}`);
    }
    const state = parseLastJsonObject(output);
    if (!state || state.backgroundOnly !== true || !Number.isInteger(state.windowCount) || state.windowCount < 0) {
      throw new Error('harness_computer_state_invalid');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, tools: full ? expectedTools : expectedShortTools, presentation: full ? 'server-qualified' : 'short', profile, state: { backgroundOnly: state.backgroundOnly, windowCount: state.windowCount } })}\n`);
  }

  function runDsh(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(dshNode, [dshBin, ...args], {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, COMPUTER_USE_PLUS_ROOT: root, DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE || 'DISABLED' }
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`dsh_exit_${code}:${output}`)));
    });
  }

  function parseLastJsonObject(output) {
    const lines = String(output).trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch { /* Search prior lines for the Host's final JSON object. */ }
    }
    return null;
  }

  function finish(error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
