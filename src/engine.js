'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { rankElements } = require('./matcher');
const { MemoryStore } = require('./memory');
const { PowerShellDriver } = require('./drivers/powershell');
const { MockDriver } = require('./drivers/mock');
const { OcrDriver } = require('./drivers/ocr');
const { ExecutionDesktopManager, ExecutionDesktopDriver } = require('./drivers/execution');
const { FastAiClient } = require('./fast-ai');
const { StructuredVisionClient } = require('./vision');
const { CdpDriver, BrowserCdpLauncher } = require('./drivers/cdp');
const { normalizeToolCall, actionIdToShortcut } = require('./tool-call');
const { resolveShortcutWithClassifier } = require('./action-router');
const { loadRiskPolicy } = require('./risk-policy');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function ensureDataDir(dataDir) { fs.mkdirSync(dataDir, { recursive: true }); }

const ACTIONABLE_ROLES = new Set([
  'button', 'edit', 'textbox', 'checkbox', 'radio', 'hyperlink', 'link',
  'menuitem', 'tab', 'combobox', 'listitem', 'slider', 'spinner', 'treeitem'
]);

class ComputerEngine {
  constructor(options = {}) {
    const dataDir = options.dataDir || process.env.COMPUTER_USE_PLUS_DATA_DIR || path.resolve('.data');
    ensureDataDir(dataDir);
    this.dataDir = path.resolve(dataDir);
    this.execution = options.execution || new ExecutionDesktopManager({ dataDir });
    this.executionMode = options.executionMode || process.env.COMPUTER_USE_PLUS_EXECUTION_MODE || 'backgroundOnly';
    this.driver = options.driver || (process.env.CUP_MOCK === '1'
      ? new MockDriver()
      : (process.platform === 'win32' && this.executionMode === 'backgroundOnly'
          ? new ExecutionDesktopDriver(this.execution)
          : new PowerShellDriver()));
    this.isolated = this.driver instanceof ExecutionDesktopDriver;
    this.ocr = options.ocr || new OcrDriver();
    this.memory = options.memory || new MemoryStore(path.join(dataDir, 'ui-memory.json'));
    this.fastAi = options.fastAi || new FastAiClient();
    this.actionClassifier = options.actionClassifier || null;
    this.actionClassifierThreshold = Number(options.actionClassifierThreshold || process.env.COMPUTER_USE_PLUS_ACTION_CLASSIFIER_THRESHOLD || 0.85);
    this.vision = options.vision || new StructuredVisionClient();
    this.browserLauncher = options.browserLauncher || null;
    this.browserDriver = options.browserDriver || null;
    this.snapshotRefs = new Map();
    this.pendingConfirmations = new Map();
    this.riskPolicy = options.riskPolicy || loadRiskPolicy(options.riskPolicyFile || process.env.COMPUTER_USE_PLUS_RISK_POLICY_FILE, { mode: process.env.COMPUTER_USE_PLUS_RISK_MODE || 'high-risk' });
    this.verifyRoots = [this.dataDir, ...String(options.verifyRoots || process.env.COMPUTER_USE_PLUS_VERIFY_ROOTS || '').split(path.delimiter).filter(Boolean).map((item) => path.resolve(item))];
    this.snapshotSequence = 0;
    this.metrics = {
      actions: 0, successes: 0, failures: 0, strategy: {},
      screenshots: 0, screenshotBytes: 0, ocrCalls: 0, ocrLatencyMs: 0,
      modelCalls: 0, modelInputTokens: 0, modelOutputTokens: 0,
      classifierCalls: 0, classifierHits: 0, classifierLatencyMs: 0,
      toolCalls: 0, shortcutHits: 0, confirmationRequests: 0,
      startedAt: Date.now()
    };
    if (typeof this.memory.maintenance === 'function') {
      this.maintenanceTimer = setInterval(() => this.memory.maintenance(), 60 * 60 * 1000);
      this.maintenanceTimer.unref?.();
    }
  }

  async state(args = {}) {
    const windows = await this.driver.listWindows();
    const focused = windows.find((item) => item.isForeground)?.id || null;
    const response = {
      windows: windows.map((item) => [item.id, item.process || '', item.title || '']),
      windowDetails: windows,
      focused,
      modal: null,
      capabilities: {
        uia: process.platform === 'win32' || this.driver instanceof MockDriver,
        ocr: this.ocr.available,
        screenshot: this.isolated,
        vision: this.vision.available,
        visionProvider: this.vision.status(),
        fastAi: this.fastAi.status(),
      },
      memory: this.memory.stats(),
      execution: this.execution.status(),
      metrics: { ...this.metrics, uptimeMs: Date.now() - this.metrics.startedAt }
    };
    if (args.includeUi) response.snapshot = await this.buildSnapshot(windows, focused, args);
    return response;
  }

  async buildSnapshot(windows, focused, args = {}) {
    const scope = args.scope === 'all' ? 'all' : 'focused';
    const maxNodes = Math.max(1, Math.min(Number(args.maxNodes) || 30, 50));
    let selected;
    if (args.window) selected = windows.filter((item) => String(item.id) === String(args.window));
    else if (scope === 'all') selected = windows.slice(0, 20);
    else selected = windows.filter((item) => String(item.id) === String(focused)).slice(0, 1);
    if (!selected.length && !args.window && windows.length) selected = windows.slice(0, 1);
    if (args.window && !selected.length) throw new Error('window_not_found');

    this.snapshotRefs.clear();
    const snapshotId = ++this.snapshotSequence;
    let refNumber = 0;
    const snapshots = [];
    for (const window of selected) {
      const windowKey = `${String(window.process || '').toLocaleLowerCase()}|${String(window.className || '').toLocaleLowerCase()}`;
      const predicted = args.predict !== false && args.actionSignature && typeof this.memory.predict === 'function'
        ? this.memory.predict(windowKey, args.actionSignature, { environment: this.environmentForWindow(window) })
        : null;
      const raw = predicted?.snapshot?.nodes?.map((node) => ({
        name: node.name || node.text || '', role: node.role, automationId: node.automationId,
        bounds: node.bounds, enabled: node.enabled, offscreen: node.offscreen
      })) || await this.driver.inspect(window.id, { limit: maxNodes, includeOffscreen: false });
      const nodes = raw.slice(0, maxNodes).map((element) => {
        const compact = this.compactSnapshotElement(element);
        if (compact.interactive) {
          const ref = `s${snapshotId}n${++refNumber}`;
          compact.ref = ref;
          this.snapshotRefs.set(ref, {
            windowId: String(window.id),
            query: this.queryFromElement(element)
          });
        }
        return compact;
      });
      const nodeFingerprint = this.fingerprintElements(raw);
      snapshots.push({
        window: String(window.id),
        title: window.title || '',
        process: window.process || '',
        className: window.className || '',
        bounds: window.bounds || null,
        focused: String(window.id) === String(focused),
        fingerprint: nodeFingerprint,
        nodes,
        truncated: raw.length >= maxNodes,
        ...(predicted ? { prediction: { source: predicted.source, confidence: predicted.confidence, uses: predicted.uses, verified: false } } : {})
      });
      if (args.includeTransitions !== false && typeof this.memory.recentTransitions === 'function') {
        snapshots[snapshots.length - 1].transitions = this.memory.recentTransitions(windowKey, 8);
      }
    }
    return { version: 1, scope, maxNodes, windows: snapshots };
  }

