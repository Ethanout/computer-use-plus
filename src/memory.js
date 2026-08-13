'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { actionToken, mergeKind, candidatePairs, workflowScope } = require('./workflow');

class MemoryStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxRecords = options.maxRecords || 5000;
    this.maxTransitions = options.maxTransitions || 2000;
    this.maxWorkflows = options.maxWorkflows || 500;
    this.maxBytes = options.maxBytes || 10 * 1024 * 1024;
    this.baseTtlMs = options.baseTtlMs || 30 * 24 * 60 * 60 * 1000;
    this.recentLimit = options.recentLimit || 16;
    this.records = new Map();
    this.transitions = new Map();
    this.workflows = new Map();
    this.predictions = new Map();
    this.observationCounts = new Map();
    this.workflowChanges = 0;
    this.lastOrganizedAt = 0;
    this.organizationCandidateCount = 0;
    this.organizationProposals = new Map();
    this.lastSavedBytes = 0;
    this.predictionMinUses = options.predictionMinUses || 2;
    this.predictionMinSuccessRate = options.predictionMinSuccessRate ?? 0.8;
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const records = Array.isArray(parsed) ? parsed : parsed?.records;
      for (const record of Array.isArray(records) ? records : []) {
        if (record && record.key) this.records.set(record.key, record);
      }
      for (const transition of Array.isArray(parsed?.transitions) ? parsed.transitions : []) {
        if (transition && transition.key) this.transitions.set(transition.key, transition);
      }
      for (const workflow of Array.isArray(parsed?.workflows) ? parsed.workflows : []) {
        if (workflow && workflow.key && workflow.name && Array.isArray(workflow.actions)) this.workflows.set(workflow.key, workflow);
      }
      for (const prediction of Array.isArray(parsed?.predictions) ? parsed.predictions : []) {
        if (prediction && prediction.key) this.predictions.set(prediction.key, prediction);
      }
      this.workflowChanges = Number(parsed?.organization?.changesSince || 0);
      this.lastOrganizedAt = Number(parsed?.organization?.lastOrganizedAt || 0);
      this.organizationCandidateCount = Number(parsed?.organization?.candidateCount || 0);
      for (const proposal of Array.isArray(parsed?.organization?.proposals) ? parsed.organization.proposals : []) {
        if (proposal?.scopeKey) this.organizationProposals.set(String(proposal.scopeKey), proposal);
      }
      this.lastSavedBytes = fs.statSync(this.filePath).size;
      this.prune();
    } catch (error) {
      if (error.code !== 'ENOENT') process.stderr.write(`[memory] load failed: ${error.message}\n`);
    }
  }

  key(windowKey, query) {
    return `${windowKey}|${String(query.role || '')}|${String(query.text || '').trim().toLocaleLowerCase()}`;
  }

  lookup(windowKey, query) {
    const record = this.records.get(this.key(windowKey, query));
    if (!record || record.disabled || this.expired(record)) return null;
    record.lastUsedAt = Date.now();
    record.uses = (record.uses || 0) + 1;
    return record.locator;
  }

  recordSuccess(windowKey, query, locator, resultState) {
    const key = this.key(windowKey, query);
    const previous = this.records.get(key) || { key, successes: 0, failures: 0, uses: 0 };
    const total = previous.successes + previous.failures;
    previous.locator = locator;
    previous.resultState = resultState || previous.resultState;
    previous.successes += 1;
    previous.successRate = (previous.successes / (total + 1));
    previous.lastUsedAt = Date.now();
    this.pushRecent(previous, 1);
    previous.disabled = false;
    this.records.set(key, previous);
    this.prune();
    this.save();
  }

  recordFailure(windowKey, query) {
    const key = this.key(windowKey, query);
    const previous = this.records.get(key);
    if (!previous) return;
    previous.failures = (previous.failures || 0) + 1;
    previous.successRate = previous.successes / Math.max(1, previous.successes + previous.failures);
    previous.lastUsedAt = Date.now();
    this.pushRecent(previous, 0);
    if (previous.failures >= 2 && previous.successRate < 0.5) previous.disabled = true;
    this.save();
  }

  prune() {
    for (const [key, record] of this.records) if (this.expired(record)) this.records.delete(key);
    for (const [key, transition] of this.transitions) if (this.expired(transition)) this.transitions.delete(key);
    for (const [key, workflow] of this.workflows) if (this.expired(workflow)) this.workflows.delete(key);
    for (const [key, prediction] of this.predictions) if (this.expired(prediction)) this.predictions.delete(key);
    this.trimMap(this.records, this.maxRecords);
    this.trimMap(this.transitions, this.maxTransitions);
    this.trimMap(this.workflows, this.maxWorkflows);
    this.trimMap(this.predictions, this.maxTransitions);
  }

  shouldObserve(windowKey) {
    const count = (this.observationCounts.get(windowKey) || 0) + 1;
    this.observationCounts.set(windowKey, count);
    return count <= 3 || (count & (count - 1)) === 0;
  }

  recordTransition(windowKey, actionSignature, before, after) {
    if (!before?.fingerprint || !after?.fingerprint) return null;
    const key = `${windowKey}|${actionSignature}|${before.fingerprint}`;
    const previous = this.transitions.get(key) || { key, windowKey, actionSignature, uses: 0, recent: [] };
    previous.uses += 1;
    previous.lastUsedAt = Date.now();
    previous.afterFingerprint = after.fingerprint;
    previous.beforeSnapshot = this.compactPredictionSnapshot(before);
    previous.afterSnapshot = this.compactPredictionSnapshot(after);
    previous.environment = before.environment || after.environment || previous.environment;
    const beforeNodes = new Set((before.nodes || []).map((node) => typeof node === 'string' ? node : `${node.role || ''}|${node.name || node.text || ''}|${node.automationId || ''}`));
    const afterNodes = new Set((after.nodes || []).map((node) => typeof node === 'string' ? node : `${node.role || ''}|${node.name || node.text || ''}|${node.automationId || ''}`));
    previous.appeared = [...afterNodes].filter((node) => !beforeNodes.has(node)).slice(0, 20);
    previous.disappeared = [...beforeNodes].filter((node) => !afterNodes.has(node)).slice(0, 20);
    previous.stable = before.fingerprint === after.fingerprint;
    this.pushRecent(previous, 1);
    previous.successes = (previous.successes || 0) + 1;
    previous.successRate = previous.successes / Math.max(1, (previous.successes || 0) + (previous.failures || 0));
    this.transitions.set(key, previous);
    this.prune();
    this.save();
    return previous;
  }

  compactPredictionSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    return {
      fingerprint: snapshot.fingerprint || null,
      nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes.slice(0, 100).map((node) => typeof node === 'string' ? { text: node, role: 'unknown' } : {
        name: node.name || node.text || '', text: node.text || node.name || '', role: node.role || node.controlType || 'unknown',
        ...(node.automationId ? { automationId: node.automationId } : {}), ...(node.bounds ? { bounds: node.bounds } : {}),
        ...(typeof node.enabled === 'boolean' ? { enabled: node.enabled } : {})
      }) : [],
      ...(snapshot.environment ? { environment: snapshot.environment } : {})
    };
  }

  predict(windowKey, actionSignature, context = {}) {
    const candidates = [...this.transitions.values()]
      .filter((edge) => edge.windowKey === windowKey && edge.actionSignature === actionSignature)
      .filter((edge) => Number(edge.uses || 0) >= this.predictionMinUses)
      .filter((edge) => Number(edge.successRate ?? 0) >= this.predictionMinSuccessRate)
      .filter((edge) => !context.beforeFingerprint || String(edge.key).endsWith(`|${context.beforeFingerprint}`))
      .filter((edge) => this.environmentCompatible(edge.environment, context.environment));
    const edge = candidates.sort((a, b) => this.retentionScore(b) - this.retentionScore(a))[0];
    if (!edge?.afterSnapshot) return null;
    const rate = Number(edge.successRate || 0);
    return {
      source: 'memory',
      confidence: Math.max(0, Math.min(0.99, rate * Math.min(1, Number(edge.uses || 0) / 5))),
      uses: edge.uses || 0,
      beforeFingerprint: edge.beforeFingerprint || String(edge.key).split('|').at(-1),
      afterFingerprint: edge.afterFingerprint || edge.afterSnapshot.fingerprint,
      snapshot: edge.afterSnapshot,
      environment: edge.environment || null
    };
  }

  recordPredictionFailure(windowKey, actionSignature, beforeFingerprint) {
    const prefix = `${windowKey}|${actionSignature}|`;
    for (const edge of this.transitions.values()) {
      if (!String(edge.key).startsWith(prefix)) continue;
      if (beforeFingerprint && !String(edge.key).endsWith(`|${beforeFingerprint}`)) continue;
      edge.failures = (edge.failures || 0) + 1;
      edge.successRate = (edge.successes || 0) / Math.max(1, (edge.successes || 0) + edge.failures);
      this.pushRecent(edge, 0);
    }
    this.save();
  }

  environmentCompatible(expected, actual) {
    if (!expected || !actual) return true;
    for (const key of ['process', 'className', 'appVersion', 'dpi', 'theme']) {
      if (expected[key] !== undefined && actual[key] !== undefined && String(expected[key]) !== String(actual[key])) return false;
    }
    return true;
  }

  expired(record) {
    const frequency = Math.min(5, Math.log2(1 + Number(record.uses || record.successes || 0)));
    const ttl = this.baseTtlMs * (1 + frequency);
    return Date.now() - Number(record.lastUsedAt || 0) > ttl;
  }

  retentionScore(record) {
    const recent = Array.isArray(record.recent) && record.recent.length
      ? record.recent.reduce((sum, value) => sum + value, 0) / record.recent.length
      : Number(record.successRate || 0.5);
    const frequency = Math.log2(1 + Number(record.uses || 0) + Number(record.successes || 0));
    const age = (Date.now() - Number(record.lastUsedAt || 0)) / this.baseTtlMs;
    return frequency + recent * 2 - Number(record.failures || 0) * 0.25 - age;
  }

  trimMap(map, limit) {
    if (map.size <= limit) return;
    const sorted = [...map.values()].sort((a, b) => this.retentionScore(a) - this.retentionScore(b));
    for (const record of sorted.slice(0, map.size - limit)) map.delete(record.key);
  }

  pushRecent(record, result) {
    if (!Array.isArray(record.recent)) record.recent = [];
    record.recent.push(result);
    if (record.recent.length > this.recentLimit) record.recent.splice(0, record.recent.length - this.recentLimit);
  }

  save() {
    let temp;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      temp = `${this.filePath}.tmp`;
      this.prune();
      const json = this.serializeBounded();
      fs.writeFileSync(temp, json, 'utf8');
      this.lastSavedBytes = Buffer.byteLength(json, 'utf8');
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      process.stderr.write(`[memory] save failed: ${error.message}\n`);
      if (temp) {
        try { fs.unlinkSync(temp); } catch (_) { /* best-effort cleanup */ }
      }
    }
  }

  serializePayload() {
    return JSON.stringify({
        version: 4,
        records: [...this.records.values()],
        transitions: [...this.transitions.values()],
        workflows: [...this.workflows.values()],
        predictions: [...this.predictions.values()],
        organization: {
          changesSince: this.workflowChanges,
          lastOrganizedAt: this.lastOrganizedAt,
          candidateCount: this.organizationCandidateCount,
          proposals: [...this.organizationProposals.values()].slice(-20)
        }
      });
  }

  serializeBounded() {
    let json = this.serializePayload();
    if (Buffer.byteLength(json, 'utf8') <= this.maxBytes) return json;
    const candidates = [];
    for (const [mapName, map] of [['transitions', this.transitions], ['records', this.records], ['workflows', this.workflows], ['predictions', this.predictions]]) {
      for (const record of map.values()) candidates.push({ mapName, map, record, score: this.retentionScore(record) - (record.archivedAt ? 100 : 0) });
    }
    candidates.sort((left, right) => left.score - right.score);
    for (let index = 0; index < candidates.length; index += 1) {
      candidates[index].map.delete(candidates[index].record.key);
      if (index % 16 !== 15 && index !== candidates.length - 1) continue;
      json = this.serializePayload();
      if (Buffer.byteLength(json, 'utf8') <= this.maxBytes) return json;
    }
    json = this.serializePayload();
    if (Buffer.byteLength(json, 'utf8') <= this.maxBytes) return json;
    const minimal = JSON.stringify({ version: 4 });
    return Buffer.byteLength(minimal, 'utf8') <= this.maxBytes ? minimal : '{}';
  }

  stats() {
    return {
      records: this.records.size,
      transitions: this.transitions.size,
      workflows: this.workflows.size,
      predictions: this.predictions.size,
      storageBytes: this.lastSavedBytes,
      organization: this.organizationStatus()
    };
  }

  recordWorkflow(name, windowKey, actions, metadata = {}) {
    const normalizedName = String(name || '').trim().slice(0, 80);
    if (!normalizedName || !Array.isArray(actions) || !actions.length) return null;
    const scopeKey = String(metadata.scopeKey || windowKey || '');
    const key = `${scopeKey}|workflow:${normalizedName.toLocaleLowerCase()}`;
    const previous = this.workflows.get(key) || { key, name: normalizedName, windowKey: scopeKey, scopeKey, scope: metadata.scope || 'single', uses: 0, successes: 0, failures: 0, recent: [], aliases: [] };
    previous.actions = JSON.parse(JSON.stringify(actions));
    if (metadata.parameters && typeof metadata.parameters === 'object') previous.parameters = metadata.parameters;
    else if (!previous.parameters) previous.parameters = {};
    previous.windowKey = scopeKey;
    previous.scopeKey = scopeKey;
    previous.scope = metadata.scope || previous.scope || 'single';
    if (Array.isArray(metadata.route)) previous.route = [...metadata.route];
    if (metadata.beforeFingerprint) previous.beforeFingerprint = metadata.beforeFingerprint;
    if (metadata.afterFingerprint) previous.afterFingerprint = metadata.afterFingerprint;
    if (Array.isArray(metadata.aliases)) previous.aliases = [...new Set([...(previous.aliases || []), ...metadata.aliases.map((alias) => String(alias).trim()).filter(Boolean)])];
    previous.source = metadata.source || previous.source || 'automatic';
    previous.uses += 1;
    previous.successes = (previous.successes || 0) + 1;
    previous.lastUsedAt = Date.now();
    previous.successRate = 1;
    this.pushRecent(previous, 1);
    this.workflows.set(key, previous);
    this.workflowChanges += 1;
    this.consolidateWorkflows(scopeKey);
    this.prune();
    this.save();
    return this.publicWorkflow(this.findWorkflow(normalizedName, scopeKey) || previous);
  }

  findWorkflow(name, windowKey, includeArchived = false) {
    const normalized = String(name || '').trim().toLocaleLowerCase();
    const exact = this.workflows.get(`${windowKey}|workflow:${normalized}`);
    const candidate = exact || [...this.workflows.values()]
      .filter((workflow) => workflowScope(workflow) === String(windowKey || ''))
      .filter((workflow) => workflow.name.toLocaleLowerCase() === normalized || (workflow.aliases || []).some((alias) => String(alias).toLocaleLowerCase() === normalized))
      .sort((left, right) => Number(right.lastUsedAt || 0) - Number(left.lastUsedAt || 0))[0];
    if (!candidate || (!includeArchived && candidate.archivedAt) || this.expired(candidate)) return null;
    return candidate;
  }

  getWorkflow(name, windowKey) {
    const candidate = this.findWorkflow(name, windowKey);
    if (!candidate) return null;
    candidate.lastUsedAt = Date.now();
    candidate.uses = (candidate.uses || 0) + 1;
    return this.publicWorkflow(candidate);
  }

  getWorkflowForWindowSet(name, route) {
    const expected = (Array.isArray(route) ? route : []).map(String);
    if (!expected.length) return null;
    const expectedSet = new Set(expected);
    const candidate = [...this.workflows.values()]
      .filter((workflow) => workflow.scope === 'cross' && Array.isArray(workflow.route) && workflow.route.length === expected.length)
      .filter((workflow) => new Set(workflow.route.map(String)).size === expectedSet.size && workflow.route.every((key) => expectedSet.has(String(key))))
      .filter((workflow) => {
        const normalized = String(name || '').trim().toLocaleLowerCase();
        return workflow.name.toLocaleLowerCase() === normalized || (workflow.aliases || []).some((alias) => String(alias).toLocaleLowerCase() === normalized);
      })
      .sort((left, right) => Number(right.lastUsedAt || 0) - Number(left.lastUsedAt || 0))[0];
    if (!candidate || candidate.archivedAt || this.expired(candidate)) return null;
    candidate.lastUsedAt = Date.now();
    candidate.uses = (candidate.uses || 0) + 1;
    return this.publicWorkflow(candidate);
  }

  listWorkflows(windowKey, limit = 50) {
    return [...this.workflows.values()]
      .filter((workflow) => !windowKey || workflowScope(workflow) === String(windowKey))
      .filter((workflow) => !workflow.archivedAt)
      .filter((workflow) => !this.expired(workflow))
      .sort((left, right) => Number(right.lastUsedAt || 0) - Number(left.lastUsedAt || 0))
      .slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)))
      .map((workflow) => this.publicWorkflow(workflow, false));
  }

  publicWorkflow(workflow, includeActions = true) {
    return {
      name: workflow.name,
      windowKey: workflow.windowKey,
      scope: workflow.scope || 'single',
      uses: workflow.uses || 0,
      source: workflow.source || 'automatic',
      ...(Array.isArray(workflow.route) ? { route: workflow.route } : {}),
      ...(workflow.aliases?.length ? { aliases: workflow.aliases } : {}),
      ...(workflow.variants?.length ? { variants: workflow.variants.length } : {}),
      ...(workflow.parameters && Object.keys(workflow.parameters).length ? { parameters: workflow.parameters } : {}),
      ...(includeActions ? { actions: workflow.actions || [] } : {})
    };
  }

  consolidateWorkflows(scopeKey) {
    const candidates = [...this.workflows.values()]
      .filter((workflow) => workflowScope(workflow) === String(scopeKey))
      .filter((workflow) => !workflow.archivedAt)
      .sort((left, right) => this.retentionScore(right) - this.retentionScore(left));
    let merged = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const winner = candidates[index];
      if (!this.workflows.has(winner.key)) continue;
      for (let otherIndex = index + 1; otherIndex < candidates.length; otherIndex += 1) {
        const loser = candidates[otherIndex];
        if (!this.workflows.has(loser.key)) continue;
        const kind = mergeKind(winner, loser, { requireTransition: true });
        if (!kind) continue;
        winner.aliases = [...new Set([...(winner.aliases || []), loser.name, ...(loser.aliases || [])])].filter((alias) => alias !== winner.name);
        winner.uses = (winner.uses || 0) + (loser.uses || 0);
        winner.successes = (winner.successes || 0) + (loser.successes || 0);
        winner.failures = (winner.failures || 0) + (loser.failures || 0);
        winner.successRate = winner.successes / Math.max(1, winner.successes + winner.failures);
        winner.lastUsedAt = Math.max(Number(winner.lastUsedAt || 0), Number(loser.lastUsedAt || 0));
        if (kind === 'safe-wait-variant') {
          winner.variants = [...(winner.variants || []), loser.actions].slice(-4);
        }
        this.workflows.delete(loser.key);
        merged += 1;
      }
    }
    if (merged) this.workflowChanges += merged;
    return merged;
  }

  renameWorkflow(name, newName, scopeKey) {
    const workflow = this.findWorkflow(name, scopeKey, true);
    const normalizedName = String(newName || '').trim().slice(0, 80);
    if (!workflow || !normalizedName) throw new Error('shortcut_not_found');
    const targetKey = `${scopeKey}|workflow:${normalizedName.toLocaleLowerCase()}`;
    if (targetKey !== workflow.key && this.workflows.has(targetKey)) return this.mergeWorkflows(normalizedName, name, scopeKey);
    this.workflows.delete(workflow.key);
    workflow.aliases = [...new Set([...(workflow.aliases || []), workflow.name])].filter((alias) => alias !== normalizedName);
    workflow.name = normalizedName;
    workflow.key = targetKey;
    this.workflows.set(targetKey, workflow);
    this.workflowChanges += 1;
    this.save();
    return this.publicWorkflow(workflow, false);
  }

  mergeWorkflows(keepName, removeName, scopeKey) {
    const winner = this.findWorkflow(keepName, scopeKey, true);
    const loser = this.findWorkflow(removeName, scopeKey, true);
    if (!winner || !loser || winner.key === loser.key) throw new Error('shortcut_not_found');
    winner.aliases = [...new Set([...(winner.aliases || []), loser.name, ...(loser.aliases || [])])].filter((alias) => alias !== winner.name);
    winner.variants = [...(winner.variants || []), ...(loser.variants || []), loser.actions].slice(-4);
    winner.uses = (winner.uses || 0) + (loser.uses || 0);
    winner.successes = (winner.successes || 0) + (loser.successes || 0);
    winner.failures = (winner.failures || 0) + (loser.failures || 0);
    winner.successRate = winner.successes / Math.max(1, winner.successes + winner.failures);
    this.workflows.delete(loser.key);
    this.workflowChanges += 1;
    this.save();
    return this.publicWorkflow(winner, false);
  }

  archiveWorkflow(name, scopeKey) {
    const workflow = this.findWorkflow(name, scopeKey, true);
    if (!workflow) throw new Error('shortcut_not_found');
    workflow.archivedAt = Date.now();
    this.workflowChanges += 1;
    this.save();
    return this.publicWorkflow(workflow, false);
  }

  restoreWorkflow(name, scopeKey) {
    const workflow = this.findWorkflow(name, scopeKey, true);
    if (!workflow) throw new Error('shortcut_not_found');
    delete workflow.archivedAt;
    workflow.lastUsedAt = Date.now();
    this.workflowChanges += 1;
    this.save();
    return this.publicWorkflow(workflow, false);
  }

  organizationCandidates(scopeKey = null, limit = 20) {
    const workflows = [...this.workflows.values()].filter((workflow) => !scopeKey || workflowScope(workflow) === String(scopeKey));
    const candidates = candidatePairs(workflows, { limit }).map((pair) => ({
      left: this.publicWorkflow(pair.left, true),
      right: this.publicWorkflow(pair.right, true),
      similarity: pair.similarity
    }));
    this.organizationCandidateCount = candidates.length;
    return candidates;
  }

  organizationStatus(scopeKey = null) {
    const ageMs = this.lastOrganizedAt ? Date.now() - this.lastOrganizedAt : Infinity;
    return {
      changesSince: this.workflowChanges,
      lastOrganizedAt: this.lastOrganizedAt || null,
      candidates: this.organizationCandidateCount,
      pendingProposals: scopeKey ? Number(this.organizationProposals.has(String(scopeKey))) : this.organizationProposals.size,
      due: this.workflowChanges >= 50 || this.organizationCandidateCount >= 20 || (this.organizationCandidateCount > 0 && ageMs >= 24 * 60 * 60 * 1000)
    };
  }

  organizationScopes() {
    return [...new Set([...this.workflows.values()].filter((workflow) => !workflow.archivedAt).map((workflow) => workflowScope(workflow)))];
  }

  saveOrganizationProposal(scopeKey, proposal = {}) {
    const key = String(scopeKey || '');
    if (!key) throw new Error('organization_scope_required');
    const value = {
      scopeKey: key,
      createdAt: Date.now(),
      model: String(proposal.model || '').slice(0, 120),
      operations: JSON.parse(JSON.stringify(Array.isArray(proposal.operations) ? proposal.operations.slice(0, 20) : []))
    };
    this.organizationProposals.set(key, value);
    while (this.organizationProposals.size > 20) this.organizationProposals.delete(this.organizationProposals.keys().next().value);
    this.workflowChanges = 0;
    this.lastOrganizedAt = value.createdAt;
    this.organizationCandidateCount = 0;
    this.save();
    return JSON.parse(JSON.stringify(value));
  }

  getOrganizationProposal(scopeKey) {
    const value = this.organizationProposals.get(String(scopeKey || ''));
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  clearOrganizationProposal(scopeKey) {
    const changed = this.organizationProposals.delete(String(scopeKey || ''));
    if (changed) this.save();
    return changed;
  }

  markOrganized() {
    this.workflowChanges = 0;
    this.lastOrganizedAt = Date.now();
    this.organizationCandidateCount = 0;
    this.save();
  }

  maintenance() {
    const before = [this.records.size, this.transitions.size, this.workflows.size].join(':');
    this.prune();
    const after = [this.records.size, this.transitions.size, this.workflows.size].join(':');
    if (before !== after) this.save();
    return { changed: before !== after, ...this.stats() };
  }

  static interpolate(value, params = {}) {
    if (Array.isArray(value)) return value.map((item) => MemoryStore.interpolate(item, params));
    if (!value || typeof value !== 'object') {
      if (typeof value !== 'string') return value;
      const exact = value.match(/^\{\{([A-Za-z0-9_.-]+)\}\}$/);
      if (exact) {
        let current = params;
        for (const part of exact[1].split('.')) current = current && current[part];
        if (current !== undefined && current !== null) return current;
      }
      return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (match, key) => {
        const parts = key.split('.');
        let current = params;
        for (const part of parts) current = current && current[part];
        return current === undefined || current === null ? match : String(current);
      });
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, MemoryStore.interpolate(item, params)]));
  }

  recentTransitions(windowKey, limit = 10) {
    const prefix = `${windowKey}|`;
    return [...this.transitions.values()]
      .filter((transition) => !windowKey || String(transition.key || '').startsWith(prefix))
      .sort((left, right) => Number(right.lastUsedAt || 0) - Number(left.lastUsedAt || 0))
      .slice(0, Math.max(1, Math.min(Number(limit) || 10, 20)))
      .map((transition) => ({
        action: transition.actionSignature,
        before: transition.key?.split('|').at(-1) || null,
        after: transition.afterFingerprint || null,
        appeared: transition.appeared || [],
        disappeared: transition.disappeared || [],
        stable: Boolean(transition.stable),
        uses: transition.uses || 0
      }));
  }
}

module.exports = { MemoryStore };
