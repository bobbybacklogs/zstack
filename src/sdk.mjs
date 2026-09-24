import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BRIDGE_URL,
  checkBridgeHealth,
  fetchModelHitchState,
  resolveRoleMapping,
  sendChat,
  runRole as connectorRunRole,
  runPanel as connectorRunPanel,
  syncCursorRules,
  ZSTACK_ROLES
} from './connector.mjs';
import {
  checkUpstream,
  handleUpdateCommand,
  getSyncState,
  saveSyncState
} from './upstream.mjs';
import {
  BUDGET_TIERS,
  BUDGET_SOURCES,
  getStoredBudget,
  saveStoredBudget,
  resolveBudgetMapping
} from './budget.mjs';
import { classifyPromptSemantic, ROUTER_MIN_SCORE } from './router.mjs';
import { planContext, DEFAULT_CONTEXT_BUDGET_TOKENS } from './context.mjs';
import { parseDoc } from './manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT_DIR = join(__dirname, '..');

// Tracks frontmatter-fallback warnings so each file warns at most once per process.
const warnedFallback = new Set();
function warnFallback(source) {
  if (warnedFallback.has(source)) return;
  warnedFallback.add(source);
  console.error(`[manifest] ${source}: no frontmatter, using legacy extraction`);
}

/**
 * Default system prompt that infuses zstack engineering discipline into all executions.
 */
export const ZSTACK_SYSTEM_PROMPT = `You are an expert engineer executing under the zstack Agent Operating System.
You operate with rigorous engineering discipline, verified outcomes, and zero fluff.
- Write unslopped declarative prose: short, active sentences with no em-dashes (—) or conversational fillers.
- Always name the core data shapes and invariants before writing code.
- Verify against real artifacts (live processes, HTTP responses, database records, test outputs), never proxies or mocks.
- Cite the applicable zstack principles that influenced your decisions and explain the concrete choices they changed.`;

/**
 * Confidence policy for guided playbook selection (see README "Prompt Classification").
 * A match is confident when the top candidate scores >= CLASSIFY_CONFIDENCE_THRESHOLD
 * and leads the runner-up by >= CLASSIFY_AMBIGUITY_MARGIN. Otherwise the match is
 * ambiguous and callers should offer guided selection (or the semantic router).
 */
export const CLASSIFY_CONFIDENCE_THRESHOLD = 1.0;
export const CLASSIFY_AMBIGUITY_MARGIN = 0.5;
export const CLASSIFY_MAX_CANDIDATES = 3;

/**
 * Deterministic keyword/specificity scorer shared by the classifier, the
 * triage heuristic, and the semantic-router fallback ordering. Scores every
 * trigger by keyword hits plus a specificity bonus (longer patterns are more
 * specific); ties keep PLAYBOOK_TRIGGERS priority order.
 */
export function scorePlaybookTriggers(text) {
  const input = String(text || '');
  const scored = [];
  for (let index = 0; index < PLAYBOOK_TRIGGERS.length; index++) {
    const rule = PLAYBOOK_TRIGGERS[index];
    let matches = null;
    try {
      matches = input.match(new RegExp(rule.regex.source, 'gi'));
    } catch {
      matches = rule.regex.test(input) ? ['match'] : null;
    }
    if (matches && matches.length > 0) {
      const unique = [...new Set(matches.map(m => m.toLowerCase()))].slice(0, 3);
      const specificity = Math.round((rule.regex.source.length / 100) * 10) / 10;
      const score = Math.round((matches.length + specificity) * 10) / 10;
      scored.push({
        type: rule.type,
        role: rule.role,
        principles: rule.principles,
        playbookFile: `playbooks/${rule.type}.md`,
        score,
        reason: `matched ${unique.map(u => `'${u}'`).join(', ')} (${matches.length} hit${matches.length > 1 ? 's' : ''})`,
        order: index
      });
    }
  }
  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return scored.map(({ order, ...rest }) => rest);
}

/**
 * Standard classification patterns to map freeform user intent to playbooks.
 */
