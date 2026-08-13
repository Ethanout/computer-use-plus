'use strict';

function resolveShortcut(memory, windowKey, intent, explicitId = '') {
  const requested = normalize(explicitId || intent);
  if (!requested || !memory) return null;
  if (typeof memory.findWorkflow === 'function') {
    const exact = memory.findWorkflow(explicitId || intent, windowKey);
    if (exact) return exact;
  }
  const workflows = typeof memory.listWorkflows === 'function' ? memory.listWorkflows(windowKey, 100) : [];
  return workflows.find((workflow) => {
    const values = [workflow.name, ...(workflow.aliases || [])].map(normalize);
    return values.some((value) => value === requested || value.includes(requested) || requested.includes(value));
  }) || null;
}

async function resolveShortcutWithClassifier(memory, windowKey, intent, options = {}) {
  const exact = resolveShortcut(memory, windowKey, intent, options.explicitId || '');
  if (exact || !options.classifier || options.explicitId) return { shortcut: exact, source: exact ? 'local-match' : 'none' };
  const workflows = typeof memory?.listWorkflows === 'function' ? memory.listWorkflows(windowKey, options.limit || 100) : [];
  if (!workflows.length) return { shortcut: null, source: 'none' };
  const startedAt = Date.now();
  const candidate = await options.classifier.classify({
    intent: String(intent || ''),
    windowKey,
    candidates: workflows.map((workflow) => ({ id: workflow.id || workflow.name, name: workflow.name, aliases: workflow.aliases || [] }))
  });
  const latencyMs = Date.now() - startedAt;
  const confidence = Number(candidate?.confidence || 0);
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.85;
  if (!candidate?.id || confidence < threshold) return { shortcut: null, source: 'classifier-rejected', confidence, latencyMs };
  const requested = normalize(candidate.id);
  const shortcut = workflows.find((workflow) => [workflow.id, workflow.name, ...(workflow.aliases || [])].map(normalize).includes(requested)) || null;
  return { shortcut, source: shortcut ? 'classifier' : 'classifier-unknown-id', confidence, latencyMs };
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(/[\s_\-:：]+/g, '');
}

module.exports = { resolveShortcut, resolveShortcutWithClassifier, normalize };