  compactSnapshotElement(element) {
    const compact = this.compactElement(element);
    const role = String(compact.role || '').toLocaleLowerCase();
    return {
      ...compact,
      ...(typeof element.enabled === 'boolean' ? { enabled: element.enabled } : {}),
      ...(typeof element.offscreen === 'boolean' ? { offscreen: element.offscreen } : {}),
      interactive: ACTIONABLE_ROLES.has(role) || role.includes('button') || role.includes('edit') || role.includes('menuitem')
    };
  }

  queryFromElement(element) {
    return {
      ...(element.name ? { text: element.name } : {}),
      ...(element.role ? { role: element.role } : {}),
      ...(element.automationId ? { automationId: element.automationId } : {}),
      ...(element.className ? { className: element.className } : {})
    };
  }

  fingerprintElements(elements) {
    const nodes = (elements || []).map((element) => [element.name || '', element.role || '', element.automationId || ''].join('|')).sort();
    return crypto.createHash('sha1').update(nodes.join('\n')).digest('hex').slice(0, 16);
  }

  resolveActionRefs(windowId, action) {
    const source = action && typeof action === 'object' ? action : null;
    if (!source) return source;
    for (const key of ['click', 'setValue']) {
      if (!source[key] || typeof source[key] !== 'object' || !source[key].ref) continue;
      const ref = this.snapshotRefs.get(String(source[key].ref));
      if (!ref || String(ref.windowId) !== String(windowId)) throw new Error('snapshot_ref_invalid');
      const payload = { ...source[key] };
      delete payload.ref;
      return { ...source, [key]: { ...ref.query, ...payload } };
    }
    return source;
  }

