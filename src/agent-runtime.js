'use strict';

const crypto = require('node:crypto');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_reasoning']);

class AgentRuntime {
  constructor(engine, options = {}) {
    if (!engine) throw new Error('agent_engine_required');
    this.engine = engine;
    this.tasks = new Map();
    this.maxTasks = boundedInteger(options.maxTasks, 1, 10000, 256);
    this.taskTtlMs = boundedInteger(options.taskTtlMs, 1000, 7 * 24 * 60 * 60 * 1000, 60 * 60 * 1000);
    this.internalEnabled = options.internalEnabled === true;
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
    this.tasks.set(task.id, task);

    const resolution = await this.resolveWindow(args.window, args.windowScope);
    if (!resolution.ok) {
      this.finish(task, 'needs_reasoning', {
        ok: false,
        taskId: task.id,
        needs_reasoning: resolution.reason,
        candidates: resolution.candidates || []
      });
      return this.publicTask(task);
    }
    task.window = resolution.window;
    task.windowInfo = resolution.windowInfo;
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
    return { ok: true, taskId: task.id, status: 'cancelled', cancelled: true, revision: task.revision };
  }

  internal(args = {}) {
    if (!this.internalEnabled) throw new Error('agent_internal_disabled');
    const task = this.tasks.get(String(args.taskId || ''));
    if (!task) return { ok: false, reason: 'task_not_found' };
    const op = String(args.op || 'inspect');
    if (op === 'inspect') return this.publicTask(task);
    if (!Number.isInteger(args.revision) || args.revision !== task.revision) {
      return { ok: false, taskId: task.id, reason: 'revision_conflict', revision: task.revision, status: task.status };
    }
    if (op === 'cancel') return this.cancel({ taskId: task.id });
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
        vision: Boolean(this.engine.vision?.available)
      },
      limits: { maxActions: 100, maxNodes: 50, maxSeconds: 300 },
      internalIntervention: this.internalEnabled
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
        signal: task.controller.signal
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
    } finally {
      clearTimeout(timer);
    }
  }

  async resolveWindow(explicitWindow, windowScope) {
    const windows = await this.engine.driver.listWindows();
    if (explicitWindow !== undefined && explicitWindow !== null && String(explicitWindow) !== '') {
      const match = windows.find((item) => String(item.id) === String(explicitWindow));
      return match
        ? { ok: true, window: String(match.id), windowInfo: match }
        : { ok: false, reason: 'window_not_found', candidates: [] };
    }
    let candidates = windows;
    if (typeof windowScope === 'string' && windowScope.trim()) {
      const needle = windowScope.trim().toLocaleLowerCase();
      candidates = windows.filter((item) => ['process', 'title', 'className'].some((key) => String(item[key] || '').toLocaleLowerCase().includes(needle)));
    } else if (windowScope && typeof windowScope === 'object') {
      candidates = windows.filter((item) => ['process', 'title', 'className'].every((key) => {
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

  finish(task, status, result) {
    if (task.status === 'cancelled' && status !== 'cancelled') return;
    task.status = status;
    task.result = result;
    task.updatedAt = Date.now();
    task.revision += 1;
  }

  publicTask(task) {
    if (task.result) return { ...task.result, status: task.status, revision: task.revision };
    return {
      ok: true,
      taskId: task.id,
      status: task.status,
      revision: task.revision,
      window: task.window || null
    };
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
