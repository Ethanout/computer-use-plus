'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { AgentAuditStore } = require('./agent-audit');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_reasoning']);

class AgentRuntime {
  constructor(engine, options = {}) {
    if (!engine) throw new Error('agent_engine_required');
    this.engine = engine;
    this.tasks = new Map();
    this.maxTasks = boundedInteger(options.maxTasks, 1, 10000, 256);
    this.taskTtlMs = boundedInteger(options.taskTtlMs, 1000, 7 * 24 * 60 * 60 * 1000, 60 * 60 * 1000);
    this.internalEnabled = options.internalEnabled === true;
    this.allowedWindows = normalizeWindowPolicy(options.allowedWindows || options.windowPolicy || []);
    this.audit = options.audit || new AgentAuditStore(
      engine.dataDir ? path.join(engine.dataDir, 'agent-audit.jsonl') : null,
      { maxBytes: options.auditMaxBytes }
    );
    this.closed = false;
  }

  async run(args = {}) {
    if (this.closed) throw new Error('agent_runtime_closed');
    this.cleanup();
    const goal = String(args.goal || '').trim();
    if (!goal) throw new Error('goal_required');
    if (goal.length > 4000) throw new Error('goal_too_long');
    const budget = normalizeBudget(args.budget, args);
    this.ensureCapacity();
    const task = {
      id: `task_${crypto.randomBytes(9).toString('base64url')}`,
      goal,
      status: 'queued',
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      budget,
      controller: new AbortController(),
      result: null,
      promise: null
    };
    task.request = {
      shortcut_id: args.shortcut_id,
      params: args.params || {},
      stream: args.stream === true,
      confirm_token: args.confirm_token
    };
    task.pauseEachAction = args.pauseBeforeActions === true;
    task.pauseRequested = false;
    task.currentStep = null;
    this.tasks.set(task.id, task);
    this.auditEvent(task, 'task.created');

    const resolution = await this.resolveWindow(args.window, args.windowScope);
    if (!resolution.ok) {
      this.finish(task, 'needs_reasoning', {
        ok: false,
        taskId: task.id,
        needs_reasoning: resolution.reason,
        candidates: resolution.candidates || []
      });
      this.auditEvent(task, 'task.needs_reasoning', { reason: resolution.reason });
      return this.publicTask(task);
    }
    task.window = resolution.window;
    task.windowInfo = resolution.windowInfo;
    if (args.pauseBeforeActions === true) task.pauseRequested = true;
    task.promise = this.execute(task, args);
    if (args.async === true) {
      task.promise.catch(() => {});
      return this.publicTask(task);
    }
    await task.promise;
    return this.publicTask(task);
  }

  status(args = {}) {
    this.cleanup();
    const task = this.tasks.get(String(args.taskId || ''));
    if (!task) return { ok: false, reason: 'task_not_found' };
    return this.publicTask(task, args.includeEvents === true);
  }

  cancel(args = {}) {
    this.cleanup();
    const task = this.tasks.get(String(args.taskId || ''));
    if (!task) return { ok: false, reason: 'task_not_found' };
    if (TERMINAL.has(task.status)) return { ok: true, taskId: task.id, status: task.status, cancelled: false, revision: task.revision };
    if (task.result?.confirmation?.token) {
      this.engine.cancelConfirmation({ confirm_token: task.result.confirmation.token });
    }
    task.controller.abort(new Error('task_cancelled'));
    this.finish(task, 'cancelled', { ok: false, taskId: task.id, reason: 'task_cancelled' });
    this.resolvePause(task, { cancel: true });
    this.auditEvent(task, 'task.cancelled', { op: 'cancel', reason: 'task_cancelled' });
    return { ok: true, taskId: task.id, status: 'cancelled', cancelled: true, revision: task.revision };
  }

