'use strict';

const ROLE_ALIASES = new Map([
  ['button', ['button']], ['按钮', ['button']],
  ['checkbox', ['checkbox']], ['复选框', ['checkbox']],
  ['textbox', ['edit', 'textbox']], ['输入框', ['edit', 'textbox']],
  ['link', ['hyperlink', 'link']], ['链接', ['hyperlink', 'link']],
  ['menuitem', ['menuitem']], ['菜单项', ['menuitem']]
]);

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function roleMatches(elementRole, requestedRole) {
  if (!requestedRole) return true;
  const wanted = ROLE_ALIASES.get(normalize(requestedRole)) || [normalize(requestedRole)];
  const actual = normalize(elementRole);
  return wanted.some((role) => actual === role || actual.endsWith(`.${role}`) || actual.includes(role));
}

function textScore(actual, wanted) {
  const a = normalize(actual);
  const w = normalize(wanted);
  if (!w) return 0.2;
  if (a === w) return 1;
  if (a.includes(w)) return 0.82;
  const tokens = w.split(/\s+/).filter(Boolean);
  if (tokens.length && tokens.every((token) => a.includes(token))) return 0.68;
  let common = 0;
  for (const token of tokens) if (a.includes(token)) common += 1;
  const tokenScore = tokens.length ? (common / tokens.length) * 0.55 : 0;
  if (a && w) {
    const previous = Array.from({ length: w.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = previous[0];
      previous[0] = i;
      for (let j = 1; j <= w.length; j++) {
        const saved = previous[j];
        previous[j] = Math.min(
          previous[j] + 1,
          previous[j - 1] + 1,
          diagonal + (a[i - 1] === w[j - 1] ? 0 : 1)
        );
        diagonal = saved;
      }
    }
    const similarity = 1 - (previous[w.length] / Math.max(a.length, w.length));
    if (similarity >= 0.7) return Math.max(tokenScore, similarity);
  }
  return tokenScore;
}

function rankElements(elements, query = {}) {
  return elements
    .filter((element) => roleMatches(element.role || element.controlType, query.role))
    .filter((element) => !query.automationId || String(element.automationId || '').toLocaleLowerCase() === String(query.automationId).toLocaleLowerCase())
    .filter((element) => !query.className || String(element.className || '').toLocaleLowerCase() === String(query.className).toLocaleLowerCase())
    .map((element) => ({ ...element, score: textScore(element.name || element.text, query.text) }))
    .filter((element) => !query.text || element.score >= 0.35)
    .sort((a, b) => b.score - a.score || String(a.name).length - String(b.name).length)
    .slice(0, query.limit || 10);
}

module.exports = { normalize, rankElements, roleMatches, textScore };
