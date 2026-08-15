'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

class CdpClient {
  constructor(options = {}) {
    this.endpoint = String(options.endpoint || 'http://127.0.0.1:9222').replace(/\/$/, '');
    this.fetch = options.fetch || globalThis.fetch;
    this.WebSocket = options.WebSocket || globalThis.WebSocket;
    this.transport = options.transport || null;
    this.sockets = new Map();
    this.sequence = 0;
  }

  async targets() {
    if (this.transport?.targets) return this.transport.targets();
    if (!this.fetch) throw new Error('cdp_fetch_unavailable');
    const response = await this.fetch(`${this.endpoint}/json/list`);
    if (!response.ok) throw new Error(`cdp_http_${response.status}`);
    const values = await response.json();
    return Array.isArray(values) ? values.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl) : [];
  }

  async send(target, method, params = {}) {
    if (this.transport?.send) return this.transport.send(target, method, params);
    if (!target?.webSocketDebuggerUrl) throw new Error('cdp_target_not_found');
    const socket = await this.socket(target);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.pending.delete(id); reject(new Error('cdp_timeout')); }, 10000);
      socket.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  socket(target) {
    const existing = this.sockets.get(target.id);
    if (existing) return existing.ready;
    if (!this.WebSocket) return Promise.reject(new Error('cdp_websocket_unavailable'));
    const ws = new this.WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    const ready = new Promise((resolve, reject) => {
      ws.addEventListener?.('open', () => resolve({ ws, pending }));
      ws.addEventListener?.('error', () => reject(new Error('cdp_websocket_error')));
      ws.onopen = () => resolve({ ws, pending });
      ws.onerror = () => reject(new Error('cdp_websocket_error'));
    });
    const handle = (event) => {
      try {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        if (message.id && pending.has(message.id)) {
          const item = pending.get(message.id); pending.delete(message.id);
          if (message.error) item.reject(new Error(message.error.message || 'cdp_command_failed'));
          else item.resolve(message.result || {});
        }
      } catch (_) { /* Ignore unrelated protocol frames. */ }
    };
    ws.addEventListener?.('message', handle); ws.onmessage = handle;
    ws.addEventListener?.('close', () => this.sockets.delete(target.id)); ws.onclose = () => this.sockets.delete(target.id);
    this.sockets.set(target.id, { ready });
    return ready;
  }
}

class CdpDriver {
  constructor(options = {}) {
    this.client = options.client || new CdpClient(options);
    this.dataDir = options.dataDir || path.resolve('.data');
    this.maxNodes = Math.max(1, Math.min(Number(options.maxNodes) || 100, 300));
    this.targetsById = new Map();
  }

  async listWindows() {
    const targets = await this.client.targets();
    this.targetsById = new Map(targets.map((target) => [String(target.id), target]));
    return targets.map((target) => ({
      id: String(target.id), title: target.title || '', process: 'chromium', className: 'CDPPage',
      url: target.url || '', isForeground: false, backend: 'cdp'
    }));
  }

  target(windowId) {
    const target = this.targetsById.get(String(windowId));
    if (!target) throw new Error('window_not_found');
    return target;
  }

