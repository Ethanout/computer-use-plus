'use strict';

const { extractToolCall, ToolCallAccumulator, streamToolDeltas, TOOL_DEFINITIONS } = require('./tool-call');

class ToolCallProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.model = options.model || '';
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 8000));
    this.protocol = options.protocol || detectProtocol(this.baseUrl);
  }

  get configured() { return Boolean(this.apiKey && this.fetch && this.baseUrl && this.model); }

  status() {
    return { configured: this.configured, protocol: this.protocol, model: this.model, ...(this.configured ? { baseUrl: this.baseUrl } : {}) };
  }

  async call({ system, user, tools = TOOL_DEFINITIONS, toolChoice = 'auto' }) {
    if (!this.configured) throw new Error('tool_call_provider_not_configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const request = buildRequest(this.protocol, { baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model, system, user, tools, toolChoice });
      const response = await this.fetch(request.endpoint, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`tool_call_http_${response.status}`);
      const payload = await response.json();
      const call = extractToolCall(payload);
      if (!call) throw new Error('tool_call_not_returned');
      return { ...call, model: payload.model || this.model, ...(payload.usage ? { usage: payload.usage } : {}) };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('tool_call_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async callStream({ system, user, tools = TOOL_DEFINITIONS, toolChoice = 'auto', onDelta = null, onToolCall = null }) {
    if (!this.configured) throw new Error('tool_call_provider_not_configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const request = buildRequest(this.protocol, { baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model, system, user, tools, toolChoice, stream: true });
      request.body.stream = true;
      const response = await this.fetch(request.endpoint, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal });
      if (!response.ok) throw new Error(`tool_call_http_${response.status}`);
      const accumulator = new ToolCallAccumulator();
      const dispatched = new Set();
      let dispatchTail = Promise.resolve();
      for await (const event of readEventStream(response)) {
        if (typeof onDelta === 'function') onDelta(event);
        for (const partial of streamToolDeltas(event)) {
          const value = accumulator.push(partial);
          if (!value || typeof onToolCall !== 'function') continue;
          const call = accumulator.tryComplete(value.key);
          if (call && !dispatched.has(call.id || call.name)) {
            dispatched.add(call.id || call.name);
            dispatchTail = dispatchTail.then(() => onToolCall(call));
          }
        }
      }
      await dispatchTail;
      return { ...accumulator.complete(), model: this.model };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('tool_call_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function* readEventStream(response) {
  if (!response.body) return;
  if (typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (!raw || raw === '[DONE]') continue;
        try { yield JSON.parse(raw); } catch (_) { /* ignore non-JSON stream comments */ }
      }
      if (done) break;
    }
    return;
  }
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const value = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
      if (!value || value === '[DONE]') continue;
      try { yield JSON.parse(value); } catch (_) { /* ignore non-JSON stream comments */ }
    }
  }
  const value = buffer.startsWith('data:') ? buffer.slice(5).trim() : buffer.trim();
  if (value && value !== '[DONE]') {
    try { yield JSON.parse(value); } catch (_) { /* ignore incomplete trailing data */ }
  }
}

function detectProtocol(baseUrl) {
  const value = String(baseUrl || '').toLowerCase();
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('generativelanguage') || value.includes('gemini')) return 'gemini';
  return value.includes('/responses') || value.includes('responses') ? 'responses' : 'chat-completions';
}

function buildRequest(protocol, options) {
  const { baseUrl, apiKey, model, system, user, tools, toolChoice } = options;
  if (protocol === 'responses') return {
    endpoint: `${baseUrl}/responses`,
    headers: bearerHeaders(apiKey),
    body: { model, input: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }], tools: toResponsesTools(tools), tool_choice: toolChoice }
  };
  if (protocol === 'anthropic') return {
    endpoint: `${baseUrl}/messages`,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: 300, system, messages: [{ role: 'user', content: JSON.stringify(user) }], tools: toAnthropicTools(tools) }
  };
  if (protocol === 'gemini') return {
    endpoint: `${baseUrl}/models/${encodeURIComponent(model)}:${options.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(user) }] }],
      tools: [{ functionDeclarations: toGeminiTools(tools) }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
    }
  };
  return {
    endpoint: `${baseUrl}/chat/completions`,
    headers: bearerHeaders(apiKey),
    body: { model, temperature: 0, max_tokens: 300, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }], tools, tool_choice: toolChoice }
  };
}

function bearerHeaders(apiKey) { return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }; }

function toResponsesTools(tools) {
  return tools.map((tool) => tool.function ? ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }) : tool);
}

function toAnthropicTools(tools) {
  return tools.map((tool) => ({ name: tool.function?.name || tool.name, description: tool.function?.description || tool.description, input_schema: tool.function?.parameters || tool.parameters }));
}

function toGeminiTools(tools) {
  return tools.map((tool) => ({ name: tool.function?.name || tool.name, description: tool.function?.description || tool.description, parameters: tool.function?.parameters || tool.parameters }));
}

module.exports = { ToolCallProvider, detectProtocol, buildRequest, readEventStream, toResponsesTools, toAnthropicTools, toGeminiTools };
