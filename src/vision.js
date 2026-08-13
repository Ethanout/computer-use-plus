'use strict';

const fs = require('node:fs');

class StructuredVisionClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.COMPUTER_USE_PLUS_VISION_API_KEY || process.env.COMPUTER_USE_PLUS_AI_API_KEY || '';
    this.baseUrl = (options.baseUrl || process.env.COMPUTER_USE_PLUS_VISION_BASE_URL || process.env.COMPUTER_USE_PLUS_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = options.model || process.env.COMPUTER_USE_PLUS_VISION_MODEL || process.env.COMPUTER_USE_PLUS_AI_MODEL || 'gpt-4o-mini';
    this.timeoutMs = Number(options.timeoutMs || process.env.COMPUTER_USE_PLUS_VISION_TIMEOUT_MS || 12000);
    this.maxBytes = Math.max(32 * 1024, Math.min(Number(options.maxBytes) || 2 * 1024 * 1024, 8 * 1024 * 1024));
    this.maxNodes = Math.max(1, Math.min(Number(options.maxNodes) || 100, 200));
    this.fetch = options.fetch || globalThis.fetch;
    this.parse = options.parse;
  }

  get available() { return Boolean(this.fetch && (this.parse || this.apiKey)); }
  status() { return { configured: this.available, model: this.model, ...(this.available && this.apiKey ? { baseUrl: this.baseUrl } : {}) }; }

  async inspectImage(imagePath, bounds, context = {}) {
    const bytes = fs.readFileSync(imagePath);
    if (bytes.length > this.maxBytes) throw new Error('vision_image_too_large');
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    const value = this.parse
      ? await this.parse({ imagePath, bounds, context, dataUrl })
      : await this.request(dataUrl, bounds, context);
    return validateLayout(value, { maxNodes: this.maxNodes });
  }

  async request(dataUrl, bounds, context) {
    if (!this.available) throw new Error('vision_not_configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, this.timeoutMs));
    try {
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: 1200,
          messages: [{ role: 'system', content: '只输出符合 JSON schema 的窗口布局，不要说明文字。schema: {windows:[{id:string,nodes:[{id:string,role:string,text?:string,bounds:{x:number,y:number,width:number,height:number},parent?:string|null,confidence:number,source:"vision"}]}]}', },
            { role: 'user', content: [{ type: 'text', text: JSON.stringify({ bounds, context }) }, { type: 'image_url', image_url: { url: dataUrl } }] }]
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`vision_http_${response.status}`);
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      return parseJson(content);
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('vision_timeout');
      throw error;
    } finally { clearTimeout(timer); }
  }
}

function parseJson(content) {
  if (typeof content !== 'string') throw new Error('vision_invalid_response');
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(text); } catch (_) {
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('vision_invalid_json');
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { throw new Error('vision_invalid_json'); }
  }
}

function validateLayout(value, options = {}) {
  if (!value || !Array.isArray(value.windows)) throw new Error('vision_layout_required');
  const maxNodes = Math.max(1, Math.min(Number(options.maxNodes) || 100, 200));
  const windows = value.windows.slice(0, 20).map((window, wi) => {
    if (!window || typeof window !== 'object') throw new Error('vision_invalid_window');
    const nodes = Array.isArray(window.nodes) ? window.nodes.slice(0, maxNodes) : [];
    return { id: String(window.id || `w${wi + 1}`), nodes: nodes.map((node, ni) => {
      if (!node || typeof node !== 'object' || !node.bounds) throw new Error('vision_invalid_node');
      const bounds = node.bounds;
      const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(bounds[key]));
      if (numbers.some((number) => !Number.isFinite(number)) || numbers[2] < 0 || numbers[3] < 0) throw new Error('vision_invalid_bounds');
      const confidence = Number(node.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('vision_invalid_confidence');
      return {
        id: String(node.id || `${window.id}-n${ni + 1}`), role: String(node.role || 'unknown'),
        ...(node.text !== undefined ? { text: String(node.text) } : {}),
        bounds: { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] },
        parent: node.parent == null ? null : String(node.parent), confidence,
        source: 'vision'
      };
    }) };
  });
  return { windows };
}

module.exports = { StructuredVisionClient, parseJson, validateLayout };