  async inspect(windowId, query = {}) {
    const target = this.target(windowId);
    let accessibility = null;
    try { accessibility = await this.client.send(target, 'Accessibility.getFullAXTree', {}); } catch (_) { /* DOM remains a valid local fallback. */ }
    const expression = `(${DOM_SNAPSHOT.toString()})(${JSON.stringify({ query, maxNodes: this.maxNodes })})`;
    const response = await this.client.send(target, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const elements = response?.result?.value?.elements || [];
    const domElements = elements.map((element) => ({ ...element, source: accessibility?.nodes ? 'cdp.ax-dom' : 'cdp.dom' }));
    if (domElements.length || !Array.isArray(accessibility?.nodes)) return domElements;
    const text = String(query.text || '').toLocaleLowerCase();
    const role = String(query.role || '').toLocaleLowerCase();
    return accessibility.nodes.map((node, index) => {
      const name = node?.name?.value || '';
      const nodeRole = node?.role?.value || 'unknown';
      return { id: `ax${index + 1}`, name, text: name, role: nodeRole, bounds: null, confidence: 0.8, source: 'cdp.ax' };
    }).filter((node) => (!text || node.text.toLocaleLowerCase().includes(text)) && (!role || node.role.toLocaleLowerCase() === role)).slice(0, this.maxNodes);
  }

  async evaluate(windowId, expression) {
    const response = await this.client.send(this.target(windowId), 'Runtime.evaluate', { expression: String(expression), returnByValue: true, awaitPromise: true });
    return response?.result?.value;
  }

  async waitForReady(windowId, timeoutMs = 10000) {
    const started = Date.now();
    let state = 'unknown';
    while (Date.now() - started <= timeoutMs) {
      try {
        state = await this.evaluate(windowId, 'document.readyState');
        if (state === 'interactive' || state === 'complete') return { ok: true, readyState: state, elapsedMs: Date.now() - started };
      } catch (_) { /* Navigation can briefly invalidate an evaluation. */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { ok: false, readyState: state, elapsedMs: Date.now() - started };
  }

  async click(windowId, query) {
    const element = (await this.inspect(windowId, query))[0];
    if (!element) throw new Error('target_not_found');
    await this.client.send(this.target(windowId), 'Runtime.evaluate', { expression: `(${CLICK_NODE.toString()})(${JSON.stringify(query)})`, awaitPromise: true, returnByValue: true });
    return { ok: true, strategy: 'cdp.dom.click', element, changed: [`clicked:${element.name || element.text || ''}`] };
  }

  async setValue(windowId, query, value) {
    const element = (await this.inspect(windowId, query))[0];
    if (!element) throw new Error('target_not_found');
    await this.client.send(this.target(windowId), 'Runtime.evaluate', { expression: `(${SET_VALUE.toString()})(${JSON.stringify(query)},${JSON.stringify(String(value))})`, awaitPromise: true, returnByValue: true });
    return { ok: true, strategy: 'cdp.dom.value', element, changed: ['value_changed'] };
  }

  async sendKeys(windowId, keys) {
    for (const item of Array.isArray(keys) ? keys : [keys]) {
      const key = typeof item === 'string' ? item : String(item?.key || item?.op || '');
      const delay = typeof item === 'object' ? Number(item.at || 0) : 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30000)));
      await this.client.send(this.target(windowId), 'Input.dispatchKeyEvent', { type: 'keyDown', key });
      await this.client.send(this.target(windowId), 'Input.dispatchKeyEvent', { type: 'keyUp', key });
    }
    return { ok: true, strategy: 'cdp.input', changed: [] };
  }

  async focus(windowId) { await this.client.send(this.target(windowId), 'Page.bringToFront'); return { ok: true }; }

