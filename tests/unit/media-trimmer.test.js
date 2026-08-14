'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { trimManifest, parseTime } = require('../../src/media-trimmer');

function run(command, args) {
  return new Promise((resolve, reject) => { const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' }); child.once('error', reject); child.once('close', (code) => code ? reject(new Error(`${command}:${code}`)) : resolve()); });
}

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0;

test('local media trimming is resumable and verifies output', { skip: !ffmpegAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-media-'));
  const input = path.join(dir, 'input.mp4');
  const manifest = path.join(dir, 'manifest.json');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=1000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
  fs.writeFileSync(manifest, JSON.stringify({ config: { outputDir: path.join(dir, 'out'), concurrency: 1 }, items: [{ id: 'sample', input, keepSeconds: 2 }] }));
  const first = await trimManifest(manifest);
  assert.equal(first.results[0].status, 'done');
  assert.equal(first.results[0].method, 'stream-copy');
  const second = await trimManifest(manifest);
  assert.equal(second.results[0].skipped, true);
  assert.equal(parseTime('01:02:03'), 3723);
});
