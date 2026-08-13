'use strict';

const TOOL_NAMES = new Set([
  'shortcut.run',
  'computer.invoke',
  'computer.state',
  'computer.inspect',
  'computer.verify',
  'computer.cancel'
]);

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'computer.invoke',
      description: 'Execute a bounded computer action batch or a saved shortcut.',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'string' },
          shortcut_id: { type: 'string' },
          params: { type: 'object', additionalProperties: true },
          actions: { type: 'array', maxItems: 100, items: { type: 'object' } },
          confirm_token: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'shortcut.run',
      description: 'Run a previously verified shortcut by id or name.',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'string' },
          shortcut_id: { type: 'string' },
          name: { type: 'string' },
          params: { type: 'object', additionalProperties: true },
          confirm_token: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  }
];

function normalizeArguments(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') throw new Error('tool_call_arguments_invalid');
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed;
  } catch (_) {
    throw new Error('tool_call_arguments_invalid');
  }
}

function makeToolCall(name, args, id = null) {
  if (!TOOL_NAMES.has(name)) throw new Error('tool_call_unknown_tool');
  const argumentsValue = normalizeArguments(args);
  return { type: 'tool_call', ...(id ? { id: String(id) } : {}), name, arguments: argumentsValue };
}

function normalizeToolCall(value) {
  if (!value) throw new Error('tool_call_missing');
  if (value.type === 'tool_call' && value.name) return makeToolCall(value.name, value.arguments, value.id);
  if (value.type === 'function_call' && value.name) return makeToolCall(value.name, value.arguments, value.call_id || value.id);
  if (value.type === 'tool_use' && value.name) return makeToolCall(value.name, value.input, value.id);
  if (value.functionCall?.name) return makeToolCall(value.functionCall.name, value.functionCall.args);
  if (value.function?.name) return makeToolCall(value.function.name, value.function.arguments, value.id);
  if (value.function_call?.name) return makeToolCall(value.function_call.name, value.function_call.arguments, value.id);
  if (value.name && (value.arguments !== undefined || value.input !== undefined || value.args !== undefined)) {
    return makeToolCall(value.name, value.arguments ?? value.input ?? value.args, value.id);
  }
  throw new Error('tool_call_missing');
}

class ToolCallAccumulator {
  constructor() { this.calls = new Map(); this.indexIds = new Map(); }

  push(event) {
    const delta = event?.delta || event;
    const index = Number(delta?.index ?? event?.index ?? 0);
    const knownId = this.indexIds.get(index);
    const id = delta?.id || event?.item_id || knownId || `index:${index}`;
    this.indexIds.set(index, id);
    const previous = this.calls.get(id) || { id: delta?.id || event?.item_id || null, name: '', arguments: '' };
    const fn = delta?.function || delta?.function_call || {};
    previous.name += String(delta?.name || fn.name || event?.name || event?.content_block?.name || '');
    const fragment = delta?.arguments ?? delta?.partial_json ?? fn.arguments ?? event?.arguments_delta ?? (typeof event?.delta === 'string' ? event.delta : undefined);
    if (typeof fragment === 'string') previous.arguments += fragment;
    this.calls.set(id, previous);
    return previous;
  }

  complete(id = null) {
    const value = id ? this.calls.get(id) : this.calls.values().next().value;
    if (!value) throw new Error('tool_call_missing');
    return makeToolCall(value.name, value.arguments || '{}', value.id);
  }
}

function extractToolCall(payload) {
  const candidates = [];
  if (payload?.type === 'response.completed' || payload?.type === 'response.output_item.done') candidates.push(payload.item || payload.response?.output?.[0]);
  candidates.push(payload?.tool_call, payload?.toolCall, payload?.function_call);
  for (const item of payload?.output || []) candidates.push(item);
  for (const item of payload?.content || []) candidates.push(item);
  for (const item of payload?.choices?.[0]?.message?.tool_calls || []) candidates.push(item);
  const part = payload?.candidates?.[0]?.content?.parts?.find((item) => item.functionCall);
  if (part) candidates.push(part);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return normalizeToolCall(candidate); } catch (_) { /* inspect the next protocol shape */ }
  }
  return null;
}

function actionIdToShortcut(actionId) {
  if (!actionId) return null;
  const value = String(actionId).trim();
  return value.startsWith('shortcut.') ? value.slice('shortcut.'.length) : value;
}

module.exports = { TOOL_NAMES, TOOL_DEFINITIONS, ToolCallAccumulator, normalizeToolCall, extractToolCall, makeToolCall, actionIdToShortcut };
