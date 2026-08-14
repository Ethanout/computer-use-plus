'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const PROTOCOLS = new Set(['openai', 'responses', 'anthropic', 'gemini']);
const PROTECTED_KEY_FILE = 'C:\\' +
  '\u91cd\u8981\u7684\u8d44\u6599\\' +
  '\u8eab\u4efd\u8ba4\u8bc1\u548c\u5404\u79cdkey\\deepseek.txt';
const BLOCKED_KEY_FILES = new Set([
  path.resolve(PROTECTED_KEY_FILE).toLocaleLowerCase()
]);

class ProviderConfigStore {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath || path.join(options.dataDir || '.data', 'providers.json'));
    this.env = options.env || process.env;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  read() {
    if (!fs.existsSync(this.filePath)) return { version: VERSION, revision: 0, active: null, profiles: [] };
    let value;
    try { value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
    catch { throw new Error('provider_config_invalid_json'); }
    if (value?.version !== VERSION || !Array.isArray(value.profiles)) throw new Error('provider_config_version_unsupported');
    return { version: VERSION, revision: Number(value.revision || 0), active: value.active || null, profiles: value.profiles.map(validateProfile) };
  }

  list() {
    const config = this.read();
    return { version: config.version, revision: config.revision, active: config.active, profiles: config.profiles.map((item) => publicProfile(item, this.env)) };
  }

  upsert(profile, expectedRevision = null) {
    const config = this.read();
    checkRevision(config, expectedRevision);
    const normalized = validateProfile(profile);
    const index = config.profiles.findIndex((item) => item.id === normalized.id);
    if (index >= 0) config.profiles[index] = normalized;
    else config.profiles.push(normalized);
    config.revision += 1;
    this.write(config);
    return publicProfile(normalized, this.env);
  }

  remove(id, expectedRevision = null) {
    const config = this.read();
    checkRevision(config, expectedRevision);
    const before = config.profiles.length;
    config.profiles = config.profiles.filter((item) => item.id !== normalizeId(id));
    if (config.profiles.length === before) return { ok: false, reason: 'provider_profile_not_found', revision: config.revision };
    if (config.active === normalizeId(id)) config.active = null;
    config.revision += 1;
    this.write(config);
    return { ok: true, removed: normalizeId(id), revision: config.revision };
  }

  activate(id, expectedRevision = null) {
    const config = this.read();
    checkRevision(config, expectedRevision);
    const normalized = normalizeId(id);
    if (!config.profiles.some((item) => item.id === normalized)) throw new Error('provider_profile_not_found');
    config.active = normalized;
    config.revision += 1;
    this.write(config);
    return { ok: true, active: normalized, revision: config.revision };
  }

  resolve(id = null) {
    const config = this.read();
    const selected = config.profiles.find((item) => item.id === normalizeId(id || config.active || ''));
    if (!selected) return null;
    const apiKey = resolveKey(selected.apiKey, this.env);
    return {
      id: selected.id,
      apiKey,
      baseUrl: selected.baseUrl,
      model: selected.model,
      protocol: selected.protocol,
      timeoutMs: selected.timeoutMs,
      inputUsdPerMillion: selected.inputUsdPerMillion,
      outputUsdPerMillion: selected.outputUsdPerMillion
    };
  }

  write(config) {
    const temp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }
}

function validateProfile(value) {
  if (!value || typeof value !== 'object') throw new Error('provider_profile_invalid');
  const id = normalizeId(value.id || value.name);
  if (!id) throw new Error('provider_profile_id_required');
  const baseUrl = String(value.baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('provider_base_url_invalid');
  const model = String(value.model || '').trim();
  if (!model || model.length > 200) throw new Error('provider_model_invalid');
  const protocol = String(value.protocol || 'openai').toLowerCase();
  if (!PROTOCOLS.has(protocol)) throw new Error('provider_protocol_invalid');
  const apiKey = validateKeyReference(value.apiKey || keyReferenceFromLegacy(value));
  return {
    id,
    label: String(value.label || id).slice(0, 120),
    baseUrl,
    model,
    protocol,
    apiKey,
    timeoutMs: boundedNumber(value.timeoutMs, 1000, 60000, 8000),
    inputUsdPerMillion: boundedNumber(value.inputUsdPerMillion, 0, 10000, 0),
    outputUsdPerMillion: boundedNumber(value.outputUsdPerMillion, 0, 10000, 0)
  };
}

function validateKeyReference(value) {
  if (!value || typeof value !== 'object') throw new Error('provider_key_reference_required');
  const type = String(value.type || '').toLowerCase();
  if (type === 'env') {
    const name = String(value.name || '').trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('provider_key_env_invalid');
    return { type, name };
  }
  if (type === 'file') {
    const filePath = path.resolve(String(value.path || ''));
    if (!value.path || BLOCKED_KEY_FILES.has(filePath.toLocaleLowerCase())) throw new Error('provider_key_file_blocked');
    return { type, path: filePath };
  }
  throw new Error('provider_key_reference_invalid');
}

function keyReferenceFromLegacy(value) {
  if (value.apiKeyEnv) return { type: 'env', name: value.apiKeyEnv };
  if (value.apiKeyFile) return { type: 'file', path: value.apiKeyFile };
  return null;
}

function resolveKey(reference, env) {
  if (reference.type === 'env') return String(env[reference.name] || '').trim();
  if (reference.type === 'file') {
    if (BLOCKED_KEY_FILES.has(path.resolve(reference.path).toLocaleLowerCase())) return '';
    try { return fs.readFileSync(reference.path, 'utf8').trim(); } catch { return ''; }
  }
  return '';
}

function publicProfile(profile, env) {
  const configured = profile.apiKey.type === 'env'
    ? Boolean(String(env[profile.apiKey.name] || '').trim())
    : fs.existsSync(profile.apiKey.path);
  return {
    id: profile.id,
    label: profile.label,
    baseUrl: profile.baseUrl,
    model: profile.model,
    protocol: profile.protocol,
    timeoutMs: profile.timeoutMs,
    inputUsdPerMillion: profile.inputUsdPerMillion,
    outputUsdPerMillion: profile.outputUsdPerMillion,
    keySource: profile.apiKey.type,
    configured
  };
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function checkRevision(config, expected) {
  if (expected !== null && expected !== undefined && Number(expected) !== config.revision) throw new Error('provider_revision_conflict');
}

function boundedNumber(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error('provider_number_invalid');
  return number;
}

module.exports = { ProviderConfigStore, validateProfile, resolveKey, publicProfile, BLOCKED_KEY_FILES };
