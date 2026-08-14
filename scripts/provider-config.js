'use strict';

const path = require('node:path');
const { ProviderConfigStore } = require('../src/provider-config');
const { ToolCallProvider } = require('../src/providers');
const { TOOL_DEFINITIONS } = require('../src/tool-call');

const args = process.argv.slice(2);
const command = args.shift() || 'list';
const dataDir = process.env.COMPUTER_USE_PLUS_DATA_DIR || path.resolve('.data');
const store = new ProviderConfigStore(path.join(dataDir, 'providers.json'));

function option(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`provider_option_value_required:${name}`);
  return value;
}

function required(value, name) {
  if (!value) throw new Error(`provider_argument_required:${name}`);
  return value;
}

function revision() {
  const value = option('revision');
  return value === undefined ? null : Number(value);
}

async function main() {
  if (command === 'list') return print(store.list());
  if (command === 'activate') return print(store.activate(required(args[0], 'id'), revision()));
  if (command === 'remove') return print(store.remove(required(args[0], 'id'), revision()));
  if (command === 'set') {
    const id = required(args[0], 'id');
    const apiKeyEnv = option('api-key-env');
    const apiKeyFile = option('api-key-file');
    if ((apiKeyEnv && apiKeyFile) || (!apiKeyEnv && !apiKeyFile)) throw new Error('provider_key_reference_required');
    return print(store.upsert({
      id,
      label: option('label', id),
      baseUrl: required(option('base-url'), 'base-url'),
      model: required(option('model'), 'model'),
      protocol: option('protocol', 'openai'),
      ...(apiKeyEnv ? { apiKey: { type: 'env', name: apiKeyEnv } } : { apiKey: { type: 'file', path: apiKeyFile } }),
      timeoutMs: option('timeout-ms'),
      inputUsdPerMillion: option('input-usd-per-million'),
      outputUsdPerMillion: option('output-usd-per-million')
    }, revision()));
  }
  if (command === 'test') {
    const selected = store.resolve(required(args[0], 'id'));
    if (!selected?.apiKey) return print({ ok: false, reason: 'provider_key_not_configured' });
    const provider = new ToolCallProvider(selected);
    const result = await provider.call({
      system: 'Return one valid tool call. Do not execute it.',
      user: { goal: 'provider connectivity test' },
      tools: TOOL_DEFINITIONS.slice(0, 1),
      toolChoice: 'auto'
    });
    return print({ ok: true, id: selected.id, model: result.model, protocol: selected.protocol, ...(result.usage ? { usage: result.usage } : {}) });
  }
  throw new Error(`provider_command_unknown:${command}`);
}

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