const PLAYBOOK_TRIGGERS = [
  { type: 'authoring-a-skill', regex: /\b(author(ing)?\s+a?\s*skill|create\s+a?\s*skill|package\s+a?\s*skill|new\s+skill)\b/i, role: 'judgment and prose', principles: ['encode-lessons-in-structure', 'experience-first'] },
  { type: 'autonomous-run', regex: /\b(autonomous|unattended|overnight|batch agent|run loop)\b/i, role: 'feature, refactoring', principles: ['sequence-verifiable-units', 'make-operations-idempotent'] },
  { type: 'pause-safely', regex: /\b(pause(\s+safely)?|checkpoint|stash\s+work|save\s+progress)\b/i, role: 'judgment and prose', principles: ['sequence-verifiable-units', 'prove-it-works'] },
  { type: 'session-pickup', regex: /\b(session\s+pickup|resume\s+session|continue\s+session|pick\s+up\s+where)\b/i, role: 'judgment and prose', principles: ['foundational-thinking', 'outcome-oriented-execution'] },
  { type: 'perf-issue', regex: /\b(perf|performance|slow|latency|bottleneck|leak|memory|cpu|throughput)\b/i, role: 'bug-fix, perf-issue', principles: ['fix-root-causes', 'build-the-lever', 'prove-it-works'] },
  { type: 'runtime-forensics', regex: /\b(deadlock|socket leak|connection pool|oom|corrupt state)\b/i, role: 'bug-fix, perf-issue', principles: ['separate-before-serializing-shared-state', 'fix-root-causes'] },
  { type: 'trace-forensics', regex: /\b(trace|span|telemetry|jaeger|otlp|network delay)\b/i, role: 'bug-fix, perf-issue', principles: ['fix-root-causes', 'prove-it-works'] },
  { type: 'visual-parity', regex: /\b(css|styling|pixel|visual regression|responsive layout)\b/i, role: 'feature, refactoring', principles: ['experience-first', 'prove-it-works'] },
  { type: 'refactoring', regex: /\b(refactor|restructure|clean|cleanup|simplify|deprecate|remove dead|dedup)\b/i, role: 'feature, refactoring', principles: ['laziness-protocol', 'subtract-before-you-add', 'minimize-reader-load'] },
  { type: 'prototype', regex: /\b(prototype|spike|explore|experiment|poc|proof of concept)\b/i, role: 'fast exploration', principles: ['exhaust-the-design-space', 'never-block-on-the-human', 'laziness-protocol'] },
  { type: 'investigation', regex: /\b(investigate|how does|why does|explain|understand|where is)\b/i, role: 'how explorer', principles: ['guard-the-context-window', 'foundational-thinking'] },
  { type: 'opening-a-pr', regex: /\b(pr|pull request|commit summary|diff summary)\b/i, role: 'judgment and prose', principles: ['minimize-reader-load', 'sequence-verifiable-units'] },
  { type: 'eval', regex: /\b(eval|benchmark|accuracy score|quality delta)\b/i, role: 'deep reasoning', principles: ['prove-it-works', 'encode-lessons-in-structure'] },
  { type: 'bug-fix', regex: /\b(bug|fix|broken|error|failing|crash|exception|regression|issue)\b/i, role: 'bug-fix, perf-issue', principles: ['fix-root-causes', 'prove-it-works', 'boundary-discipline'] },
  { type: 'feature', regex: /\b(feature|add|implement|create|build|support|new)\b/i, role: 'feature, refactoring', principles: ['foundational-thinking', 'boundary-discipline', 'sequence-verifiable-units'] }
];

export class ZStack {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BRIDGE_URL;
    this.rootDir = options.rootDir || DEFAULT_ROOT_DIR;
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.defaultSystemPrompt = options.defaultSystemPrompt || ZSTACK_SYSTEM_PROMPT;
    // Per-request gateway timeout override (ms); undefined falls back to
    // MODELHITCH_TIMEOUT env, then the 30000ms default in connector.mjs.
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Health and connectivity check.
   */
  async status() {
    const health = await checkBridgeHealth(this.baseUrl);
    if (!health.ok) {
      return { ok: false, error: health.error, baseUrl: this.baseUrl };
    }
    const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    const stored = this.getBudget();
    let mapping;
    let budget = null;
    try {
      budget = await this.getBudgetMapping(state);
      mapping = { mode: state.activeProviders.includes('opencode') || state.activeProviders.includes('opencode-go') ? 'opencode-zen-go' : 'modelhitch-multi-provider', models: budget.models, panelList: budget.panelList };
    } catch {
      const legacy = resolveRoleMapping(state);
      mapping = legacy;
    }
    return {
      ok: true,
      baseUrl: this.baseUrl,
      message: health.message,
      activeProviders: state.activeProviders,
      mode: mapping.mode,
      mapping: mapping.models,
      panelModels: mapping.panelList,
      budget: stored,
      budgetDetail: budget
    };
  }

