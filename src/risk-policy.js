'use strict';

const fs = require('node:fs');

const DEFAULT_RULES = [
  { id: 'file-delete-overwrite', decision: 'confirm', risk: 'file_delete_or_overwrite', pattern: 'delete|remove|unlink|overwrite|覆盖|删除|移除|清空' },
  { id: 'message-send-publish', decision: 'confirm', risk: 'message_send_or_publish', pattern: 'send|submit|publish|post|发送|提交|发布' },
  { id: 'purchase-payment', decision: 'confirm', risk: 'purchase_or_payment', pattern: 'buy|purchase|pay|checkout|购买|支付|付款' },
  { id: 'account-permission', decision: 'confirm', risk: 'account_or_permission_change', pattern: 'password|permission|admin|credential|token|权限|密码|账号|认证' }
];

class RiskPolicy {
  constructor(options = {}) {
    this.mode = ['none', 'high-risk', 'all-side-effects'].includes(options.mode) ? options.mode : 'high-risk';
    this.rules = normalizeRules(options.rules || DEFAULT_RULES);
  }

  evaluate(actions, context = {}) {
    const text = JSON.stringify({ actions, process: context.process || '', title: context.title || '' }).toLocaleLowerCase();
    const matches = [];
    for (const rule of this.rules) {
      if (rule.process && !new RegExp(rule.process, 'i').test(String(context.process || ''))) continue;
      if (rule.title && !new RegExp(rule.title, 'i').test(String(context.title || ''))) continue;
      if (!new RegExp(rule.pattern, 'i').test(text)) continue;
      matches.push({ id: rule.id, decision: rule.decision, risk: rule.risk });
    }
    if (this.mode === 'all-side-effects' && actions.some(isSideEffect) && !matches.length) {
      matches.push({ id: 'all-side-effects', decision: 'confirm', risk: 'external_side_effect' });
    }
    const denied = matches.filter((item) => item.decision === 'deny');
    const confirmations = matches.filter((item) => item.decision === 'confirm');
    return {
      decision: denied.length ? 'deny' : (this.mode !== 'none' && confirmations.length ? 'confirm' : 'allow'),
      risks: [...new Set(matches.map((item) => item.risk))],
      rules: matches.map((item) => item.id),
      summary: summarize(actions, context)
    };
  }
}

function loadRiskPolicy(filePath, fallback = {}) {
  if (!filePath) return new RiskPolicy(fallback);
  try { return new RiskPolicy(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch (error) { throw new Error(`risk_policy_invalid:${error.message}`); }
}

function normalizeRules(rules) {
  if (!Array.isArray(rules) || rules.length > 100) throw new Error('risk_policy_rules_invalid');
  return rules.map((rule, index) => {
    if (!rule?.pattern || !['allow', 'confirm', 'deny'].includes(rule.decision)) throw new Error('risk_policy_rule_invalid');
    try { new RegExp(rule.pattern, 'i'); } catch (_) { throw new Error('risk_policy_pattern_invalid'); }
    return { id: String(rule.id || `rule-${index + 1}`).slice(0, 80), decision: rule.decision, risk: String(rule.risk || rule.id || 'custom_risk').slice(0, 80), pattern: String(rule.pattern), process: rule.process ? String(rule.process) : '', title: rule.title ? String(rule.title) : '' };
  });
}

function isSideEffect(action) { return Boolean(action?.click || action?.setValue || action?.hotkey || action?.keys || action?.kbseq || action?.kbops); }
function summarize(actions, context) {
  return {
    window: context.window || null, process: context.process || '', title: context.title || '',
    actionCount: actions.length,
    actionTypes: actions.map((action) => Object.keys(action || {}).find((key) => key !== 'window') || 'unknown').slice(0, 100)
  };
}

module.exports = { RiskPolicy, loadRiskPolicy, DEFAULT_RULES };