  internal(args = {}) {
    if (!this.internalEnabled) throw new Error('agent_internal_disabled');
    const task = this.tasks.get(String(args.taskId || ''));
    if (!task) return { ok: false, reason: 'task_not_found' };
    const op = String(args.op || 'inspect');
    if (op === 'inspect') return this.publicTask(task);
    if (op === 'audit') return { ok: true, taskId: task.id, events: this.audit.query(task.id, args.limit) };
    if (!Number.isInteger(args.revision) || args.revision !== task.revision) {
      return { ok: false, taskId: task.id, reason: 'revision_conflict', revision: task.revision, status: task.status };
    }
    if (op === 'cancel') return this.cancel({ taskId: task.id });
    if (op === 'pause') {
      if (!['queued', 'running'].includes(task.status)) return { ok: false, taskId: task.id, reason: 'task_not_running', status: task.status, revision: task.revision };
      task.pauseRequested = true;
      task.revision += 1;
      task.updatedAt = Date.now();
      this.auditEvent(task, 'task.pause_requested', { op: 'pause' });
      return this.publicTask(task);
    }
    if (op === 'resume' || op === 'replace-action' || op === 'skip-action') {
      if (task.status !== 'paused' || !task.currentStep) return { ok: false, taskId: task.id, reason: 'task_not_paused', status: task.status, revision: task.revision };
      if (op === 'replace-action') {
        const validation = this.validateInterventionAction(task, args.action);
        if (!validation.ok) return { ...validation, taskId: task.id, revision: task.revision };
        this.resolvePause(task, { action: args.action });
        this.auditEvent(task, 'task.action_replaced', { op, actionType: actionType(args.action), candidateHash: hashCandidate(args.action), index: task.currentStep.index, total: task.currentStep.total });
      } else if (op === 'skip-action') {
        this.resolvePause(task, { skip: true });
        this.auditEvent(task, 'task.action_skipped', { op, actionType: task.currentStep.actionType, index: task.currentStep.index, total: task.currentStep.total });
      } else {
        task.pauseEachAction = args.mode === 'step';
        this.resolvePause(task, {});
        this.auditEvent(task, 'task.resumed', { op, index: task.currentStep.index, total: task.currentStep.total });
      }
      return this.publicTask(task);
    }
    if (op === 'select-window') {
      if (task.status !== 'needs_reasoning' || task.result?.needs_reasoning !== 'window_ambiguous') {
        return { ok: false, taskId: task.id, reason: 'task_not_waiting_for_window', revision: task.revision, status: task.status };
      }
      const candidate = task.result.candidates?.find((item) => String(item.id) === String(args.window));
      if (!candidate) return { ok: false, taskId: task.id, reason: 'window_not_in_candidate_set', revision: task.revision };
      task.window = candidate.id;
      task.windowInfo = candidate;
      task.controller = new AbortController();
      task.status = 'queued';
      task.result = null;
      task.revision += 1;
      task.updatedAt = Date.now();
      task.promise = this.execute(task, task.request);
      task.promise.catch(() => {});
      return this.publicTask(task);
    }
    throw new Error('agent_internal_op_invalid');
  }

