'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ToolCallProvider } = require('./providers');
const { TOOL_DEFINITIONS } = require('./tool-call');

const BLOCKED_KEY_FILES = new Set([
  path.resolve('C:\\重要的资料\\身份认证和各种key\\deepseek.txt').toLocaleLowerCase()
]);

const DEFAULT_SYSTEM_PROMPT = [
  '你是低延迟电脑操作规划器。优先返回原生工具调用，不输出解释、Markdown 或普通文本 JSON。',
  '优先调用 shortcut.run；没有可复用快捷操作时调用 computer.invoke。',
  '允许的底层动作只有 click、setValue、hotkey、keys、kbseq、kbops、wait。',
  '高层等待使用 wait.seconds，单位为秒且允许小数；只有 kbops.at 使用毫秒。',
  '一次规划尽量覆盖当前目标，但不得写入、重命名、合并或删除长期记忆。无法安全判断时不要调用工具。'
].join('\n');

const ACTION_KEYS = new Set(['click', 'setValue', 'hotkey', 'keys', 'kbseq', 'kbops', 'wait']);

class FastAiClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.COMPUTER_USE_PLUS_FAST_API_KEY || process.env.COMPUTER_USE_PLUS_AI_API_KEY || readKeyFile(options.apiKeyFile || process.env.COMPUTER_USE_PLUS_AI_KEY_FILE);
    this.baseUrl = (options.baseUrl || process.env.COMPUTER_USE_PLUS_FAST_BASE_URL || process.env.COMPUTER_USE_PLUS_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = options.model || process.env.COMPUTER_USE_PLUS_FAST_MODEL || process.env.COMPUTER_USE_PLUS_AI_MODEL || 'gpt-4o-mini';
    this.timeoutMs = Number(options.timeoutMs || process.env.COMPUTER_USE_PLUS_FAST_TIMEOUT_MS || 8000);
    this.systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.fetch = options.fetch || globalThis.fetch;
    this.protocol = options.protocol || process.env.COMPUTER_USE_PLUS_AI_PROTOCOL || undefined;
    this.provider = options.provider || new ToolCallProvider({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      timeoutMs: this.timeoutMs,
      fetch: this.fetch,
      protocol: this.protocol
    });
  }

  get configured() { return Boolean(this.apiKey && this.fetch); }

  status() {
    return { configured: this.configured, model: this.model, protocol: this.provider.protocol, ...(this.configured ? { baseUrl: this.baseUrl } : {}) };
  }

  async planToolCall({ goal, snapshot, params = {}, maxActions = 20, window }) {
    const call = await this.provider.call({
      system: this.systemPrompt,
      user: { goal, window, params, maxActions: clamp(maxActions, 1, 100, 20), snapshot },
      tools: TOOL_DEFINITIONS,
      toolChoice: 'auto'
    });
    return call;
  }

  async planToolCallStream({ goal, snapshot, params = {}, maxActions = 20, window, onToolCall }) {
    return this.provider.callStream({
      system: this.systemPrompt,
      user: { goal, window, params, maxActions: clamp(maxActions, 1, 100, 20), snapshot },
      tools: TOOL_DEFINITIONS,
      toolChoice: 'auto',
      onToolCall
    });
  }

  async plan({ goal, snapshot, params = {}, maxActions = 20 }) {
    return this.requestJson({
      system: `${this.systemPrompt}\n兼容模式下只输出 {"actions":[...]}。`,
      user: { goal, params, maxActions: clamp(maxActions, 1, 100, 20), snapshot },
      validate: (value) => validatePlan(value, maxActions)
    });
  }

  async organize({ candidates, maxOperations = 20 }) {
    const system = [
      '你是电脑操作记忆整理器，只输出 JSON。',
      '输入是本地脚本筛选出的候选动作链，只能建议 merge、rename、archive。',
      '不要创造或修改动作内容；无法确定时返回空 operations。',
      '格式为 {"operations":[{"op":"merge","keep":"...","remove":["..."]}]}。'
    ].join('\n');
    return this.requestJson({
      system,
      user: { candidates, maxOperations: clamp(maxOperations, 1, 50, 20) },
      validate: (value) => validateOrganization(value, maxOperations)
    });
  }

  async requestJson({ system, user, validate }) {
    if (!this.configured) throw new Error('fast_ai_not_configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, this.timeoutMs));
    try {
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: 600, messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(user) }
        ] }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`fast_ai_http_${response.status}`);
      const payload = await response.json();
      const value = validate(parseJson(payload?.choices?.[0]?.message?.content));
      return { ...value, model: payload.model || this.model, ...(payload.usage ? { usage: payload.usage } : {}) };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('fast_ai_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function readKeyFile(filePath) {
  if (!filePath) return '';
  const resolved = path.resolve(String(filePath)).toLocaleLowerCase();
  if (BLOCKED_KEY_FILES.has(resolved)) return '';
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch (_) { return ''; }
}

function parseJson(content) {
  if (typeof content !== 'string') throw new Error('fast_ai_invalid_response');
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(trimmed); } catch (_) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('fast_ai_invalid_json');
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (_) { throw new Error('fast_ai_invalid_json'); }
  }
}

function validatePlan(value, maxActions) {
  if (!value || !Array.isArray(value.actions)) throw new Error('fast_ai_actions_required');
  if (value.actions.length > clamp(maxActions, 1, 100, 20)) throw new Error('fast_ai_actions_limit_exceeded');
  for (const action of value.actions) {
    const keys = Object.keys(action || {});
    if (keys.length !== 1 || !ACTION_KEYS.has(keys[0])) throw new Error('fast_ai_unsupported_action');
  }
  return { actions: value.actions };
}

function validateOrganization(value, maxOperations) {
  if (!value || !Array.isArray(value.operations)) throw new Error('fast_ai_operations_required');
  if (value.operations.length > clamp(maxOperations, 1, 50, 20)) throw new Error('fast_ai_operations_limit_exceeded');
  for (const operation of value.operations) {
    if (!operation || !['merge', 'rename', 'archive'].includes(operation.op)) throw new Error('fast_ai_unsupported_operation');
    if (operation.op === 'merge' && (!operation.keep || !Array.isArray(operation.remove) || !operation.remove.length)) throw new Error('fast_ai_invalid_merge');
    if (operation.op === 'rename' && (!operation.name || !operation.newName)) throw new Error('fast_ai_invalid_rename');
    if (operation.op === 'archive' && !operation.name) throw new Error('fast_ai_invalid_archive');
  }
  return { operations: value.operations };
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Math.max(minimum, Math.min(Number.isFinite(number) ? number : fallback, maximum));
}

module.exports = { FastAiClient, DEFAULT_SYSTEM_PROMPT, parseJson, validatePlan, validateOrganization, readKeyFile, BLOCKED_KEY_FILES };
