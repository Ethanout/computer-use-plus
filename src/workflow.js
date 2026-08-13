'use strict';

function normalizeText(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function actionToken(action) {
  if (!action || typeof action !== 'object') return 'unknown';
  const windowType = action.windowType ? `${normalizeText(action.windowType)}::` : '';
  if (action.click) return `${windowType}click|${normalizeText(action.click.role)}|${normalizeText(action.click.text || action.click.name)}`;
  if (action.setValue) return `${windowType}setValue|${normalizeText(action.setValue.role || 'edit')}|${normalizeText(action.setValue.label)}`;
  if (action.wait) return `${windowType}wait`;
  if (action.hotkey) return `${windowType}hotkey|${JSON.stringify(action.hotkey)}`;
  if (Array.isArray(action.keys)) return `${windowType}keys|${action.keys.map(normalizeText).join(',')}`;
  if (Array.isArray(action.kbseq)) return `${windowType}kbseq|${action.kbseq.map(normalizeText).join(',')}`;
  if (Array.isArray(action.kbops)) return `${windowType}kbops|${action.kbops.map((entry) => normalizeText(entry?.op)).join(',')}`;
  return 'unknown';
}

function sameTransition(left, right) {
  return Boolean(left.beforeFingerprint && right.beforeFingerprint && left.afterFingerprint && right.afterFingerprint
    && left.beforeFingerprint === right.beforeFingerprint && left.afterFingerprint === right.afterFingerprint);
}

function isSubsequence(shorter, longer) {
  let cursor = 0;
  const skipped = [];
  for (const action of longer) {
    if (cursor < shorter.length && actionToken(shorter[cursor]) === actionToken(action)) cursor += 1;
    else skipped.push(action);
  }
  return cursor === shorter.length ? skipped : null;
}

function workflowScope(workflow) {
  return String(workflow.scopeKey || workflow.windowKey || '');
}

function mergeKind(left, right, options = {}) {
  if (workflowScope(left) !== workflowScope(right)) return null;
  if (options.requireTransition !== false && !sameTransition(left, right)) return null;
  if (Math.max(Number(left.uses || 0), Number(right.uses || 0)) < (options.minUses || 3)) return null;
  if (Number(left.uses || 0) + Number(right.uses || 0) < (options.minTotalUses || 5)) return null;
  const a = left.actions || [];
  const b = right.actions || [];
  if (!a.length || !b.length || actionToken(a[0]) !== actionToken(b[0]) || actionToken(a.at(-1)) !== actionToken(b.at(-1))) return null;
  if (a.length === b.length && a.every((action, index) => actionToken(action) === actionToken(b[index]))) return 'parameter-equivalent';
  if (Math.abs(a.length - b.length) === 1) {
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    const skipped = isSubsequence(shorter, longer);
    if (skipped?.length === 1 && skipped[0]?.wait) return 'safe-wait-variant';
  }
  return null;
}

function sequenceSimilarity(left, right) {
  const a = left.actions || [];
  const b = right.actions || [];
  if (!a.length || !b.length || workflowScope(left) !== workflowScope(right)) return 0;
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const score = actionToken(a[i - 1]) === actionToken(b[j - 1]) ? 1 : 0;
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1] + score);
    }
  }
  return (2 * dp[a.length][b.length]) / (a.length + b.length);
}

function candidatePairs(workflows, options = {}) {
  const threshold = Number(options.threshold || 0.72);
  const active = workflows.filter((workflow) => !workflow.archivedAt);
  const pairs = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const left = active[i];
      const right = active[j];
      if (workflowScope(left) !== workflowScope(right)) continue;
      const similarity = sequenceSimilarity(left, right);
      if (similarity >= threshold && !mergeKind(left, right, { minUses: Number.MAX_SAFE_INTEGER, minTotalUses: Number.MAX_SAFE_INTEGER })) {
        pairs.push({ left, right, similarity: Number(similarity.toFixed(3)) });
      }
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity).slice(0, Math.max(1, Math.min(Number(options.limit) || 20, 50)));
}

module.exports = { actionToken, mergeKind, sequenceSimilarity, candidatePairs, workflowScope };
