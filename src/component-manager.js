'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 * 1024;

class ComponentManager {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || path.join(options.dataDir || '.data', 'components'));
    this.maxDownloadBytes = Number.isFinite(Number(options.maxDownloadBytes)) ? Number(options.maxDownloadBytes) : DEFAULT_MAX_BYTES;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  list() {
    const index = readJson(path.join(this.rootDir, 'active.json'), { active: {} });
    return { active: { ...index.active }, installed: fs.readdirSync(this.rootDir, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name).sort() };
  }

  activeCapabilities() {
    const index = readJson(path.join(this.rootDir, 'active.json'), { active: {} });
    const capabilities = new Set();
    for (const [id, version] of Object.entries(index.active || {})) {
      const manifest = readJson(path.join(this.rootDir, id, version, 'manifest.json'), null);
      for (const capability of manifest?.capabilities || []) capabilities.add(String(capability));
    }
    return [...capabilities].sort();
  }

  activeManifest(id) {
    const safeId = safeName(id);
    const index = readJson(path.join(this.rootDir, 'active.json'), { active: {} });
    const version = index.active?.[safeId];
    if (!version) return null;
    const manifest = readJson(path.join(this.rootDir, safeId, version, 'manifest.json'), null);
    return manifest ? { ...manifest, versionDir: path.join(this.rootDir, safeId, version) } : null;
  }

  activeManifestByCapability(capability) {
    const expected = String(capability || '');
    if (!expected) return null;
    const index = readJson(path.join(this.rootDir, 'active.json'), { active: {} });
    for (const id of Object.keys(index.active || {}).sort()) {
      const manifest = this.activeManifest(id);
      if (Array.isArray(manifest?.capabilities) && manifest.capabilities.map(String).includes(expected)) return manifest;
    }
    return null;
  }

  async install(manifest, options = {}) {
    const item = normalizeManifest(manifest);
    if (item.size > this.maxDownloadBytes) throw new Error('component_size_limit_exceeded');
    const componentDir = path.join(this.rootDir, item.id);
    const versionDir = path.join(componentDir, item.version);
    const active = path.join(this.rootDir, 'active.json');
    await fsp.mkdir(componentDir, { recursive: true });
    const available = await diskAvailable(this.rootDir);
    if (Number.isFinite(available) && available < item.size + item.tempBytes) throw new Error('component_disk_space_insufficient');
    if (await exists(path.join(versionDir, 'manifest.json'))) return { ok: true, id: item.id, version: item.version, skipped: true, active: readJson(active, { active: {} }).active[item.id] === item.version };
    const staging = path.join(componentDir, `.staging-${item.version}-${process.pid}`);
    const part = `${staging}.part`;
    await fsp.mkdir(staging, { recursive: true });
    try {
      await downloadResumable(item.url, part, item.size, options.fetch || fetch);
      await verifySha256(part, item.sha256, item.size);
      await fsp.rename(part, path.join(staging, item.fileName));
      await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(item, null, 2), 'utf8');
      await fsp.rm(versionDir, { recursive: true, force: true });
      await fsp.rename(staging, versionDir);
      const index = readJson(active, { active: {} });
      const previous = index.active[item.id] || null;
      index.active[item.id] = item.version;
      await atomicJson(active, index);
      return { ok: true, id: item.id, version: item.version, previous, active: true };
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(part, { force: true }).catch(() => {});
      try { if (!(await fsp.readdir(componentDir)).length) await fsp.rm(componentDir, { recursive: true, force: true }); } catch (_) { }
      throw error;
    }
  }

  async uninstall(id, version) {
    const safeId = safeName(id);
    const activePath = path.join(this.rootDir, 'active.json');
    const index = readJson(activePath, { active: {} });
    const targetVersion = version ? safeName(version) : index.active[safeId];
    if (!targetVersion) return { ok: true, removed: false };
    await fsp.rm(path.join(this.rootDir, safeId, targetVersion), { recursive: true, force: true });
    if (index.active[safeId] === targetVersion) delete index.active[safeId];
    await atomicJson(activePath, index);
    return { ok: true, removed: true, id: safeId, version: targetVersion };
  }

  async activate(id, version) {
    const safeId = safeName(id); const safeVersion = safeName(version);
    if (!(await exists(path.join(this.rootDir, safeId, safeVersion, 'manifest.json')))) throw new Error('component_version_not_installed');
    const file = path.join(this.rootDir, 'active.json'); const index = readJson(file, { active: {} });
    index.active[safeId] = safeVersion; await atomicJson(file, index);
    return { ok: true, id: safeId, version: safeVersion, active: true };
  }
}

