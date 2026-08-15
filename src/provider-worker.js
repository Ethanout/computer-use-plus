'use strict';

const { ProviderConfigStore } = require('./provider-config');
const { FastAiClient } = require('./fast-ai');

const protocolVersion = '1';
const configFile = process.env.COMPUTER_USE_PLUS_PROVIDER_CONFIG_FILE || '';
const fake = process.env.CUP_PROVIDER_WORKER_FAKE === '1';
let client = null;
let revision = -1;

function send(message) {
  if (typeof process.send === 'function') process.send(message);
}

function getClient() {
  if (fake) return null;
  if (!configFile) throw new Error('provider_config_file_missing');
  const store = new ProviderConfigStore(configFile);
  const config = store.read();
  if (!client || revision !== config.revision) {
    client = new FastAiClient(store.resolve() || {});
    revision = config.revision;
  }
  return client;
}

function publicStatus() {
  if (fake) return { configured: true, model: 'fake', protocol: 'openai' };
  if (!configFile) return { configured: false };
  try {
    const listed = new ProviderConfigStore(configFile).list();
    const active = listed.profiles.find((profile) => profile.id === listed.active);
    return active ? { configured: active.configured, model: active.model, protocol: active.protocol } : { configured: false };
  } catch { return { configured: false }; }
}

async function handle(payload = {}) {
  const method = String(payload.method || '');
  if (fake) {
    if (method === 'status') return { configured: true, model: 'fake', protocol: 'openai' };
    if (method === 'planToolCall' || method === 'planToolCallStream') return { type: 'tool_call', name: 'computer.cancel', arguments: { reason: 'fake' }, model: 'fake' };
    if (method === 'plan') return { actions: [], model: 'fake' };
    if (method === 'organize') return { operations: [], model: 'fake' };
    throw new Error('provider_worker_method_invalid');
  }
  const instance = getClient();
  if (method === 'status') return instance.status();
  if (method === 'planToolCall') return instance.planToolCall(payload.args || {});
  if (method === 'planToolCallStream') {
    const args = payload.args || {};
    const result = await instance.planToolCall(args);
    if (args.dispatch === true) return result;
    return result;
  }
  if (method === 'plan') return instance.plan(payload.args || {});
  if (method === 'organize') return instance.organize(payload.args || {});
  throw new Error('provider_worker_method_invalid');
}

process.on('message', async (message) => {
  if (!message || message.type !== 'request' || !message.id) return;
  try {
    const result = await handle(message.payload);
    send({ type: 'response', id: String(message.id), result });
  } catch (error) {
    // Only stable error codes cross the process boundary. Never forward stacks or config.
    send({ type: 'response', id: String(message.id), error: sanitizeError(error) });
  }
});

function sanitizeError(error) {
  const code = String(error?.message || '');
  if (/^(?:provider_|tool_call_|fast_ai_)[a-z0-9_]+$/i.test(code)) return code.slice(0, 120);
  return 'provider_worker_failed';
}

send({ type: 'ready', protocolVersion, status: publicStatus() });
