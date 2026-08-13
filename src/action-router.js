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

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(/[\s_\-:：]+/g, '');
}

module.exports = { resolveShortcut, normalize };
