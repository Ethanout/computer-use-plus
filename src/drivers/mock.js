'use strict';

class MockDriver {
  constructor() {
    this.windows = [{ id: 'mock-1', title: 'Mock Window', process: 'mock', className: 'Mock', isForeground: true }];
    this.elements = [{ name: '保存', role: 'button', automationId: 'save', bounds: { x: 10, y: 10, width: 80, height: 30 }, enabled: true }];
  }
  async listWindows() { return this.windows; }
  async inspect() { return this.elements; }
  async click(_windowId, query) { return { ok: Boolean(query && query.text), element: this.elements[0], changed: ['mock.clicked'] }; }
  async setValue(_windowId, _query, value) { return { ok: true, value, changed: ['mock.value'] }; }
  async sendKeys(_windowId, keys) { return { ok: true, count: Array.isArray(keys) ? keys.length : 1, changed: [] }; }
  async focus() { return { ok: true }; }
}

module.exports = { MockDriver };