  /**
   * Read the stored budget tier/source selection.
   */
  getBudget() {
    return getStoredBudget();
  }

  /**
   * Resolve the active budget mapping against live ModelHitch state.
   * Pass a pre-fetched state to avoid an extra network round-trip.
   */
  async getBudgetMapping(cachedState = null) {
    const state = cachedState || await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    const stored = getStoredBudget();
    return resolveBudgetMapping({ tier: stored.tier, source: stored.source, state });
  }

  /**
   * Persist a new budget tier/source. Does not sync Cursor rules by itself;
   * call syncRules() afterwards or use the CLI `budget` command which
   * previews the mapping and requires explicit confirmation beforehand.
   */
  async setBudget(tier, source = null) {
    if (!BUDGET_TIERS[tier]) {
      throw new Error(`Unknown budget tier: ${tier}. Valid tiers: ${Object.keys(BUDGET_TIERS).join(', ')}`);
    }
    const stored = getStoredBudget();
    const nextSource = source || stored.source || 'catalog';
    if (nextSource !== 'config' && nextSource !== 'catalog') {
      throw new Error(`Unknown budget source: ${nextSource}. Valid sources: config, catalog`);
    }
    const saved = saveStoredBudget({ tier, source: nextSource });
    void saved;
    return await this.getBudgetMapping();
  }

  /**
   * Return metadata and architecture overview for zstack.
   */
  about() {
    return {
      name: 'zstack',
      version: '0.1.0',
      description: 'Agent Operating System for Rigorous Engineering powered by ModelHitch',
      repository: 'https://github.com/bobbybacklogs/zstack',
      license: 'MIT',
      gateway: this.baseUrl,
      playbookCount: this.listPlaybooks().length,
      principleCount: this.listPrinciples().length,
      subsystems: [
        'Task Playbooks (15 SOPs for features, bug-fixes, refactors, forensics, PRs)',
        'Durable Principles (20 non-negotiable engineering rules cited against changes)',
        'Workload-Specific Model Routing (decouples engineering roles to optimal models)',
        'ModelHitch Integration (local multi-wire resilience gateway on port 3939)'
      ]
    };
  }