  capabilities() {
    const fastAi = typeof this.engine.fastAi?.status === 'function' ? this.engine.fastAi.status() : {};
    return {
      ok: true,
      version: 1,
      modes: this.internalEnabled ? ['high-level', 'observable', 'intervention'] : ['high-level'],
      tools: ['agent.run', 'agent.status', 'agent.cancel', 'agent.capabilities'],
      execution: {
        platform: process.platform,
        backgroundOnly: this.engine.executionMode === 'backgroundOnly',
        isolated: Boolean(this.engine.isolated)
      },
      routing: {
        shortcuts: true,
        localClassifier: Boolean(this.engine.actionClassifier),
        fastAiConfigured: fastAi?.configured === true,
        uia: process.platform === 'win32' || this.engine.driver?.constructor?.name === 'MockDriver',
        ocr: Boolean(this.engine.ocr?.available),
<<<<<<< HEAD
        vision: Boolean(this.engine.vision?.available),
        components: typeof this.engine.components?.list === 'function' ? this.engine.components.list().active : {}
      },
      resources: typeof this.engine.resourceRouter?.snapshot === 'function' ? this.engine.resourceRouter.snapshot() : null,
=======
        vision: Boolean(this.engine.vision?.available)
      },
>>>>>>> origin/main
      limits: { maxActions: 100, maxNodes: 50, maxSeconds: 300 },
      internalIntervention: this.internalEnabled,
      ...(this.internalEnabled ? { internalOperations: ['inspect', 'audit', 'pause', 'resume', 'replace-action', 'skip-action', 'cancel', 'select-window'] } : {})
    };
  }

  async execute(task, args) {
    task.status = 'running';
    task.revision += 1;
    task.updatedAt = Date.now();
    const started = Date.now();
    const timer = setTimeout(() => task.controller.abort(new Error('task_timeout')), task.budget.maxSeconds * 1000);
    try {
      const execution = await raceWithSignal(this.engine.fastAct({
        window: task.window,
        goal: task.goal,
        shortcut_id: args.shortcut_id,
        params: args.params || {},
        maxActions: task.budget.maxActions,
        maxNodes: task.budget.maxNodes,
        stream: args.stream === true,
        confirm_token: args.confirm_token,
        signal: task.controller.signal,
        beforeAction: (context) => this.beforeAction(task, context)
      }), task.controller.signal);
      if (task.status === 'cancelled') return;
      const compact = compactExecution(task, execution, Date.now() - started);
      if (execution?.requiresConfirmation || execution?.execution?.requiresConfirmation) {
        this.finish(task, 'waiting_confirmation', compact);
      } else if (execution?.ok) {
        this.finish(task, 'completed', compact);
      } else {
        this.finish(task, execution?.reason ? 'needs_reasoning' : 'failed', compact);
      }
      this.auditEvent(task, `task.${task.status}`, { outcome: execution?.ok ? 'ok' : 'not_ok' });
    } catch (error) {
      if (task.status === 'cancelled') return;
      const reason = error?.code || error?.message || 'agent_run_failed';
      const status = reason === 'task_cancelled' ? 'cancelled' : (reason === 'task_timeout' ? 'failed' : 'needs_reasoning');
      this.finish(task, status, {
        ok: false,
        taskId: task.id,
        reason,
        ...(status === 'needs_reasoning' ? { needs_reasoning: reasoningCode(reason) } : {}),
        elapsedMs: Date.now() - started,
        externalRoundTrips: 1
      });
      this.resolvePause(task, { cancel: true });
      this.auditEvent(task, `task.${status}`, { reason });
    } finally {
      clearTimeout(timer);
    }
  }

  async resolveWindow(explicitWindow, windowScope) {
    const windows = await this.engine.driver.listWindows();
    if (explicitWindow !== undefined && explicitWindow !== null && String(explicitWindow) !== '') {
      const match = windows.find((item) => String(item.id) === String(explicitWindow));
      return match && this.isWindowAllowed(match)
        ? { ok: true, window: String(match.id), windowInfo: match }
        : { ok: false, reason: match ? 'window_not_permitted' : 'window_not_found', candidates: [] };
    }
    let candidates = windows.filter((item) => this.isWindowAllowed(item));
    if (typeof windowScope === 'string' && windowScope.trim()) {
      const needle = windowScope.trim().toLocaleLowerCase();
      candidates = candidates.filter((item) => ['process', 'title', 'className'].some((key) => String(item[key] || '').toLocaleLowerCase().includes(needle)));
    } else if (windowScope && typeof windowScope === 'object') {
      candidates = candidates.filter((item) => ['process', 'title', 'className'].every((key) => {
        const expected = String(windowScope[key] || '').trim().toLocaleLowerCase();
        return !expected || String(item[key] || '').toLocaleLowerCase().includes(expected);
      }));
    }
    if (candidates.length === 1) return { ok: true, window: String(candidates[0].id), windowInfo: candidates[0] };
    return {
      ok: false,
      reason: candidates.length ? 'window_ambiguous' : 'window_not_found',
      candidates: candidates.slice(0, 8).map(compactWindow)
    };
  }

  async beforeAction(task, context) {
    if (task.status === 'cancelled') throw new Error('task_cancelled');
    if (this.internalEnabled || this.allowedWindows.length) {
      const windows = await this.engine.driver.listWindows();
      const current = windows.find((item) => String(item.id) === String(task.window));
      if (!current || !this.isWindowAllowed(current) || !sameWindowApplication(current, task.windowInfo)) {
        throw new Error('window_permission_revoked');
      }
    }
    const shouldPause = task.pauseRequested || task.pauseEachAction;
    if (!shouldPause) return null;
    task.pauseRequested = false;
    task.currentStep = {
      index: context.index,
      total: context.total,
      actionType: actionType(context.action),
      candidateHash: hashCandidate(context.action),
      candidate: summarizeAction(context.action)
    };
    task.status = 'paused';
    task.revision += 1;
    task.updatedAt = Date.now();
    this.auditEvent(task, 'task.paused', {
      index: context.index,
      total: context.total,
      actionType: task.currentStep.actionType,
      candidateHash: task.currentStep.candidateHash
    });
    const decision = await new Promise((resolve, reject) => {
      task.pauseWaiter = { resolve, reject };
      const aborted = () => {
        context.signal?.removeEventListener('abort', aborted);
        reject(context.signal.reason || new Error('task_cancelled'));
      };
      context.signal?.addEventListener('abort', aborted, { once: true });
      task.pauseWaiter.aborted = aborted;
      if (context.signal?.aborted) aborted();
    });
    task.pauseWaiter = null;
    task.currentStep = null;
    if (task.status !== 'cancelled') {
      task.status = 'running';
      task.revision += 1;
      task.updatedAt = Date.now();
    }
    if (decision?.cancel) throw new Error('task_cancelled');
    return decision;
  }

  resolvePause(task, decision) {
    const waiter = task.pauseWaiter;
    if (!waiter) return false;
    task.pauseWaiter = null;
    waiter.aborted && task.controller.signal.removeEventListener('abort', waiter.aborted);
    waiter.resolve(decision || {});
    return true;
  }

  validateInterventionAction(task, action) {
    try { this.engine.validateActionBatch([action]); }
    catch (error) { return { ok: false, reason: error.message }; }
    if (!task.currentStep || actionType(action) !== task.currentStep.actionType) {
      return { ok: false, reason: 'intervention_action_type_mismatch' };
    }
    const context = {
      window: task.window,
      process: task.windowInfo?.process || '',
      title: task.windowInfo?.title || ''
    };
    const risk = this.engine.riskPolicy?.evaluate?.([action], context);
    if (risk?.decision === 'deny') return { ok: false, reason: 'intervention_risk_denied' };
    if (risk?.decision === 'confirm') return { ok: false, reason: 'intervention_requires_confirmation', risks: risk.risks, summary: risk.summary };
    return { ok: true };
  }

  isWindowAllowed(window) {
    if (!this.allowedWindows.length) return true;
    return this.allowedWindows.some((rule) => ['process', 'title', 'className'].every((key) => {
      const expected = rule[key];
      return !expected || String(window?.[key] || '').toLocaleLowerCase().includes(expected);
    }));
  }

  auditEvent(task, event, extra = {}) {
    this.audit.append({ taskId: task.id, event, status: task.status, revision: task.revision, window: task.window, process: task.windowInfo?.process, className: task.windowInfo?.className, ...extra });
  }

  finish(task, status, result) {
    if (task.status === 'cancelled' && status !== 'cancelled') return;
    task.status = status;
    task.result = result;
    task.updatedAt = Date.now();
    task.revision += 1;
  }

  publicTask(task) {
    const result = task.result ? { ...task.result, status: task.status, revision: task.revision } : {
      ok: true,
      taskId: task.id,
      status: task.status,
      revision: task.revision,
      window: task.window || null
    };
    if (task.status === 'paused' && task.currentStep) result.currentStep = task.currentStep;
    return result;
  }

  cleanup(now = Date.now()) {
    for (const [id, task] of this.tasks) {
      if ((TERMINAL.has(task.status) || task.status === 'waiting_confirmation') && now - task.updatedAt > this.taskTtlMs) {
        if (task.result?.confirmation?.token) this.engine.cancelConfirmation({ confirm_token: task.result.confirmation.token });
        this.tasks.delete(id);
      }
    }
  }

  ensureCapacity() {
    if (this.tasks.size < this.maxTasks) return;
    const removable = [...this.tasks.values()].filter((task) => TERMINAL.has(task.status) || task.status === 'waiting_confirmation').sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.tasks.size >= this.maxTasks && removable.length) this.tasks.delete(removable.shift().id);
    if (this.tasks.size >= this.maxTasks) throw new Error('agent_task_capacity_exceeded');
  }

  async close() {
    this.closed = true;
    const promises = [];
    for (const task of this.tasks.values()) {
      if (!TERMINAL.has(task.status)) {
        if (task.result?.confirmation?.token) this.engine.cancelConfirmation({ confirm_token: task.result.confirmation.token });
        task.controller.abort(new Error('task_cancelled'));
        this.finish(task, 'cancelled', { ok: false, taskId: task.id, reason: 'task_cancelled' });
      }
      if (task.promise) promises.push(task.promise);
    }
    await Promise.allSettled(promises);
  }
}