  async clickAt(windowId, bounds) {
    const x = Number(bounds?.x || 0) + Number(bounds?.width || 0) / 2;
    const y = Number(bounds?.y || 0) + Number(bounds?.height || 0) / 2;
    await this.client.send(this.target(windowId), 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.client.send(this.target(windowId), 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { ok: true, strategy: 'cdp.input.mouse', changed: [] };
  }

  async capture(windowId) {
    const response = await this.client.send(this.target(windowId), 'Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(this.dataDir, { recursive: true });
    const output = path.join(this.dataDir, `capture-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    fs.writeFileSync(output, Buffer.from(response.data || '', 'base64'));
    return { path: output, bounds: null, scale: 1 };
  }
}

function DOM_SNAPSHOT({ query = {}, maxNodes = 100 }) {
  const selectors = 'button,a,input,textarea,select,[role],[contenteditable="true"],[tabindex],h1,h2,h3,h4,p,[class*="title"],[class*="tit"]';
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const values = [...document.querySelectorAll(selectors)].map((el, index) => {
    const rect = el.getBoundingClientRect(); const role = normalize(el.getAttribute('role') || el.tagName.toLowerCase());
    const text = normalize(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value);
    return { id: `n${index + 1}`, name: text, text, role, automationId: el.id || '', bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, enabled: !el.disabled };
  }).filter((item) => (!query.text || item.text.toLocaleLowerCase().includes(String(query.text).toLocaleLowerCase())) && (!query.role || item.role.toLocaleLowerCase() === String(query.role).toLocaleLowerCase())).slice(0, maxNodes);
  if (!values.length && query.text) {
    const body = normalize(document.body && document.body.innerText);
    const wanted = String(query.text).toLocaleLowerCase(); const offset = body.toLocaleLowerCase().indexOf(wanted);
    if (offset >= 0) values.push({ id: 'body-text', name: body.slice(Math.max(0, offset - 160), offset + wanted.length + 240), text: body.slice(Math.max(0, offset - 160), offset + wanted.length + 240), role: 'document', bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, enabled: true, source: 'cdp.body-text' });
  }
  return { elements: values };
}

function CLICK_NODE(query) {
  const elements = [...document.querySelectorAll('button,a,input,textarea,select,[role],[contenteditable="true"]')];
  const wanted = String(query?.text || '').toLocaleLowerCase();
  const item = elements.find((el) => String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').toLocaleLowerCase().includes(wanted));
  if (!item) throw new Error('target_not_found'); item.click(); return true;
}

function SET_VALUE(query, value) {
  const wanted = String(query?.text || query?.label || '').toLocaleLowerCase();
  const item = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].find((el) => String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').toLocaleLowerCase().includes(wanted));
  if (!item) throw new Error('target_not_found'); item.focus(); item.value = value; item.dispatchEvent(new Event('input', { bubbles: true })); item.dispatchEvent(new Event('change', { bubbles: true })); return true;
}

class BrowserCdpLauncher {
  constructor(options = {}) { this.executable = options.executable || process.env.COMPUTER_USE_PLUS_BROWSER_EXECUTABLE || ''; this.spawn = options.spawn || spawn; this.execution = options.execution || null; this.child = null; this.profileDir = options.profileDir; this.downloadDir = options.downloadDir || null; this.port = Number(options.port || 9222); }
  async launch(url = 'about:blank') {
    if (!this.executable) throw new Error('browser_executable_required');
    if (this.child) return { pid: this.child.pid, port: this.port, profileDir: this.profileDir };
    if (!this.profileDir) throw new Error('browser_profile_required');
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [`--user-data-dir=${this.profileDir}`, `--remote-debugging-port=${this.port}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', ...(this.downloadDir ? [`--download-default-directory=${this.downloadDir}`, '--disable-prompt-for-download'] : []), '--new-window', url];
    if (this.execution) {
      const quote = (value) => /[\s"]/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value);
      const launched = await this.execution.launch([quote(this.executable), ...args.map(quote)].join(' '));
      this.child = { pid: launched.pid, killed: false };
      return { pid: launched.pid, port: this.port, profileDir: this.profileDir, desktop: launched.desktop };
    }
    this.child = this.spawn(this.executable, args, { detached: false, windowsHide: true, stdio: 'ignore' });
    const child = this.child;
    child.once?.('exit', () => { if (this.child === child) this.child = null; });
    child.once?.('error', () => { if (this.child === child) this.child = null; });
    return { pid: this.child.pid, port: this.port, profileDir: this.profileDir };
  }
  stop() {
    if (this.child && typeof this.child.kill === 'function' && !this.child.killed) this.child.kill();
    this.child = null;
  }
}

module.exports = { CdpClient, CdpDriver, BrowserCdpLauncher, DOM_SNAPSHOT };
