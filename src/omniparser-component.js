'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateLayout } = require('./vision');

class OmniParserComponentClient {
  constructor(components, workers, options = {}) {
    this.components = components;
    this.workers = workers;
    this.capability = options.capability || 'omniparser-detector';
    this.maxBytes = bounded(options.maxBytes, 32 * 1024, 8 * 1024 * 1024, 2 * 1024 * 1024);
    this.maxNodes = bounded(options.maxNodes, 1, 200, 100);
    this.timeoutMs = bounded(options.timeoutMs, 100, 120000, 15000);
    this.allowedRoots = (options.allowedRoots || []).map((item) => path.resolve(item));
  }

  activeManifest() {
    return this.components?.activeManifestByCapability?.(this.capability) || null;
  }

  get available() {
    return Boolean(this.activeManifest()?.runtime && this.workers);
  }

  status() {
    const manifest = this.activeManifest();
    const worker = manifest ? this.workers?.status?.()[manifest.id] : null;
    return {
      configured: Boolean(manifest?.runtime),
      backend: 'omniparser-component',
      ...(manifest ? { component: manifest.id, version: manifest.version, running: Boolean(worker?.running) } : {})
    };
  }

  async inspectImage(imagePath, bounds, context = {}) {
    const manifest = this.activeManifest();
    if (!manifest?.runtime || !this.workers) throw new Error('omniparser_component_not_configured');
    const resolved = validateOwnedImage(imagePath, this.allowedRoots, this.maxBytes);
    await this.workers.start(manifest.id);
    const result = await this.workers.request(manifest.id, {
      action: 'inspect',
      version: 1,
      image: { path: resolved, bytes: fs.statSync(resolved).size },
      bounds: normalizeScreenBounds(bounds),
      options: {
        maxNodes: this.maxNodes,
        caption: Array.isArray(manifest.capabilities) && manifest.capabilities.map(String).includes('omniparser-caption'),
        query: compactQuery(context.query)
      }
    }, { timeoutMs: this.timeoutMs });
    return normalizeOmniParserResult(result, bounds, { maxNodes: this.maxNodes, windowId: context.windowId });
  }
}

class VisionCascadeClient {
  constructor(clients = []) {
    this.clients = clients.filter(Boolean);
  }

  get available() { return this.clients.some((client) => client.available); }

  status() {
    return {
      configured: this.available,
      backends: this.clients.map((client) => client.status?.() || { configured: Boolean(client.available) })
    };
  }

  async inspectImage(imagePath, bounds, context = {}) {
    let lastError = null;
    for (const client of this.clients) {
      if (!client.available) continue;
      try { return await client.inspectImage(imagePath, bounds, context); }
      catch (error) { lastError = error; }
    }
    throw lastError || new Error('vision_not_configured');
  }
}

function normalizeOmniParserResult(value, screenBounds, options = {}) {
  if (value?.windows) return validateLayout(value, { maxNodes: options.maxNodes });
  if (!value || Number(value.version || 1) !== 1 || !Array.isArray(value.nodes)) throw new Error('omniparser_result_invalid');
  const coordinateSpace = String(value.coordinateSpace || 'image');
  if (!['normalized', 'image', 'screen'].includes(coordinateSpace)) throw new Error('omniparser_coordinate_space_invalid');
  const screen = normalizeScreenBounds(screenBounds);
  const image = value.image || {};
  const imageWidth = Number(image.width);
  const imageHeight = Number(image.height);
  if (coordinateSpace === 'image' && (!Number.isFinite(imageWidth) || imageWidth <= 0 || !Number.isFinite(imageHeight) || imageHeight <= 0)) throw new Error('omniparser_image_size_required');
  const nodes = value.nodes.slice(0, bounded(options.maxNodes, 1, 200, 100)).map((node, index) => {
    if (!node || typeof node !== 'object') throw new Error('omniparser_node_invalid');
    const raw = normalizeNodeBounds(node.bounds || node.bbox);
    const converted = convertBounds(raw, coordinateSpace, screen, { width: imageWidth, height: imageHeight });
    const confidence = Number(node.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('omniparser_confidence_invalid');
    return {
      id: String(node.id || `omni-${index + 1}`),
      role: String(node.role || 'button'),
      text: String(node.text || node.caption || node.label || ''),
      bounds: converted,
      parent: node.parent == null ? null : String(node.parent),
      confidence,
      source: 'vision'
    };
  });
  return validateLayout({ windows: [{ id: String(options.windowId || value.windowId || 'window'), nodes }] }, { maxNodes: options.maxNodes });
}

function normalizeNodeBounds(value) {
  if (Array.isArray(value) && value.length === 4) {
    const [x1, y1, x2, y2] = value.map(Number);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  if (!value || typeof value !== 'object') throw new Error('omniparser_bounds_invalid');
  const result = { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) };
  if (Object.values(result).some((item) => !Number.isFinite(item)) || result.width < 0 || result.height < 0) throw new Error('omniparser_bounds_invalid');
  return result;
}

function convertBounds(value, coordinateSpace, screen, image) {
  if (coordinateSpace === 'screen') return value;
  const width = coordinateSpace === 'normalized' ? 1 : image.width;
  const height = coordinateSpace === 'normalized' ? 1 : image.height;
  return {
    x: screen.x + value.x / width * screen.width,
    y: screen.y + value.y / height * screen.height,
    width: value.width / width * screen.width,
    height: value.height / height * screen.height
  };
}

function normalizeScreenBounds(value) {
  const bounds = value || {};
  const result = { x: Number(bounds.x), y: Number(bounds.y), width: Number(bounds.width), height: Number(bounds.height) };
  if (Object.values(result).some((item) => !Number.isFinite(item)) || result.width <= 0 || result.height <= 0) throw new Error('omniparser_screen_bounds_invalid');
  return result;
}

function validateOwnedImage(file, roots, maxBytes) {
  const resolved = fs.realpathSync(path.resolve(file));
  if (roots.length) {
    const allowed = roots.some((root) => {
      let realRoot;
      try { realRoot = fs.realpathSync(root); } catch (_) { realRoot = root; }
      return resolved === realRoot || resolved.startsWith(`${realRoot}${path.sep}`);
    });
    if (!allowed) throw new Error('omniparser_image_path_not_allowed');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('omniparser_image_required');
  if (stat.size > maxBytes) throw new Error('omniparser_image_too_large');
  return resolved;
}

function compactQuery(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(['text', 'role'].filter((key) => value[key] !== undefined).map((key) => [key, String(value[key]).slice(0, 200)]));
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

module.exports = { OmniParserComponentClient, VisionCascadeClient, normalizeOmniParserResult };