function normalizeBudget(value = {}, args = {}) {
  const budget = value && typeof value === 'object' ? value : {};
  return {
    maxSeconds: boundedNumber(budget.maxSeconds ?? args.maxSeconds, 0.05, 300, 30),
    maxActions: boundedInteger(budget.maxActions ?? args.maxActions, 1, 100, 20),
    maxNodes: boundedInteger(budget.maxNodes ?? args.maxNodes, 1, 50, 30)
  };
}

function boundedNumber(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error('agent_budget_invalid');
  return number;
}

function boundedInteger(value, min, max, fallback) {
  const number = boundedNumber(value, min, max, fallback);
  if (!Number.isInteger(number)) throw new Error('agent_budget_invalid');
  return number;
}

function compactWindow(window) {
  return {
    id: String(window.id),
    process: window.process || '',
    title: window.title || '',
    className: window.className || ''
  };
}

function normalizeWindowPolicy(value) {
  if (!Array.isArray(value)) return [];
  return value.map((rule) => {
    if (typeof rule === 'string') return { process: rule.trim().toLocaleLowerCase() };
    if (!rule || typeof rule !== 'object') throw new Error('agent_window_policy_invalid');
    const normalized = {};
    for (const key of ['process', 'title', 'className']) {
      if (rule[key] !== undefined && rule[key] !== null && String(rule[key]).trim()) normalized[key] = String(rule[key]).trim().toLocaleLowerCase();
    }
    if (!Object.keys(normalized).length) throw new Error('agent_window_policy_invalid');
    return normalized;
  });
}

