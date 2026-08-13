'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const text = String(value ?? '').trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error(`invalid_time:${value}`);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = options.stdout || null;
    const err = options.stderr || null;
    if (out) child.stdout.pipe(out); else child.stdout.resume();
    if (err) child.stderr.pipe(err); else child.stderr.resume();
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve({ code, signal }) : reject(new Error(`${command}_exit_${code || signal}`)));
  });
}

async function probe(file, ffprobe = 'ffprobe') {
  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  await runProcess(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { stdout: sink });
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const duration = Number(value?.format?.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('probe_duration_missing');
  return { duration, streams: value.streams || [], format: value.format || {} };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function fileFingerprint(file) {
  const stat = fs.statSync(file);
  return { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

function readManifest(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(items) || !items.length) throw new Error('manifest_items_required');
  return { config: Array.isArray(value) ? {} : (value.config || {}), items };
}

function validateItem(item, index) {
  const input = path.resolve(String(item.input || ''));
  if (!input || /^https?:/i.test(String(item.input || ''))) throw new Error(`item_${index}_local_input_required`);
  const start = parseTime(item.startSeconds ?? 0);
  const end = item.endSeconds == null ? null : parseTime(item.endSeconds);
  const keep = item.keepSeconds == null ? 3600 : parseTime(item.keepSeconds);
  if (end != null && end <= start) throw new Error(`item_${index}_end_before_start`);
  if (keep <= 0) throw new Error(`item_${index}_keep_nonpositive`);
  return { ...item, id: String(item.id || `item-${index + 1}`), input, start, end, keep };
}

function freeBytes(dir) {
  try { const stat = fs.statfsSync(dir); return Number(stat.bavail) * Number(stat.bsize); } catch (_) { return null; }
}

async function processItem(item, options, state, stateFile) {
  const output = path.resolve(item.output || path.join(options.outputDir, `${item.id}.mp4`));
  if (!fs.existsSync(item.input)) throw new Error('input_missing');
  const fingerprint = fileFingerprint(item.input);
  const previous = state.items[item.id];
  if (previous?.input?.size === fingerprint.size && previous?.input?.mtimeMs === fingerprint.mtimeMs && previous.status === 'done' && fs.existsSync(output)) return { ...previous, skipped: true };
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const metadata = await probe(item.input, options.ffprobe);
  const start = Math.min(item.start, Math.max(0, metadata.duration - 0.1));
  const end = item.end == null ? Math.min(metadata.duration, start + item.keep) : Math.min(metadata.duration, item.end);
  const length = Math.max(0.1, end - start);
  const temp = `${output}.part-${process.pid}-${Date.now()}${path.extname(output) || '.mp4'}`;
  const logFile = `${output}.log`;
  state.items[item.id] = { id: item.id, status: 'processing', input: fingerprint, output, start, end, length, attempts: (previous?.attempts || 0) + 1 };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  let copied = true;
  try {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    try {
      await runProcess(options.ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-y', '-ss', String(start), '-i', item.input, '-t', String(length), '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', temp], { stderr: log });
    } catch (_) {
      copied = false;
      await runProcess(options.ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-y', '-ss', String(start), '-i', item.input, '-t', String(length), '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', options.preset, '-crf', String(options.crf), '-c:a', 'aac', '-movflags', '+faststart', temp], { stderr: log });
    } finally { log.end(); }
    const outputProbe = await probe(temp, options.ffprobe);
    if (outputProbe.duration < Math.min(0.5, length * 0.5)) throw new Error('output_too_short');
    const digest = await sha256(temp);
    await fsp.rename(temp, output);
    state.items[item.id] = { ...state.items[item.id], status: 'done', method: copied ? 'stream-copy' : 'reencode', sha256: digest, outputDuration: outputProbe.duration, completedAt: new Date().toISOString() };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return state.items[item.id];
  } catch (error) {
    try { await fsp.unlink(temp); } catch (_) {}
    state.items[item.id] = { ...state.items[item.id], status: 'failed', error: error.message, failedAt: new Date().toISOString() };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    throw error;
  }
}

async function trimManifest(manifestFile, options = {}) {
  const { config, items: rawItems } = readManifest(manifestFile);
  const merged = { outputDir: path.resolve(options.outputDir || config.outputDir || path.join(path.dirname(manifestFile), 'trimmed')), stateFile: options.stateFile || config.stateFile || path.join(path.dirname(manifestFile), 'trim-state.json'), ffmpeg: options.ffmpeg || config.ffmpeg || 'ffmpeg', ffprobe: options.ffprobe || config.ffprobe || 'ffprobe', concurrency: Math.max(1, Math.min(4, Number(options.concurrency || config.concurrency || 1))), retries: Math.max(0, Math.min(5, Number(options.retries ?? config.retries ?? 2))), preset: options.preset || config.preset || 'veryfast', crf: Number(options.crf ?? config.crf ?? 23), diskBudgetBytes: Number(options.diskBudgetBytes || config.diskBudgetBytes || 0) };
  await fsp.mkdir(merged.outputDir, { recursive: true });
  const state = fs.existsSync(merged.stateFile) ? JSON.parse(fs.readFileSync(merged.stateFile, 'utf8')) : { version: 1, manifest: path.resolve(manifestFile), items: {} };
  const items = rawItems.map(validateItem);
  const budget = freeBytes(merged.outputDir);
  if (merged.diskBudgetBytes && budget != null && budget < merged.diskBudgetBytes) throw new Error(`disk_budget_insufficient:${budget}`);
  let cursor = 0; const results = [];
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++]; let lastError;
      for (let attempt = 0; attempt <= merged.retries; attempt++) {
        try { results.push(await processItem(item, merged, state, merged.stateFile)); lastError = null; break; } catch (error) { lastError = error; }
      }
      if (lastError) results.push({ id: item.id, status: 'failed', error: lastError.message });
    }
  }
  await Promise.all(Array.from({ length: merged.concurrency }, worker));
  return { outputDir: merged.outputDir, stateFile: merged.stateFile, results: results.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true })) };
}

module.exports = { parseTime, probe, sha256, readManifest, trimManifest, validateItem };
