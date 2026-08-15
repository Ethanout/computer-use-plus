'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BrowserCdpLauncher } = require('../../src/drivers/cdp');

test('browser launcher uses an isolated download directory and clears exited children', async () => {
  let captured = null;
  const spawn = (executable, args) => {
    captured = { executable, args };
    const child = new EventEmitter();
    child.pid = 123;
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', 0); };
    return child;
  };
  const launcher = new BrowserCdpLauncher({ executable: 'edge.exe', profileDir: 'C:/cup/profile', downloadDir: 'C:/cup/downloads', port: 9333, spawn });
  await launcher.launch('https://example.test');
  assert.ok(captured.args.includes('--download-default-directory=C:/cup/downloads'));
  assert.ok(captured.args.includes('--disable-prompt-for-download'));
  assert.equal(launcher.child.pid, 123);
  launcher.child.emit('exit', 0);
  assert.equal(launcher.child, null);
});
