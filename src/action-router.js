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

class LocalActionIdClassifier {
  constructor(options = {}) {
    this.minimumScore = Number.isFinite(Number(options.minimumScore)) ? Number(options.minimumScore) : 0;
  }

  async classify({ intent, candidates }) {
    const query = normalize(intent);
    if (!query || !Array.isArray(candidates) || !candidates.length) return null;
    let best = null;
    for (const candidate of candidates) {
      const values = [candidate.id, candidate.name, ...(candidate.aliases || [])];
      const score = Math.max(...values.map((value) => similarity(query, normalize(value))));
      if (!best || score > best.confidence) best = { id: candidate.id, confidence: score };
    }
    return best && best.confidence >= this.minimumScore ? best : null;
  }
}

function similarity(left, right) {
  const normalizedLeft = semanticNormalize(left);
  const normalizedRight = semanticNormalize(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 0.9;
  return Math.max(dice(normalizedLeft.split(''), normalizedRight.split('')), dice(ngrams(normalizedLeft), ngrams(normalizedRight)));
}

function semanticNormalize(value) {
  return String(value).replace(/^(?:帮我|请|麻烦|给我|我要|我想|能否|可以)+/, '').replace(/一个/g, '');
}

function dice(leftGrams, rightGrams) {
  if (!leftGrams.length || !rightGrams.length) return 0;
  const remaining = new Map();
  for (const gram of rightGrams) remaining.set(gram, (remaining.get(gram) || 0) + 1);
  let shared = 0;
  for (const gram of leftGrams) {
    const count = remaining.get(gram) || 0;
    if (count) {
      shared += 1;
      remaining.set(gram, count - 1);
    }
  }
  return (2 * shared) / (leftGrams.length + rightGrams.length);
}

function ngrams(value) {
  if (value.length < 2) return [value];
  const output = [];
  for (let index = 0; index < value.length - 1; index += 1) output.push(value.slice(index, index + 2));
  return output;
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(/[\s_\-:：]+/g, '');
}

module.exports = { LocalActionIdClassifier, resolveShortcut, resolveShortcutWithClassifier, normalize, similarity };