function sameWindowApplication(a, b) {
  if (!a || !b) return false;
  const processA = String(a.process || '').toLocaleLowerCase();
  const processB = String(b.process || '').toLocaleLowerCase();
  const classA = String(a.className || '').toLocaleLowerCase();
  const classB = String(b.className || '').toLocaleLowerCase();
  return Boolean(processA && processB && processA === processB && (!classA || !classB || classA === classB));
}

function actionType(action) {
  if (!action || typeof action !== 'object') return 'unknown';
  for (const key of ['click', 'setValue', 'hotkey', 'keys', 'kbseq', 'kbops', 'wait']) {
    if (Object.prototype.hasOwnProperty.call(action, key)) return key;
  }
  return 'unknown';
}

function summarizeAction(action) {
  if (!action || typeof action !== 'object') return { type: 'unknown' };
  const type = actionType(action);
  const summary = { type };
  const payload = action[type];
  if (type === 'click' && payload && typeof payload === 'object') {
    if (payload.ref) summary.ref = String(payload.ref);
    if (payload.text) summary.text = String(payload.text).slice(0, 120);
    if (payload.role) summary.role = String(payload.role);
    if (payload.x !== undefined && payload.y !== undefined) summary.position = { x: Number(payload.x), y: Number(payload.y) };
  }
  if (type === 'setValue' && payload && typeof payload === 'object') {
    if (payload.ref) summary.ref = String(payload.ref);
    if (payload.role) summary.role = String(payload.role);
  }
  if (Array.isArray(action.hotkey)) summary.keys = { count: action.hotkey.length };
  if (Array.isArray(action.keys)) summary.keys = { count: action.keys.length };
  if (Array.isArray(action.kbseq)) summary.keys = { count: action.kbseq.length };
  if (Array.isArray(action.kbops)) summary.keys = { count: action.kbops.length };
  if (type === 'wait' && payload && typeof payload === 'object' && payload.seconds !== undefined) summary.seconds = Number(payload.seconds);
  return summary;
}

function hashCandidate(action) {
  return crypto.createHash('sha256').update(JSON.stringify(summarizeAction(action))).digest('hex').slice(0, 16);
}

function compactExecution(task, value, elapsedMs) {
  const gate = value?.requiresConfirmation ? value : value?.execution?.requiresConfirmation ? value.execution : null;
  const actionResults = findActionResults(value);
  const strategies = [...new Set(actionResults.map((item) => item?.strategy).filter(Boolean))];
  return {
    ok: Boolean(value?.ok),
    taskId: task.id,
    goal: task.goal,
    window: task.window,
    verified: Boolean(value?.ok && !gate),
    source: value?.source || (value?.shortcut ? 'local-shortcut' : 'runtime'),
    ...(strategies.length ? { strategy: strategies.join('+') } : {}),
    elapsedMs,
    externalRoundTrips: 1,
    modelCalls: String(value?.source || '').startsWith('fast-ai') ? 1 : 0,
    actions: actionResults.length,
    ...(value?.shortcut ? { shortcut: value.shortcut } : {}),
    ...(value?.reason ? { reason: value.reason, needs_reasoning: reasoningCode(value.reason) } : {}),
    ...(gate ? { requiresConfirmation: true, confirmation: gate.confirmation } : {})
  };
}

function findActionResults(value) {
  const seen = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return [];
    seen.add(node);
    if (Array.isArray(node.actions) && node.actions.every((item) => item && typeof item === 'object' && ('ok' in item || 'strategy' in item))) return node.actions;
    for (const key of ['execution', 'result']) {
      const found = visit(node[key]);
      if (found.length) return found;
    }
    return [];
  }
  return visit(value);
}

function reasoningCode(reason) {
  if (['shortcut_not_found', 'tool_call_provider_not_configured', 'fast_ai_not_configured'].includes(reason)) return 'planner_unavailable';
  if (reason === 'task_action_budget_exceeded') return 'action_budget_exceeded';
  return reason;
}

function raceWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('task_cancelled'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new Error('task_cancelled'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { signal.removeEventListener('abort', aborted); reject(error); }
    );
  });
}

module.exports = { AgentRuntime, normalizeBudget, compactExecution };