  templateWorkflow(value, params = {}) {
    if (Array.isArray(value)) return value.map((item) => this.templateWorkflow(item, params));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.templateWorkflow(item, params)]));
    }
    for (const [key, parameter] of Object.entries(params)) {
      if (parameter !== '' && parameter !== null && parameter !== undefined && value === parameter) return `{{${key}}}`;
    }
    return value;
  }

  async inspect(args = {}) {
    if (!args.window) return { windows: await this.driver.listWindows() };
    const query = args.query || {};
    let elements = [];
    let strategy = 'uia';
    if (args.mode === 'vision') {
      elements = await this.inspectVision(args.window, query);
      return { window: args.window, strategy: 'vision.structured', count: elements.length, elements: elements.map(this.compactElement) };
    }
    if (args.mode !== 'ocr') elements = await this.driver.inspect(args.window, query);
    if ((args.mode === 'ocr' || !elements?.length) && this.ocr.available) {
      const ocrStarted = Date.now();
      elements = await this.inspectOcr(args.window, query);
      strategy = 'ocr';
      this.metrics.ocrCalls += 1;
      this.metrics.ocrLatencyMs += Date.now() - ocrStarted;
    }
    const ranked = rankElements(elements || [], query);
    return { window: args.window, strategy, count: ranked.length, elements: ranked.map(this.compactElement) };
  }

  async inspectVision(windowId, query = {}) {
    if (!this.vision.available || !this.isolated || typeof this.driver.capture !== 'function') throw new Error('vision_requires_configured_isolated_driver');
    const windows = await this.driver.listWindows();
    const window = windows.find((item) => String(item.id) === String(windowId));
    if (!window) throw new Error('window_not_found');
    const capture = await this.driver.capture(windowId);
    const imagePath = path.resolve(capture.path);
    try {
      const root = path.resolve(this.execution.dataDir || '.data');
      if (!imagePath.startsWith(`${root}${path.sep}`)) throw new Error('execution_capture_path_invalid');
      const layout = await this.vision.inspectImage(imagePath, capture.bounds || window.bounds, { query });
      return layout.windows.flatMap((item) => item.nodes || [])
        .filter((node) => !query.text || String(node.text || '').toLocaleLowerCase().includes(String(query.text).toLocaleLowerCase()))
        .map((node) => ({ name: node.text || '', text: node.text || '', role: node.role, bounds: node.bounds, confidence: node.confidence, source: 'vision' }));
    } finally { try { fs.unlinkSync(imagePath); } catch (_) { } }
  }

  async waitForTarget(args = {}) {
    const timeoutMs = Math.max(0, Math.min(Number(args.timeoutMs ?? args.timeout ?? 10000), 60000));
    const pollMs = Math.max(50, Math.min(Number(args.pollMs ?? 100), 2000));
    const until = args.until === 'absent' ? 'absent' : 'present';
    const query = args.query && typeof args.query === 'object' ? args.query : {};
    const windowQuery = args.windowQuery && typeof args.windowQuery === 'object' ? args.windowQuery : {};
    const started = Date.now();
    const matchesWindow = (window) => Object.entries(windowQuery).every(([key, expected]) => {
      if (expected === undefined || expected === null || expected === '') return true;
      const actual = String(window?.[key] ?? '');
      if (['title', 'process', 'className'].includes(key)) return actual.toLocaleLowerCase().includes(String(expected).toLocaleLowerCase());
      return actual === String(expected);
    });
    while (Date.now() - started <= timeoutMs) {
      let windows = await this.driver.listWindows();
      windows = args.window
        ? windows.filter((window) => String(window.id) === String(args.window))
        : windows.filter(matchesWindow);
      const found = [];
      for (const window of windows) {
        if (!Object.keys(query).length) { found.push({ window, elements: [] }); continue; }
        try {
          const elements = await this.driver.inspect(window.id, query);
          if (elements?.length) found.push({ window, elements });
        } catch (_) { }
      }
      const satisfied = until === 'present' ? found.length > 0 : found.length === 0;
      if (satisfied) {
        return {
          ok: true,
          until,
          strategy: 'poll',
          elapsedMs: Date.now() - started,
          windows: found.map((item) => ({ ...item.window, elements: item.elements.map(this.compactElement) }))
        };
      }
      await sleep(Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - started))));
    }
    return { ok: false, until, reason: 'wait_timeout', elapsedMs: Date.now() - started, query, windowQuery };
  }

  async screenshot(args = {}) {
    if (!this.isolated || typeof this.driver.capture !== 'function') throw new Error('isolated_screenshot_requires_execution_desktop');
    const windows = await this.driver.listWindows();
    const selected = args.window
      ? windows.filter((item) => String(item.id) === String(args.window))
      : windows.filter((item) => item.bounds && item.title).slice(0, 20);
    if (!selected.length) throw new Error('window_not_found');
    const includeImage = args.mode === 'image';
    const screens = [];
    for (const window of selected) {
      const capture = await this.driver.capture(window.id);
      const item = { window: String(window.id), title: window.title || '', bounds: capture.bounds || window.bounds };
      const imagePath = path.resolve(capture.path);
      const root = path.resolve(this.execution.dataDir || '.data');
      try {
        if (!imagePath.startsWith(`${root}${path.sep}`)) throw new Error('execution_capture_path_invalid');
        if (includeImage) item.imageBase64 = fs.readFileSync(imagePath).toString('base64');
        else item.capture = 'available_on_demand';
      } finally {
        try { fs.unlinkSync(imagePath); } catch (_) { }
      }
      screens.push(item);
      this.metrics.screenshots += 1;
      this.metrics.screenshotBytes += includeImage ? Buffer.byteLength(item.imageBase64, 'base64') : 0;
    }
    return { mode: includeImage ? 'image' : 'metadata', count: screens.length, screens };
  }

  async manageExecution(args = {}) {
    if (args.action === 'status') return this.execution.status();
    if (args.action === 'create') {
      const created = await this.execution.create();
      let agent;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { agent = await this.execution.ping(1000); break; }
        catch (_) { await sleep(150); }
      }
      if (!agent?.ok) throw new Error('execution_agent_not_ready');
      return { ok: true, ...created, agent };
    }
    if (args.action === 'launch') {
      if (!args.commandLine) throw new Error('command_line_required');
      return this.execution.launch(args.commandLine);
    }
    if (args.action === 'diagnose') return this.execution.diagnose();
    if (args.action === 'destroy') return this.execution.destroy();
    throw new Error('invalid_execution_action');
  }

  async manageBrowser(args = {}) {
    if (args.action === 'status') return { configured: Boolean(this.browserDriver), launcher: this.browserLauncher ? { pid: this.browserLauncher.child?.pid || null, port: this.browserLauncher.port, profileDir: this.browserLauncher.profileDir } : null };
    if (args.action === 'launch') {
      if (process.platform === 'win32' && !this.isolated) throw new Error('browser_requires_isolated_execution');
      if (!this.browserLauncher) {
        const root = path.resolve(this.execution.dataDir || path.resolve('.data'));
        const profileDir = path.resolve(args.profileDir || path.join(root, 'browser-profile'));
        if (!profileDir.startsWith(`${root}${path.sep}`)) throw new Error('browser_profile_must_be_project_data');
        this.browserLauncher = new BrowserCdpLauncher({ executable: args.executable, profileDir, port: args.port || 9222, execution: this.isolated ? this.execution : null });
      }
      const launched = await this.browserLauncher.launch(args.url || 'about:blank');
      this.browserDriver = this.browserDriver || new CdpDriver({ endpoint: `http://127.0.0.1:${this.browserLauncher.port}`, dataDir: this.execution.dataDir || path.resolve('.data') });
      let windows = [];
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try { windows = await this.browserDriver.listWindows(); if (windows.length) break; } catch (_) { }
        await sleep(200);
      }
      if (!windows.length) throw new Error('browser_cdp_not_ready');
      const readiness = await this.browserDriver.waitForReady(windows[0].id, args.readyTimeoutMs || 10000);
      if (!readiness.ok) throw new Error('browser_page_not_ready');
      return { ok: true, ...launched, windows, readiness };
    }
    if (!this.browserDriver) throw new Error('browser_not_started');
    if (args.action === 'list') return { windows: await this.browserDriver.listWindows() };
    const browserWindow = args.window || await this.resolveBrowserWindow();
    if (args.action === 'inspect') return { window: browserWindow, strategy: 'cdp.accessibility-dom', elements: (await this.browserDriver.inspect(browserWindow, args.query || {})).map(this.compactElement) };
    if (args.action === 'click') return this.browserDriver.click(browserWindow, args.query || {});
    if (args.action === 'setValue') return this.browserDriver.setValue(browserWindow, args.query || {}, args.value || '');
    if (args.action === 'keys') return this.browserDriver.sendKeys(browserWindow, args.keys || []);
    if (args.action === 'stop') { this.browserLauncher?.stop(); this.browserDriver = null; return { ok: true }; }
    throw new Error('invalid_browser_action');
  }

  async resolveBrowserWindow() {
    const windows = await this.browserDriver.listWindows();
    if (windows.length !== 1) throw new Error('browser_window_required');
    return windows[0].id;
  }

  async fastAct(args = {}) {
    if (!args.window || !args.goal) throw new Error('window_and_goal_required');
    const localWindowKey = await this.getWindowKey(args.window);
    const routed = await resolveShortcutWithClassifier(this.memory, localWindowKey, args.goal, {
      explicitId: args.shortcut_id,
      classifier: this.actionClassifier,
      threshold: this.actionClassifierThreshold
    });
    if (routed.source.startsWith('classifier')) {
      this.metrics.classifierCalls += 1;
      this.metrics.classifierLatencyMs += Number(routed.latencyMs || 0);
      if (routed.shortcut) this.metrics.classifierHits += 1;
    }
    const localShortcut = routed.shortcut;
    if (localShortcut) {
      const execution = await this.invokeGuarded({ type: 'shortcut', window: args.window, name: localShortcut.name, params: args.params || {} });
      return { ok: execution.ok, source: routed.source === 'classifier' ? 'local-classifier' : 'local-shortcut', shortcut: localShortcut.name, execution, ...(routed.confidence ? { confidence: routed.confidence } : {}) };
    }
    const snapshot = args.snapshot || await this.state({ window: args.window, includeUi: true, maxNodes: args.maxNodes || 30, includeTransitions: true }).then((state) => state.snapshot);
    const params = args.params && typeof args.params === 'object' ? args.params : {};
    if (args.stream === true && typeof this.fastAi.planToolCallStream === 'function') {
      let earlyExecutionPromise = null;
      const startedAt = Date.now();
      let streamDispatchLatencyMs = null;
      try {
        const call = await this.fastAi.planToolCallStream({
          goal: args.goal,
          window: args.window,
          snapshot,
          params,
          maxActions: args.maxActions || 20,
          onToolCall: async (toolCall) => {
            if (earlyExecutionPromise) return earlyExecutionPromise;
            streamDispatchLatencyMs = Date.now() - startedAt;
            earlyExecutionPromise = this.invokeToolCall(toolCall, { defaultWindow: args.window, params });
            return earlyExecutionPromise;
          }
        });
        this.recordModelUsage(call.usage);
        if (earlyExecutionPromise) {
          const earlyExecution = await earlyExecutionPromise;
          return {
            ok: earlyExecution.ok,
            source: 'fast-ai-tool-call-stream',
            model: call.model,
            toolCall: { name: call.name },
            execution: earlyExecution,
            streamDispatchLatencyMs,
            ...(call.usage ? { usage: call.usage } : {})
          };
        }
        const execution = await this.invokeToolCall(call, { defaultWindow: args.window, params });
        return { ok: execution.ok, source: 'fast-ai-tool-call-stream-fallback', model: call.model, toolCall: { name: call.name }, execution, ...(call.usage ? { usage: call.usage } : {}) };
      } catch (error) {
        if (!['tool_call_not_returned', 'tool_call_missing', 'tool_call_provider_not_configured'].includes(error.message)) throw error;
      }
    }
    if (typeof this.fastAi.planToolCall === 'function') {
      try {
        const call = await this.fastAi.planToolCall({ goal: args.goal, window: args.window, snapshot, params, maxActions: args.maxActions || 20 });
        this.recordModelUsage(call.usage);
        const execution = await this.invokeToolCall(call, { defaultWindow: args.window, params });
        return { ok: execution.ok, source: 'fast-ai-tool-call', model: call.model, toolCall: { name: call.name }, execution, ...(call.usage ? { usage: call.usage } : {}) };
      } catch (error) {
        if (!['tool_call_not_returned', 'tool_call_missing', 'tool_call_provider_not_configured'].includes(error.message)) throw error;
      }
    }
    const plan = await this.fastAi.plan({ goal: args.goal, snapshot, params, maxActions: args.maxActions || 20 });
    this.recordModelUsage(plan.usage);
    if (!plan.actions.length) return { ok: false, reason: 'fast_ai_no_safe_actions', model: plan.model, ...(plan.usage ? { usage: plan.usage } : {}) };
    const templatedActions = plan.actions.map((action) => this.resolveActionRefs(args.window, action));
    const execution = await this.act({ window: args.window, actions: MemoryStore.interpolate(templatedActions, params) });
    return { ok: execution.ok, source: 'fast-ai', model: plan.model, plannedActions: templatedActions, execution, ...(plan.usage ? { usage: plan.usage } : {}) };
  }

  recordModelUsage(usage = null) {
    this.metrics.modelCalls += 1;
    this.metrics.modelInputTokens += Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
    this.metrics.modelOutputTokens += Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  }

  async invokeToolCall(input, context = {}) {
    const call = normalizeToolCall(input);
    this.metrics.toolCalls += 1;
    const args = { ...call.arguments };
    if (!args.window && context.defaultWindow) args.window = String(context.defaultWindow);
    if (context.params && args.params) args.params = { ...context.params, ...args.params };
    if (call.name === 'computer.state') return this.state(args);
    if (call.name === 'computer.inspect') return this.inspect(args);
    if (call.name === 'computer.verify') return this.verify(args);
    if (call.name === 'computer.cancel') return this.cancelConfirmation(args);
    if (call.name === 'shortcut.run') {
      const name = actionIdToShortcut(args.shortcut_id || args.name);
      if (!name) throw new Error('shortcut_id_required');
      return this.invokeGuarded({ type: 'shortcut', window: args.window, name, params: args.params || {} }, args.confirm_token);
    }
    if (call.name === 'computer.invoke') {
      if (args.shortcut_id) {
        return this.invokeGuarded({ type: 'shortcut', window: args.window, name: actionIdToShortcut(args.shortcut_id), params: args.params || {} }, args.confirm_token);
      }
      return this.invokeGuarded({ type: 'actions', window: args.window, actions: args.actions || [] }, args.confirm_token);
    }
    throw new Error('tool_call_unknown_tool');
  }

  async invokeGuarded(operation, confirmationToken = '') {
    if (!operation.window) throw new Error('window_required');
    let actions = operation.actions;
    if (operation.type === 'shortcut') {
      const scope = await this.resolveWorkflowScope({ window: operation.window }, []);
      const workflow = this.memory.getWorkflow(operation.name, scope.scopeKey);
      if (!workflow) throw new Error('shortcut_not_found');
      actions = MemoryStore.interpolate(workflow.actions, { ...(workflow.parameters || {}), ...(operation.params || {}) });
    }
    if (!Array.isArray(actions) || !actions.length) throw new Error('actions_required');
    this.validateActionBatch(actions);
    const guardedOperation = { ...operation, actions };
    const gate = await this.guardActions(guardedOperation, actions, confirmationToken, [operation.window]);
    if (gate) return gate;
    const execution = await this.act({ window: operation.window, actions });
    if (operation.type === 'shortcut') this.metrics.shortcutHits += 1;
    return { ok: execution.ok, ...(operation.type === 'shortcut' ? { shortcut: operation.name } : {}), execution };
  }

  async guardActions(operation, actions, confirmationToken = '', windowIds = []) {
    const windows = await this.driver.listWindows();
    const selected = windowIds.map((id) => windows.find((item) => String(item.id) === String(id))).filter(Boolean);
    const context = {
      window: windowIds.map(String).join('>'),
      process: selected.map((item) => item.process || '').filter(Boolean).join('>'),
      title: selected.map((item) => item.title || '').filter(Boolean).join('>')
    };
    const risk = this.riskPolicy.evaluate(actions, context);
    if (risk.decision === 'deny') throw Object.assign(new Error('risk_policy_denied'), { risk });
    if (risk.decision !== 'confirm' || this.consumeConfirmation(confirmationToken, operation)) return null;
    const token = this.createConfirmation(operation);
    this.metrics.confirmationRequests += 1;
    return { ok: false, requiresConfirmation: true, confirmation: { token, risks: risk.risks, rules: risk.rules, summary: risk.summary, expiresInSeconds: 120 } };
  }

  validateActionBatch(actions) {
    if (actions.length > 100) throw new Error('actions_limit_exceeded');
    if (Buffer.byteLength(JSON.stringify(actions), 'utf8') > 256 * 1024) throw new Error('actions_too_large');
    for (const action of actions) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('invalid_action');
      const keys = Object.keys(action).filter((key) => key !== 'window');
      if (keys.length !== 1 || !['click', 'setValue', 'hotkey', 'keys', 'kbseq', 'kbops', 'wait'].includes(keys[0])) throw new Error('unsupported_action');
    }
  }

  createConfirmation(operation) {
    const token = crypto.randomBytes(18).toString('base64url');
    this.pendingConfirmations.set(token, { digest: operationDigest(operation), expiresAt: Date.now() + 120000 });
    return token;
  }

  consumeConfirmation(token, operation) {
    if (!token) return false;
    const record = this.pendingConfirmations.get(String(token));
    this.pendingConfirmations.delete(String(token));
    return Boolean(record && record.expiresAt >= Date.now() && record.digest === operationDigest(operation));
  }

  cancelConfirmation(args = {}) {
    if (args.confirm_token) this.pendingConfirmations.delete(String(args.confirm_token));
    else this.pendingConfirmations.clear();
    return { ok: true, cancelled: true };
  }

  async verify(args = {}) {
    const assertions = Array.isArray(args.assertions) ? args.assertions : legacyAssertions(args);
    if (!assertions.length) throw new Error('verification_assertions_required');
    const results = [];
    let windows = null;
    let snapshot = null;
    for (const assertion of assertions) {
      const type = assertion?.type;
      if (type === 'file') {
        const filePath = path.resolve(String(assertion.path || ''));
        if (!this.verifyRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`))) throw new Error('verification_file_outside_allowed_roots');
        const exists = fs.existsSync(filePath);
        const size = exists ? fs.statSync(filePath).size : 0;
        const expectedExists = assertion.exists !== false;
        const passed = exists === expectedExists && (!assertion.minBytes || size >= Number(assertion.minBytes));
        results.push(verificationResult(assertion, { exists, size }, passed));
        continue;
      }
      if (!args.window) throw new Error('window_required');
      windows ||= await this.driver.listWindows();
      const windowInfo = windows.find((item) => String(item.id) === String(args.window));
      if (!windowInfo) throw new Error('window_not_found');
      if (type === 'title') {
        const actual = windowInfo.title || '';
        results.push(verificationResult(assertion, actual, matchText(actual, assertion)));
      } else if (type === 'url') {
        let actual = windowInfo.url || '';
        if (!actual && this.browserDriver) {
          const browserWindows = await this.browserDriver.listWindows();
          actual = browserWindows.find((item) => String(item.id) === String(args.window))?.url || '';
        }
        results.push(verificationResult(assertion, actual, matchText(actual, assertion)));
      } else if (type === 'fingerprint') {
        snapshot ||= await this.state({ window: args.window, includeUi: true, maxNodes: args.maxNodes || 30, includeTransitions: false });
        const actual = snapshot.snapshot?.windows?.[0]?.fingerprint || null;
        results.push(verificationResult(assertion, actual, actual === assertion.equals));
      } else if (type === 'element') {
        const elements = await this.driver.inspect(args.window, assertion.query || {});
        const present = elements.length > 0;
        const expectedPresent = assertion.state !== 'absent';
        let passed = present === expectedPresent;
        const element = elements[0] || null;
        if (passed && element && assertion.enabled !== undefined) passed = Boolean(element.enabled) === Boolean(assertion.enabled);
        if (passed && element && assertion.value !== undefined) passed = String(element.value ?? '') === String(assertion.value);
        results.push(verificationResult(assertion, { present, element: element ? this.compactElement(element) : null }, passed));
      } else throw new Error('verification_type_unsupported');
    }
    return { ok: results.every((item) => item.passed), assertions: results };
  }

  async manageShortcut(args = {}) {
    if (args.action === 'list') {
      const scope = args.windows ? await this.resolveWorkflowScope(args, []) : (args.window ? await this.resolveWorkflowScope(args, []) : null);
      const shortcuts = typeof this.memory.listWorkflows === 'function' ? this.memory.listWorkflows(scope?.scopeKey || null, args.limit || 50) : [];
      return { count: shortcuts.length, shortcuts };
    }
    if (args.action === 'save') {
      if (!args.name || !Array.isArray(args.actions) || !args.actions.length) throw new Error('shortcut_name_and_actions_required');
      this.validateWorkflowPayload(args);
      const scope = await this.resolveWorkflowScope(args, args.actions);
      const actions = scope.scope === 'cross'
        ? args.actions.map((action) => {
            if (!action?.window || !scope.windows[action.window]) throw new Error('cross_window_alias_required');
            const copy = { ...action };
            delete copy.window;
            return { window: action.window, ...this.resolveActionRefs(scope.windows[action.window].id, copy) };
          })
        : args.actions.map((action) => this.resolveActionRefs(scope.window, action));
      const saved = this.memory.recordWorkflow(args.name, scope.scopeKey, this.templateWorkflow(actions, args.params || {}), {
        scope: scope.scope,
        scopeKey: scope.scopeKey,
        route: scope.route,
        parameters: args.params || {},
        aliases: args.aliases || [],
        beforeFingerprint: args.beforeFingerprint,
        afterFingerprint: args.afterFingerprint,
        source: 'main-ai'
      });
      return { ok: true, shortcut: saved };
    }
    if (args.action === 'rename') {
      const scope = await this.resolveWorkflowScope(args, []);
      return { ok: true, shortcut: this.memory.renameWorkflow(args.name, args.newName, scope.scopeKey) };
    }
    if (args.action === 'merge') {
      const scope = await this.resolveWorkflowScope(args, []);
      const remove = Array.isArray(args.remove) ? args.remove : [args.remove].filter(Boolean);
      if (!args.keep || !remove.length) throw new Error('shortcut_merge_names_required');
      let shortcut = null;
      for (const name of remove) shortcut = this.memory.mergeWorkflows(args.keep, name, scope.scopeKey);
      return { ok: true, shortcut };
    }
    if (args.action === 'archive' || args.action === 'restore') {
      const scope = await this.resolveWorkflowScope(args, []);
      const method = args.action === 'archive' ? 'archiveWorkflow' : 'restoreWorkflow';
      return { ok: true, shortcut: this.memory[method](args.name, scope.scopeKey) };
    }
    if (args.action === 'organize') {
      const scope = args.window || args.windows ? await this.resolveWorkflowScope(args, []) : null;
      const candidates = this.memory.organizationCandidates(scope?.scopeKey || null, args.limit || 20);
      if (!args.apply && args.useAi !== true) return { ok: true, due: this.memory.organizationStatus(scope?.scopeKey || null).due, candidates };
      if (!scope) throw new Error('shortcut_organization_scope_required');
      let operations = Array.isArray(args.apply) ? args.apply : [];
      let proposal = null;
      if (!operations.length && args.useAi === true) {
        proposal = await this.fastAi.organize({ candidates, maxOperations: args.maxOperations || 20 });
        if (args.applyAi === true) operations = proposal.operations || [];
      }
      const applied = [];
      for (const operation of operations) {
        if (operation.op === 'merge') {
          const remove = Array.isArray(operation.remove) ? operation.remove : [operation.remove].filter(Boolean);
          for (const name of remove) applied.push(this.memory.mergeWorkflows(operation.keep, name, scope.scopeKey));
        }
        else if (operation.op === 'rename') applied.push(this.memory.renameWorkflow(operation.name, operation.newName, scope?.scopeKey));
        else if (operation.op === 'archive') applied.push(this.memory.archiveWorkflow(operation.name, scope?.scopeKey));
      }
      if (applied.length) this.memory.markOrganized();
      return { ok: true, candidates, applied, ...(proposal ? { proposal: { operations: proposal.operations, model: proposal.model, ...(proposal.usage ? { usage: proposal.usage } : {}) } } : {}) };
    }
    if (args.action === 'run') {
      if ((!args.window && !args.windows) || !args.name) throw new Error('shortcut_window_and_name_required');
      let scope = await this.resolveWorkflowScope(args, []);
      let workflow = typeof this.memory.getWorkflow === 'function' ? this.memory.getWorkflow(args.name, scope.scopeKey) : null;
      if (!workflow && scope.scope === 'cross' && typeof this.memory.getWorkflowForWindowSet === 'function') {
        workflow = this.memory.getWorkflowForWindowSet(args.name, scope.route);
        if (workflow?.route) scope = this.reorderCrossScope(scope, workflow.route);
      }
      if (!workflow) throw new Error('shortcut_not_found');
      if (scope.scope === 'cross' && Array.isArray(workflow.route) && workflow.route.join('>') !== scope.route.join('>')) {
        throw new Error('shortcut_route_mismatch');
      }
      const parameters = { ...(workflow.parameters || {}), ...(args.params || {}) };
      const actions = MemoryStore.interpolate(workflow.actions, parameters);
      const operation = { type: 'shortcut', scope: scope.scope, name: workflow.name, params: parameters, actions, windows: scope.scope === 'cross' ? Object.fromEntries(Object.entries(scope.windows).map(([alias, item]) => [alias, item.id])) : undefined };
      const windowIds = scope.scope === 'cross' ? Object.values(scope.windows).map((item) => item.id) : [scope.window];
      const gate = await this.guardActions(operation, actions, args.confirm_token, windowIds);
      if (gate) return gate;
      const execution = scope.scope === 'cross' ? await this.executeCrossShortcut(scope, actions) : await this.act({ window: scope.window, actions });
      return { ok: execution.ok, shortcut: workflow.name, parameters, execution };
    }
    throw new Error('invalid_shortcut_action');
  }

  async resolveWorkflowScope(args, actions = []) {
    if (args.scope === 'cross' || args.windows) {
      if (!args.windows || typeof args.windows !== 'object') throw new Error('cross_windows_required');
      const aliases = [];
      for (const action of actions) {
        if (action?.window && (aliases.length === 0 || aliases.at(-1) !== action.window)) aliases.push(action.window);
      }
      const targetAliases = aliases.length ? aliases : Object.keys(args.windows);
      const windows = {};
      for (const alias of targetAliases) {
        const id = args.windows[alias];
        if (!id) throw new Error('cross_window_alias_required');
        windows[alias] = { id: String(id), key: await this.getWindowKey(id) };
      }
      const route = targetAliases.map((alias) => windows[alias].key);
      return { scope: 'cross', scopeKey: `cross|${route.join('>')}`, route, windows };
    }
    if (!args.window) throw new Error('shortcut_window_required');
    return { scope: 'single', scopeKey: await this.getWindowKey(args.window), window: String(args.window), route: [] };
  }

  reorderCrossScope(scope, route) {
    const aliases = [];
    for (const key of route) {
      const alias = Object.keys(scope.windows).find((candidate) => scope.windows[candidate].key === key);
      if (!alias || aliases.includes(alias)) throw new Error('shortcut_route_mismatch');
      aliases.push(alias);
    }
    const windows = Object.fromEntries(aliases.map((alias) => [alias, scope.windows[alias]]));
    return { ...scope, windows, route: aliases.map((alias) => windows[alias].key), scopeKey: `cross|${route.join('>')}` };
  }

  async executeCrossShortcut(scope, actions) {
    const results = [];
    let currentAlias = null;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const target = scope.windows[currentAlias];
      const execution = await this.act({ window: target.id, actions: batch });
      results.push({ window: currentAlias, execution });
      batch = [];
    };
    for (const action of actions) {
      const alias = action?.window;
      if (!alias || !scope.windows[alias]) throw new Error('cross_window_alias_required');
      if (currentAlias !== null && alias !== currentAlias) await flush();
      currentAlias = alias;
      const copy = { ...action };
      delete copy.window;
      batch.push(copy);
    }
    await flush();
    return { ok: results.every((item) => item.execution.ok), windows: results };
  }

  validateWorkflowPayload(args) {
    if (String(args.name || '').length > 80) throw new Error('shortcut_name_too_long');
    if ((args.aliases || []).some((alias) => String(alias).length > 80)) throw new Error('shortcut_alias_too_long');
    if (Buffer.byteLength(JSON.stringify(args.actions || []), 'utf8') > 256 * 1024) throw new Error('shortcut_actions_too_large');
    if (Buffer.byteLength(JSON.stringify(args.params || {}), 'utf8') > 32 * 1024) throw new Error('shortcut_params_too_large');
  }

  compactElement(element) {
    return {
      name: element.name || element.text || '',
      role: element.role || element.controlType || '',
      ...(element.automationId ? { automationId: element.automationId } : {}),
      ...(element.className ? { className: element.className } : {}),
      ...(element.value ? { value: element.value } : {}),
      ...(element.bounds ? { bounds: element.bounds } : {}),
      ...(typeof element.score === 'number' ? { score: Number(element.score.toFixed(3)) } : {})
    };
  }

  async act(args = {}) {
    if (!args.window || !Array.isArray(args.actions) || !args.actions.length) {
      throw new Error('window_and_actions_required');
    }
    const started = Date.now();
    const results = [];
    const windowKey = await this.getWindowKey(args.window);
    const actionSignature = this.actionSignature(args.actions);
    const sampled = typeof this.memory.shouldObserve === 'function' && this.memory.shouldObserve(windowKey);
    const before = sampled ? await this.observeWindow(args.window).catch(() => null) : null;
    const prediction = !sampled && typeof this.memory.predict === 'function'
      ? this.memory.predict(windowKey, actionSignature)
      : null;
    await this.driver.focus(args.window);
    await sleep(100);
    try {
      for (const action of args.actions) {
        const resolvedAction = this.resolveActionRefs(args.window, action);
        const result = await this.executeAction(args.window, resolvedAction, windowKey);
        results.push(result);
        if (result.ok === false) throw Object.assign(new Error(result.reason || 'action_failed'), { actionResult: result });
      }
    } catch (error) {
      if (prediction && typeof this.memory.recordPredictionFailure === 'function') this.memory.recordPredictionFailure(windowKey, actionSignature);
      throw error;
    }
    this.metrics.actions += args.actions.length;
    this.metrics.successes += args.actions.length;
    let transition = null;
    if (sampled && before) {
      const after = await this.observeWindow(args.window).catch(() => null);
      if (after && typeof this.memory.recordTransition === 'function') {
        transition = this.memory.recordTransition(windowKey, this.actionSignature(args.actions), before, after);
      }
    }
    const learnedChanged = transition
      ? [...(transition.appeared || []).map((name) => `appeared:${name}`), ...(transition.disappeared || []).map((name) => `disappeared:${name}`)].slice(0, 20)
      : [];
    return {
      ok: true,
      window: args.window,
      elapsedMs: Date.now() - started,
      actions: results,
      changed: [...results.flatMap((item) => item.changed || []), ...learnedChanged].slice(0, 20),
      ...(transition ? { learned: { sampled: true, stable: transition.stable, uses: transition.uses } } : {}),
      ...(prediction ? { prediction: { source: prediction.source, confidence: prediction.confidence, uses: prediction.uses, verified: true } } : {})
    };
  }

  async executeAction(windowId, action, windowKey) {
    if (!action || typeof action !== 'object') throw new Error('invalid_action');
    if (action.click) {
      const query = { ...action.click };
      const cached = this.memory.lookup(windowKey, query);
      const effective = cached ? { ...query, ...cached } : query;
      let result;
      let strategy;
      try {
        try {
          result = await this.retryTargetLookup(() => this.driver.click(windowId, effective));
          strategy = cached ? 'cached-uia' : (result.strategy || 'uia');
        } catch (error) {
          if (!cached || error.message !== 'target_not_found') throw error;
          this.memory.recordFailure(windowKey, query);
          result = await this.retryTargetLookup(() => this.driver.click(windowId, query));
          strategy = 'uia.rediscovered';
        }
      } catch (error) {
        if (error.message !== 'target_not_found') throw error;
        let ocrError = error;
        if (this.ocr.available) {
          try {
            result = await this.clickWithOcr(windowId, query);
            strategy = 'ocr.coordinate';
          } catch (caught) { ocrError = caught; }
        }
        if (!result) {
          if (!this.vision.available || !this.isolated || !['ocr_target_ambiguous_or_low_confidence', 'target_not_found'].includes(ocrError.message)) throw ocrError;
          result = await this.clickWithVision(windowId, query);
          strategy = 'vision.coordinate';
        }
      }
      this.metrics.strategy[strategy] = (this.metrics.strategy[strategy] || 0) + 1;
      if (result.ok) this.memory.recordSuccess(windowKey, query, this.locatorFromResult(result), 'clicked');
      else this.memory.recordFailure(windowKey, query);
      return { ok: Boolean(result.ok), strategy, ...(result.element ? { target: this.compactElement(result.element) } : {}), changed: result.changed || [] };
    }
    if (action.setValue) {
      const query = { text: action.setValue.label, role: action.setValue.role || 'edit' };
      const cached = this.memory.lookup(windowKey, query);
      const effective = cached ? { ...query, ...cached } : query;
      const value = String(action.setValue.value ?? '');
      let result;
      let strategy;
      try {
        result = await this.retryTargetLookup(() => this.driver.setValue(windowId, effective, value));
        strategy = cached ? 'cached-uia.value' : (result.strategy || 'uia.value');
      } catch (error) {
        if (!cached || error.message !== 'target_not_found') throw error;
        this.memory.recordFailure(windowKey, query);
        result = await this.retryTargetLookup(() => this.driver.setValue(windowId, query, value));
        strategy = 'uia.value.rediscovered';
      }
      this.metrics.strategy[strategy] = (this.metrics.strategy[strategy] || 0) + 1;
      if (result.ok) this.memory.recordSuccess(windowKey, query, this.locatorFromResult(result), 'value_set');
      return { ok: Boolean(result.ok), strategy, changed: result.changed || ['value_changed'] };
    }
    if (action.hotkey) {
      const encoded = this.encodeHotkey(action.hotkey);
      const result = await this.driver.sendKeys(windowId, [encoded]);
      const strategy = result.strategy || 'sendkeys';
      this.metrics.strategy[strategy] = (this.metrics.strategy[strategy] || 0) + 1;
      return { ok: Boolean(result.ok), strategy, changed: result.changed || [] };
    }
    if (action.keys) {
      const result = await this.driver.sendKeys(windowId, action.keys);
      const strategy = result.strategy || 'sendkeys';
      this.metrics.strategy[strategy] = (this.metrics.strategy[strategy] || 0) + 1;
      return { ok: Boolean(result.ok), strategy, changed: result.changed || [] };
    }
    if (Array.isArray(action.kbseq)) {
      const result = await this.driver.sendKeys(windowId, action.kbseq.map((key) => String(key)));
      const strategy = result.strategy || 'sendkeys';
      this.metrics.strategy[strategy] = (this.metrics.strategy[strategy] || 0) + 1;
      return { ok: Boolean(result.ok), strategy, changed: result.changed || [] };
    }
    if (Array.isArray(action.kbops)) {
      let previousAt = 0;
      const keys = action.kbops.map((entry) => {
        const requestedAt = Number(entry?.at ?? 0);
        const safeAt = Number.isFinite(requestedAt) ? requestedAt : previousAt;
        const at = Math.max(previousAt, Math.min(Math.max(0, safeAt), 30000));
        const delay = at - previousAt;
        previousAt = at;
        return { key: String(entry?.op ?? ''), at: delay };
      });
      const result = await this.driver.sendKeys(windowId, keys);
      const strategy = result.strategy || 'sendkeys';
      this.metrics.strategy[strategy] = (this.metrics.strategy[strategy] || 0) + 1;
      return { ok: Boolean(result.ok), strategy, changed: result.changed || [] };
    }
    if (action.wait) return this.waitFor(windowId, action.wait);
    throw new Error('unsupported_action');
  }

  async waitFor(windowId, wait) {
    const requestedMs = wait.seconds !== undefined
      ? Number(wait.seconds) * 1000
      : Number(wait.timeoutMs ?? wait.timeout ?? 2000);
    const timeout = Math.max(0, Math.min(Number.isFinite(requestedMs) ? requestedMs : 2000, 30000));
    if (!wait.text) {
      if (wait.state) return { ok: false, reason: 'state_verification_requires_observable_text_or_future_adapter' };
      await sleep(timeout);
      return { ok: true, strategy: 'delay' };
    }
    const started = Date.now();
    while (Date.now() - started <= timeout) {
      const elements = await this.driver.inspect(windowId, { text: wait.text, limit: 3 });
      if (elements && elements.length) return { ok: true, strategy: 'uia.event_or_poll', changed: [`text:${wait.text}`] };
      await sleep(Math.min(100, Math.max(20, timeout / 10)));
    }
    return { ok: false, reason: 'wait_timeout', text: wait.text };
  }

  locatorFromResult(result) {
    const element = result.element || {};
    return {
      ...(element.automationId ? { automationId: element.automationId } : {}),
      ...(element.className ? { className: element.className } : {}),
      ...(element.role ? { role: element.role } : {})
    };
  }

  async inspectOcr(windowId, query) {
    const windows = await this.driver.listWindows();
    const window = windows.find((item) => String(item.id) === String(windowId));
    if (!window?.bounds) throw new Error('window_not_found');
    if (this.isolated) {
      const capture = await this.driver.capture(windowId);
      try {
        const root = path.resolve(this.execution.dataDir || '.data');
        const imagePath = path.resolve(capture.path);
        try {
          if (!imagePath.startsWith(`${root}${path.sep}`)) throw new Error('execution_capture_path_invalid');
          return await this.ocr.inspectImage(imagePath, { ...(capture.bounds || window.bounds), scale: capture.scale || 1 }, query);
        } finally {
          try { fs.unlinkSync(imagePath); } catch (_) { }
        }
      } finally {
        // The nested cleanup handles the normal path; this also covers a driver
        // returning an unexpected relative path.
        try { fs.unlinkSync(capture.path); } catch (_) { }
      }
    }
    return this.ocr.inspect(window.bounds, query);
  }

  async retryTargetLookup(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error.message !== 'target_not_found') throw error;
      await sleep(150);
      return operation();
    }
  }

  async getWindowKey(windowId) {
    const windows = await this.driver.listWindows();
    const window = windows.find((item) => String(item.id) === String(windowId));
    if (!window) throw new Error('window_not_found');
    return `${String(window.process || '').toLocaleLowerCase()}|${String(window.className || '').toLocaleLowerCase()}`;
  }

  async observeWindow(windowId) {
    const elements = await this.driver.inspect(windowId, { limit: 50, includeOffscreen: false });
    const nodes = (elements || []).map((element) => [element.name || '', element.role || '', element.automationId || ''].join('|')).sort();
    const window = (await this.driver.listWindows()).find((item) => String(item.id) === String(windowId));
    return {
      fingerprint: crypto.createHash('sha1').update(nodes.join('\n')).digest('hex').slice(0, 16),
      nodes: (elements || []).slice(0, 100).map((element) => ({
        name: element.name || element.text || '', text: element.text || element.name || '',
        role: element.role || element.controlType || 'unknown',
        ...(element.automationId ? { automationId: element.automationId } : {}),
        ...(element.bounds ? { bounds: element.bounds } : {}),
        ...(typeof element.enabled === 'boolean' ? { enabled: element.enabled } : {})
      })),
      environment: this.environmentForWindow(window)
    };
  }

  environmentForWindow(window) {
    if (!window) return null;
    return { process: window.process || '', className: window.className || '', dpi: window.dpi || null, appVersion: window.appVersion || null, theme: window.theme || null };
  }

  actionSignature(actions) {
    return actions.map((action) => {
      if (action.click) return `click:${action.click.role || ''}:${action.click.text || ''}`;
      if (action.setValue) return `setValue:${action.setValue.label || ''}`;
      if (action.hotkey) return `hotkey:${JSON.stringify(action.hotkey)}`;
      if (action.kbseq) return `kbseq:${action.kbseq.length}`;
      if (action.kbops) return `kbops:${action.kbops.map((entry) => entry.op).join(',')}`;
      if (action.keys) return `keys:${action.keys.length}`;
      if (action.wait) return `wait:${action.wait.text || action.wait.seconds || action.wait.timeoutMs || action.wait.timeout || ''}`;
      return 'unknown';
    }).join(';');
  }

  async clickWithOcr(windowId, query) {
    const candidates = rankElements(await this.inspectOcr(windowId, query), { text: query.text, limit: 3 });
    const best = candidates[0];
    const second = candidates[1];
    if (!best || best.score < 0.82 || (second && best.score - second.score < 0.15)) {
      throw new Error('ocr_target_ambiguous_or_low_confidence');
    }
    const result = await this.driver.clickAt(windowId, best.bounds);
    return { ...result, element: best, changed: [] };
  }

  async clickWithVision(windowId, query) {
    const candidates = rankElements(await this.inspectVision(windowId, query), { text: query.text, limit: 3 });
    const best = candidates[0];
    const second = candidates[1];
    if (!best || best.score < 0.82 || (second && best.score - second.score < 0.15)) throw new Error('vision_target_ambiguous_or_low_confidence');
    const result = await this.driver.clickAt(windowId, best.bounds);
    return { ...result, element: best, changed: [] };
  }

  encodeHotkey(keys) {
    const modifiers = { CTRL: '^', CONTROL: '^', ALT: '%', SHIFT: '+', WIN: '^{ESC}' };
    const values = Array.isArray(keys) ? keys.map((key) => String(key).toUpperCase()) : [String(keys).toUpperCase()];
    const mods = values.slice(0, -1).map((key) => modifiers[key] || '').join('');
    const key = values[values.length - 1];
    const special = { ENTER: '{ENTER}', ESC: '{ESC}', TAB: '{TAB}', SPACE: ' ', BACKSPACE: '{BACKSPACE}', DELETE: '{DELETE}', UP: '{UP}', DOWN: '{DOWN}', LEFT: '{LEFT}', RIGHT: '{RIGHT}' };
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) special[key] = `{${key}}`;
    return `${mods}${special[key] || key.toLocaleLowerCase()}`;
  }
}

function legacyAssertions(args) {
  return args.expectedFingerprint !== undefined ? [{ type: 'fingerprint', equals: args.expectedFingerprint }] : [];
}

function matchText(actual, assertion) {
  if (assertion.equals !== undefined) return String(actual) === String(assertion.equals);
  if (assertion.includes !== undefined) return String(actual).includes(String(assertion.includes));
  if (assertion.matches !== undefined) {
    try { return new RegExp(String(assertion.matches)).test(String(actual)); }
    catch (_) { throw new Error('verification_regex_invalid'); }
  }
  return Boolean(actual);
}

function verificationResult(assertion, actual, passed) {
  const expected = { ...assertion };
  delete expected.path;
  return { type: assertion.type, expected, actual, passed: Boolean(passed) };
}

function classifyActionRisk(actions) {
  return loadRiskPolicy('', {}).evaluate(actions).risks;
}

function operationDigest(operation) {
  return crypto.createHash('sha256').update(JSON.stringify({
    type: operation.type,
    window: operation.window,
    name: operation.name,
    params: operation.params,
    actions: operation.actions
  })).digest('hex');
}

module.exports = { ComputerEngine, classifyActionRisk, operationDigest };