  /**
   * List all available task playbooks (indexed via the manifest frontmatter
   * contract; documents without frontmatter use legacy extraction).
   */
  listPlaybooks() {
    const playbooksDir = join(this.rootDir, 'playbooks');
    if (!existsSync(playbooksDir)) return [];
    return readdirSync(playbooksDir)
      .filter(f => f.endsWith('.md'))
      .map(file => {
        const id = file.replace(/\.md$/, '');
        const fullPath = join(playbooksDir, file);
        const content = readFileSync(fullPath, 'utf8');
        const parsed = parseDoc(content, `playbooks/${file}`);
        if (parsed.data) {
          if (parsed.data.id && parsed.data.id !== id) {
            throw new Error(`playbooks/${file}: id '${parsed.data.id}' does not match filename '${id}'`);
          }
          const triggerMatch = parsed.body.match(/> \*\*Trigger:\*\*\s*(.+)/i);
          const titleMatch = parsed.body.match(/^#\s+(.+)$/m);
          return {
            id,
            file,
            path: fullPath,
            title: parsed.data.title || (titleMatch ? titleMatch[1].trim() : id),
            trigger: parsed.data.applyWhen || (triggerMatch ? triggerMatch[1].trim() : 'General task'),
            keywords: parsed.data.keywords || [],
            requires: parsed.data.requires || [],
            version: parsed.data.version || null
          };
        }
        warnFallback(`playbooks/${file}`);
        const triggerMatch = content.match(/> \*\*Trigger:\*\*\s*(.+)/i);
        const titleMatch = content.match(/^#\s+(.+)$/m);
        return {
          id,
          file,
          path: fullPath,
          title: titleMatch ? titleMatch[1].trim() : id,
          trigger: triggerMatch ? triggerMatch[1].trim() : 'General task',
          keywords: [],
          requires: [],
          version: null
        };
      });
  }

  /**
   * Get contents of a specific playbook.
   */
  getPlaybook(name) {
    const clean = name.replace(/\.md$/, '');
    const playbookPath = join(this.rootDir, 'playbooks', `${clean}.md`);
    if (!existsSync(playbookPath)) {
      throw new Error(`Playbook not found: ${clean} (searched ${playbookPath})`);
    }
    return readFileSync(playbookPath, 'utf8');
  }

  /**
   * List all 20 principles (indexed via the manifest frontmatter contract;
   * documents without frontmatter use legacy extraction).
   */
  listPrinciples() {
    const principlesDir = join(this.rootDir, 'principles');
    if (!existsSync(principlesDir)) return [];
    return readdirSync(principlesDir)
      .filter(f => f.endsWith('.md'))
      .map(file => {
        const id = file.replace(/\.md$/, '');
        const fullPath = join(principlesDir, file);
        const content = readFileSync(fullPath, 'utf8');
        const parsed = parseDoc(content, `principles/${file}`);
        if (parsed.data) {
          if (parsed.data.id && parsed.data.id !== id) {
            throw new Error(`principles/${file}: id '${parsed.data.id}' does not match filename '${id}'`);
          }
          const applyMatch = parsed.body.match(/> \*\*Apply when:\*\*\s*(.+)/i);
          const titleMatch = parsed.body.match(/^#\s+(.+)$/m);
          return {
            id,
            file,
            path: fullPath,
            title: parsed.data.title || (titleMatch ? titleMatch[1].trim() : id),
            applyWhen: parsed.data.applyWhen || (applyMatch ? applyMatch[1].trim() : 'General engineering decisions'),
            keywords: parsed.data.keywords || [],
            requires: parsed.data.requires || [],
            version: parsed.data.version || null
          };
        }
        warnFallback(`principles/${file}`);
        const applyMatch = content.match(/> \*\*Apply when:\*\*\s*(.+)/i);
        const titleMatch = content.match(/^#\s+(.+)$/m);
        return {
          id,
          file,
          path: fullPath,
          title: titleMatch ? titleMatch[1].trim() : id,
          applyWhen: applyMatch ? applyMatch[1].trim() : 'General engineering decisions',
          keywords: [],
          requires: [],
          version: null
        };
      });
  }

  /**
   * Get contents of a specific principle.
   */
  getPrinciple(name) {
    const clean = name.replace(/\.md$/, '');
    const principlePath = join(this.rootDir, 'principles', `${clean}.md`);
    if (!existsSync(principlePath)) {
      throw new Error(`Principle not found: ${clean} (searched ${principlePath})`);
    }
    return readFileSync(principlePath, 'utf8');
  }

  /**
   * Classify a user prompt into a matching playbook and relevant principles.
   * Backward compatible: returns the first matching trigger in priority order.
   */
  classifyPrompt(prompt) {
    for (const rule of PLAYBOOK_TRIGGERS) {
      if (rule.regex.test(prompt)) {
        return {
          type: rule.type,
          role: rule.role,
          principles: rule.principles,
          playbookFile: `playbooks/${rule.type}.md`
        };
      }
    }
    return {
      type: 'feature',
      role: 'feature, refactoring',
      principles: ['foundational-thinking', 'boundary-discipline', 'sequence-verifiable-units'],
      playbookFile: 'playbooks/feature.md'
    };
  }

  /**
   * Ranked variant of classifyPrompt. Scores every trigger by keyword hits plus
   * a specificity bonus (longer patterns are more specific), returning the top
   * three candidates with match reasons. The top candidate mirrors
   * classifyPrompt's priority order on ties so behavior stays compatible.
   */
  classifyPromptDetailed(prompt) {
    const text = String(prompt || '');
    const candidates = scorePlaybookTriggers(text).slice(0, CLASSIFY_MAX_CANDIDATES);
    if (candidates.length === 0) {
      const fallback = this.classifyPrompt(text);
      return { ...fallback, candidates: [], confidence: 0, ambiguous: false };
    }
    // Top candidate keeps legacy priority on exact ties via stable order sort above.
    const top = candidates[0];
    const runnerUp = candidates[1];
    const margin = runnerUp ? Math.round((top.score - runnerUp.score) * 10) / 10 : Infinity;
    const ambiguous = candidates.length > 1 &&
      (top.score < CLASSIFY_CONFIDENCE_THRESHOLD || margin < CLASSIFY_AMBIGUITY_MARGIN);
    return {
      type: top.type,
      role: top.role,
      principles: top.principles,
      playbookFile: top.playbookFile,
      candidates,
      confidence: top.score,
      ambiguous
    };
  }

  /**
   * Execute a structured task via zstack SOP and ModelHitch.
   */
  async task(options) {
    const prompt = typeof options === 'string' ? options : options.prompt;
    if (!prompt) throw new Error('Task prompt is required');

    // 1. Determine Playbook & Principles (keyword first, semantic on ambiguity)
    const detailed = this.classifyPromptDetailed(prompt);
    let classification = {
      type: detailed.type,
      role: detailed.role,
      principles: detailed.principles,
      playbookFile: detailed.playbookFile
    };
    if (!options.playbook && !options.type && detailed.ambiguous && options.semantic !== false) {
      try {
        const sem = await classifyPromptSemantic(prompt, { baseUrl: this.baseUrl, rootDir: this.rootDir });
        if (sem && sem.score >= ROUTER_MIN_SCORE) {
          const rule = PLAYBOOK_TRIGGERS.find(r => r.type === sem.type);
          if (rule) {
            classification = {
              type: rule.type,
              role: rule.role,
              principles: rule.principles,
              playbookFile: `playbooks/${rule.type}.md`
            };
          }
        }
      } catch {
        // Semantic router degrades gracefully; keyword result stands.
      }
    }
    const playbookType = options.playbook || options.type || classification.type;
    const roleName = options.role || classification.role;
    const principleNames = options.principles || classification.principles;

    // Load playbook & principles text
    let playbookContent = '';
    try {
      playbookContent = this.getPlaybook(playbookType);
    } catch {
      playbookContent = `# Task: ${playbookType}`;
    }

    const principleTexts = {};
    for (const p of principleNames) {
      try {
        principleTexts[p] = `### Principle: ${p}\n${this.getPrinciple(p)}`;
      } catch {
        principleTexts[p] = `### Principle: ${p}`;
      }
    }

    // 2. Context budgeting (guard-the-context-window): prune before dispatch.
    const contextPlan = planContext({
      files: Array.isArray(options.files) ? options.files : [],
      playbookText: playbookContent,
      principleTexts,
      principleNames,
      budgetTokens: options.contextBudget || options.contextTokens || DEFAULT_CONTEXT_BUDGET_TOKENS,
      workspaceDir: this.workspaceDir,
      noPrune: !!options.noPrune
    });
    if (contextPlan.aborted) {
      throw new Error(contextPlan.abortReason);
    }
    const filesContext = contextPlan.filesContext;
    const principlesText = contextPlan.principlesText;
    const contextNotes = contextPlan.trimmed.length > 0 ? contextPlan.trimmed : null;

    // Assemble system instructions
    const systemPrompt = [
      this.defaultSystemPrompt,
      options.system || '',
      '\n## Applicable Task Playbook:\n' + playbookContent,
      '\n## Applicable Principles:\n' + principlesText
    ].filter(Boolean).join('\n\n');

    // Resolve assigned model from ModelHitch (budget-aware, legacy fallback)
    const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    let targetModel = options.model;
    if (!targetModel) {
      try {
        const budgetMapping = resolveBudgetMapping({ tier: getStoredBudget().tier, source: getStoredBudget().source, state });
        targetModel = budgetMapping.models[roleName] || budgetMapping.models['feature, refactoring'];
      } catch {
        const mapping = resolveRoleMapping(state);
        targetModel = mapping.models[roleName] || mapping.models['feature, refactoring'];
      }
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt + filesContext }
    ];

    const chatRes = await sendChat({
      model: targetModel,
      messages,
      baseUrl: this.baseUrl,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs ?? this.timeoutMs
    });

    return {
      content: chatRes.content,
      model: chatRes.model,
      role: roleName,
      playbook: playbookType,
      principles: principleNames,
      classification: {
        type: classification.type,
        candidates: detailed.candidates || [],
        confidence: detailed.confidence ?? null,
        ambiguous: !!detailed.ambiguous
      },
      context: {
        estimatedTokens: contextPlan.estimatedTokens,
        budgetTokens: contextPlan.budgetTokens,
        trimmed: contextPlan.trimmed,
        omittedPrinciples: contextPlan.omittedPrinciples
      },
      contextNotes,
      usage: chatRes.usage,
      durationMs: chatRes.durationMs,
      raw: chatRes.raw
    };
  }

  /**
   * Run a prompt directly against an assigned role (budget-aware).
   */
  async runRole(role, prompt, options = {}) {
    if (options.model) {
      return await connectorRunRole(role, prompt, {
        ...options,
        baseUrl: this.baseUrl
      });
    }
    const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    try {
      const budgetMapping = resolveBudgetMapping({ tier: getStoredBudget().tier, source: getStoredBudget().source, state });
      const assignedModel = budgetMapping.models[role] || budgetMapping.models['feature, refactoring'];
      const messages = [
        ...(options.system ? [{ role: 'system', content: options.system }] : []),
        { role: 'user', content: prompt }
      ];
      const chatRes = await sendChat({ model: assignedModel, messages, baseUrl: this.baseUrl, temperature: options.temperature ?? 0.2, maxTokens: options.maxTokens, timeoutMs: options.timeoutMs ?? this.timeoutMs });
      return { content: chatRes.content, model: chatRes.model, usage: chatRes.usage, durationMs: chatRes.durationMs, raw: chatRes.raw };
    } catch {
      return await connectorRunRole(role, prompt, {
        ...options,
        baseUrl: this.baseUrl
      });
    }
  }

  /**
   * Run an adversarial panel critique across multiple distinct model families (budget-aware).
   */
  async panel(prompt, options = {}) {
    if (options.models) {
      return await connectorRunPanel(prompt, {
        ...options,
        baseUrl: this.baseUrl
      });
    }
    const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    try {
      const budgetMapping = resolveBudgetMapping({ tier: getStoredBudget().tier, source: getStoredBudget().source, state });
      return await connectorRunPanel(prompt, {
        ...options,
        models: budgetMapping.panelList,
        baseUrl: this.baseUrl
      });
    } catch {
      return await connectorRunPanel(prompt, {
        ...options,
        baseUrl: this.baseUrl
      });
    }
  }

  /**
   * Synchronize Cursor rule files with active ModelHitch models (budget-aware).
   */
  async syncRules(options = {}) {
    const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    const stored = getStoredBudget();
    try {
      const budget = resolveBudgetMapping({ tier: stored.tier, source: stored.source, state });
      return syncCursorRules({ mapping: { models: budget.models }, project: options.project, budget });
    } catch {
      const mapping = resolveRoleMapping(state);
      return syncCursorRules({ mapping, project: options.project });
    }
  }

  /**
   * Check upstream pstack repository on GitHub for changes on demand.
   */
  async checkUpstream(options = {}) {
    return await checkUpstream(options);
  }

  /**
   * Check and optionally update upstream pstack sync state.
   */
  async update(options = {}) {
    return await handleUpdateCommand(options);
  }
}

/**
 * Top-level factory and utility helpers.
 */
export function createZStack(options = {}) {
  return new ZStack(options);
}

export async function runTask(promptOrOptions) {
  const z = new ZStack();
  return await z.task(typeof promptOrOptions === 'string' ? { prompt: promptOrOptions } : promptOrOptions);
}

export async function runPanel(prompt, options = {}) {
  const z = new ZStack(options);
  return await z.panel(prompt, options);
}