function normalizeManifest(value) {
  if (!value || typeof value !== 'object') throw new Error('component_manifest_invalid');
  const id = safeName(value.id); const version = safeName(value.version);
  const url = String(value.url || '');
  if (!/^https:\/\//i.test(url)) throw new Error('component_url_must_be_https');
  const size = positiveInt(value.size); const sha256 = String(value.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('component_sha256_invalid');
  if (!size) throw new Error('component_size_invalid');
  const runtime = value.runtime && typeof value.runtime === 'object' ? normalizeRuntime(value.runtime) : null;
  return { id, version, url, size, sha256, fileName: safeName(value.fileName || 'payload.bin'), tempBytes: positiveInt(value.tempBytes || size), capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String).slice(0, 32) : [], ...(runtime ? { runtime } : {}) };
}
function normalizeRuntime(value) {
  const entrypoint = safeRelativePath(value.entrypoint);
  const args = Array.isArray(value.args) ? value.args.map(String).slice(0, 32) : [];
  if (args.some((arg) => arg.length > 400)) throw new Error('component_runtime_arg_invalid');
  const command = value.command ? String(value.command) : '';
  if (command.length > 260 || /[\r\n]/.test(command)) throw new Error('component_runtime_command_invalid');
  const transport = value.transport === undefined ? 'ipc' : String(value.transport);
  if (!['ipc', 'stdio'].includes(transport)) throw new Error('component_runtime_transport_invalid');
  return { command, entrypoint, args, protocolVersion: String(value.protocolVersion || '1').slice(0, 20), transport };
}
function safeRelativePath(value) {
  const item = String(value || '').trim();
  if (!item || path.isAbsolute(item) || item.includes('..') || /[\r\n]/.test(item)) throw new Error('component_runtime_entrypoint_invalid');
  return item;
}
function safeName(value) { const name = String(value || ''); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name)) throw new Error('component_name_invalid'); return name; }
function positiveInt(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : 0; }
async function exists(file) { try { await fsp.access(file); return true; } catch (_) { return false; } }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
async function atomicJson(file, value) { const temp = `${file}.tmp-${process.pid}`; await fsp.writeFile(temp, JSON.stringify(value, null, 2), 'utf8'); await fsp.rename(temp, file); }
async function diskAvailable(dir) { try { return (await fsp.statfs(dir)).bavail * (await fsp.statfs(dir)).bsize; } catch (_) { return Number.POSITIVE_INFINITY; } }
async function verifySha256(file, expected, size) { const stat = await fsp.stat(file); if (stat.size !== size) throw new Error('component_size_mismatch'); const hash = crypto.createHash('sha256'); await new Promise((resolve, reject) => { const input = fs.createReadStream(file); input.on('data', (chunk) => hash.update(chunk)); input.on('error', reject); input.on('end', resolve); }); if (hash.digest('hex') !== expected) throw new Error('component_sha256_mismatch'); }
async function downloadResumable(url, file, expectedSize, fetchImpl) {
  let offset = 0; try { offset = (await fsp.stat(file)).size; } catch (_) { }
  const headers = offset ? { Range: `bytes=${offset}-` } : {};
  const response = await fetchImpl(url, { headers, redirect: 'error' });
  if (!response.ok && response.status !== 206) throw new Error(`component_download_http_${response.status}`);
  if (offset && response.status !== 206) { offset = 0; }
  const flags = offset ? 'a' : 'w'; const stream = fs.createWriteStream(file, { flags }); let written = offset;
  if (!response.body) throw new Error('component_download_empty');
  for await (const chunk of response.body) { written += chunk.length; if (written > expectedSize) { stream.destroy(); throw new Error('component_download_too_large'); } if (!stream.write(chunk)) await onceDrain(stream); }
  await new Promise((resolve, reject) => { stream.end((error) => error ? reject(error) : resolve()); });
}
function onceDrain(stream) { return new Promise((resolve, reject) => { stream.once('drain', resolve); stream.once('error', reject); }); }

module.exports = { ComponentManager, normalizeManifest, verifySha256, downloadResumable, normalizeRuntime };
