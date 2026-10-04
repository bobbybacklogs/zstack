import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BRIDGE_URL,
  checkBridgeHealth,
  fetchModelHitchState,
  resolveRoleMapping,
  sendChat,
  streamChat,
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
  LANES,
  getStoredBudget,
  saveStoredBudget,
  normalizeLane,
  resolveBudgetMapping
} from './budget.mjs';
import { classifyPromptSemantic, ROUTER_MIN_SCORE } from './router.mjs';
import { planContext, DEFAULT_CONTEXT_BUDGET_TOKENS } from './context.mjs';
import { parseDoc } from './manifest.mjs';
import { validateChatRequest, chatWireMessages, chatTimeoutMs } from './chat.mjs';
import { optimizePrompt as runOptimizePrompt, validateOptimizeRequest } from './optimize.mjs';
import {
  runHarnessTask,
  buildProgression,
  finalText,
  resolveHarnessEntry,
  failureReasonFromStderr
} from './harness.mjs';
import { packageSkill } from './skill.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT_DIR = join(__dirname, '..');

// Documents indexed without frontmatter (legacy extraction). Shipped playbooks
// and principles all carry frontmatter, so this only fills for user-authored
// documents; they are reported once per process as a single aggregated line
// rather than one line per file, which used to bury CLI output (e.g. --about).
const legacyExtractionSources = new Set();

/** Sources indexed so far via legacy extraction, in first-seen order. */
export function getLegacyExtractionSources() {
  return [...legacyExtractionSources];
}

/** Clear the legacy-extraction report (tests only). */
export function resetLegacyExtractionSources() {
  legacyExtractionSources.clear();
}

function reportLegacyExtraction(sources) {
  if (sources.length === 0) return;
  console.error(
    `[manifest] ${sources.length} document(s) without frontmatter, using legacy extraction: ${sources.join(', ')}`
  );
}

/** Record newly seen legacy sources and return only those not reported before. */
function trackLegacyExtraction(sources) {
  const fresh = [];
  for (const source of sources) {
    if (legacyExtractionSources.has(source)) continue;
    legacyExtractionSources.add(source);
    fresh.push(source);
  }
  return fresh;
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
 * Exported as the single source of truth for per-playbook principles, which the
 * frontmatter backfill script and the manifest drift test both consume.
 */
export const PLAYBOOK_TRIGGERS = [
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
    const mapping = await this.resolveRoleMapping(state);
    const budget = mapping.tierInfo ? mapping : null;
    return {
      ok: true,
      baseUrl: this.baseUrl,
      message: health.message,
      activeProviders: state.activeProviders,
      mode: mapping.mode,
      lane: budget?.lane ?? null,
      laneInfo: budget?.laneInfo ?? null,
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
   * Resolve the active role mapping from live gateway state, honoring a lane
   * override. Budget mapping is preferred; the connector's legacy resolver is
   * the documented fallback when budget resolution cannot run at all.
   */
  async resolveRoleMapping(state, lane = null) {
    try {
      return await this.getBudgetMapping(state, lane);
    } catch {
      const stored = getStoredBudget();
      return resolveRoleMapping(state, { lane: normalizeLane(lane || stored.lane) });
    }
  }

  /**
   * Resolve the active budget mapping against live ModelHitch state.
   * Pass a pre-fetched state to avoid an extra network round-trip, and a lane to
   * override the stored provider lane for this call only (used by --zen/--go/--hitch).
   */
  async getBudgetMapping(cachedState = null, lane = null) {
    const state = cachedState || await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    const stored = getStoredBudget();
    return resolveBudgetMapping({
      tier: stored.tier,
      source: stored.source,
      lane: lane || stored.lane,
      state
    });
  }

  /**
   * Persist a new budget tier, model source, and/or provider lane. Does not sync
   * Cursor rules by itself; call syncRules() afterwards or use the CLI `budget`
   * command which previews the mapping and requires explicit confirmation.
   */
  async setBudget(tier, source = null, lane = null) {
    if (!BUDGET_TIERS[tier]) {
      throw new Error(`Unknown budget tier: ${tier}. Valid tiers: ${Object.keys(BUDGET_TIERS).join(', ')}`);
    }
    const stored = getStoredBudget();
    const nextSource = source || stored.source || 'catalog';
    if (nextSource !== 'config' && nextSource !== 'catalog') {
      throw new Error(`Unknown budget source: ${nextSource}. Valid sources: config, catalog`);
    }
    const nextLane = normalizeLane(lane || stored.lane);
    const saved = saveStoredBudget({ tier, source: nextSource, lane: nextLane });
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
    const legacy = [];
    const list = readdirSync(playbooksDir)
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
        legacy.push(`playbooks/${file}`);
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
    reportLegacyExtraction(trackLegacyExtraction(legacy));
    return list;
  }

  /**
   * Get the dispatchable contents of a specific playbook: the document body with
   * any frontmatter stripped. Frontmatter is index metadata (id, applyWhen,
   * keywords) and would otherwise be billed as prompt tokens on every task.
   */
  getPlaybook(name) {
    const clean = name.replace(/\.md$/, '');
    const playbookPath = join(this.rootDir, 'playbooks', `${clean}.md`);
    if (!existsSync(playbookPath)) {
      throw new Error(`Playbook not found: ${clean} (searched ${playbookPath})`);
    }
    return parseDoc(readFileSync(playbookPath, 'utf8'), `playbooks/${clean}.md`).body;
  }

  /**
   * List all 20 principles (indexed via the manifest frontmatter contract;
   * documents without frontmatter use legacy extraction).
   */
  listPrinciples() {
    const principlesDir = join(this.rootDir, 'principles');
    if (!existsSync(principlesDir)) return [];
    const legacy = [];
    const list = readdirSync(principlesDir)
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
        legacy.push(`principles/${file}`);
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
    reportLegacyExtraction(trackLegacyExtraction(legacy));
    return list;
  }

  /**
   * Get the dispatchable contents of a specific principle: the document body
   * with any frontmatter stripped (see getPlaybook).
   */
  getPrinciple(name) {
    const clean = name.replace(/\.md$/, '');
    const principlePath = join(this.rootDir, 'principles', `${clean}.md`);
    if (!existsSync(principlePath)) {
      throw new Error(`Principle not found: ${clean} (searched ${principlePath})`);
    }
    return parseDoc(readFileSync(principlePath, 'utf8'), `principles/${clean}.md`).body;
  }

  /**
   * Package a playbook and its required principles into a SKILL.md document.
   */
  packageSkill(options) {
    return packageSkill({ rootDir: this.rootDir, ...options });
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

    // Resolve assigned model from ModelHitch (budget- and lane-aware, legacy fallback)
    const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    let targetModel = options.model;
    if (!targetModel) {
      const mapping = await this.resolveRoleMapping(state, options.lane);
      targetModel = mapping.models[roleName] || mapping.models['feature, refactoring'];
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
   * Run a prompt as an agentic task: the model gets tools, its calls execute,
   * and results feed back until the task is done or the turn budget runs out.
   *
   * `task()` is one completion and cannot change anything on disk. This is the
   * method to use when the prompt says to look at, change, or verify a project.
   * Execution is delegated to the ModelHitch harness, which owns the tool loop,
   * the approval gate, and snapshots; zstack still owns classification, playbook
   * and principle injection, and lane- or budget-aware model routing.
   *
   * Safety: without `apply`, a mutating tool call is declined rather than run,
   * so the default is a read-only investigation.
   */
  async agent(options) {
    const prompt = typeof options === 'string' ? options : options.prompt;
    if (!prompt) throw new Error('Agent prompt is required');

    const detailed = this.classifyPromptDetailed(prompt);
    const playbookType = options.playbook || options.type || detailed.type;
    const roleName = options.role || detailed.role;

    // Resolve the model exactly as `task()` does, so lanes and budget tiers
    // select the same model for an agentic run as for a single completion.
    let targetModel = options.model;
    if (!targetModel) {
      try {
        const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
        const mapping = await this.resolveRoleMapping(state, options.lane);
        targetModel = mapping.models[roleName] || mapping.models['feature, refactoring'];
      } catch {
        // A missing bridge must not block an agentic run: the harness resolves
        // the model from its own config. Lanes are a routing preference, and
        // ModelHitch is the authority on what is reachable.
        targetModel = undefined;
      }
    }

    const workspaceDir = options.workspaceDir || this.workspaceDir || process.cwd();
    const useZstackPrompt = options.noZstack !== true;

    const result = await runHarnessTask({
      prompt,
      model: targetModel,
      workspaceDir,
      apply: !!options.apply,
      maxTurns: options.maxTurns,
      review: !!options.review,
      autoApproveSafe: options.autoApproveSafe !== false,
      harnessArgs: options.harnessArgs,
      timeoutMs: options.timeoutMs ?? 0,
      signal: options.signal,
      // Sessions are saved by default so a run that exhausts its turn budget
      // can be continued rather than repeated. `resume` continues one.
      saveSession: options.saveSession !== false,
      resume: options.resume,
      onEvent: options.onEvent,
      onStderr: options.onStderr
    });

    const progression = buildProgression(result.events, {
      model: targetModel ?? null,
      maxTurns: options.maxTurns
    });

    return {
      /** The model's closing message: its answer, not its tool calls. */
      content: finalText(progression),
      /** Everything the model said across turns, in order. */
      narrative: progression.text.map((t) => String(t.text ?? '').trim()).filter(Boolean).join('\n\n'),
      /**
       * True when the loop stopped at the turn budget rather than the model
       * deciding it was done, which is why `content` can be empty.
       */
      turnLimitReached: progression.turnLimitReached,
      maxTurns: progression.maxTurns,
      model: progression.model,
      role: roleName,
      playbook: playbookType,
      principles: detailed.principles,
      classification: {
        type: detailed.type,
        candidates: detailed.candidates || [],
        confidence: detailed.confidence ?? null,
        ambiguous: !!detailed.ambiguous
      },
      applied: !!options.apply,
      workspaceDir,
      playbookInjected: useZstackPrompt,
      ok: result.ok,
      exitCode: result.exitCode,
      /**
       * The harness's own reason for a failed run, recovered from its stderr
       * transcript. Empty when the run succeeded or the harness gave no reason:
       * the caller falls back to its generic "exited non-zero" message rather
       * than inventing one.
       */
      errorText: result.ok ? null : failureReasonFromStderr(result.stderr),
      /** True when the caller aborted the run rather than the model failing. */
      cancelled: !!result.aborted,
      turns: progression.turns,
      toolCalls: progression.toolCount,
      failedTools: progression.failed,
      declinedTools: progression.declined,
      approvals: progression.approvals,
      changes: progression.changes,
      fileChanges: progression.fileChanges,
      steps: progression.steps,
      events: result.events,
      usage: progression.tokens == null ? null : { total_tokens: progression.tokens },
      durationMs: progression.durationMs,
      sessionId: progression.sessionId,
      malformedEvents: result.malformed,
      harness: { source: result.entry?.source ?? null, schema: result.schema ?? null }
    };
  }

  /**
   * List the models the gateway currently serves, for a chat pin picker.
   *
   * The catalogue is what the gateway says it can route; it is not a role
   * mapping. `null` when the bridge cannot be reached, so a caller can offer
   * the picker with an explanation instead of an error page.
   */
  async models() {
    try {
      const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
      return {
        connected: true,
        activeProviders: state.activeProviders,
        models: state.models
          .map((m) => (typeof m?.id === 'string' ? m.id : null))
          .filter(Boolean)
          .sort()
      };
    } catch (err) {
      return { connected: false, error: err?.message || String(err), models: [] };
    }
  }

  /**
   * One plain chat completion against a pinned model.
   *
   * This is a conversation, not a task: no playbook is injected, no tools are
   * offered, and nothing is written to history. The caller owns the transcript
   * and sends it whole on every turn, which is what stateless chat completions
   * expect. `sessionId` is optional and only forwarded as the gateway's
   * per-conversation header, so a provider that keys cache affinity on it sees
   * one conversation rather than a new one per message.
   *
   * With `onDelta`, the reply streams: the callback receives each text chunk as
   * it arrives and the resolved value is the same either way.
   */
  async chat(options = {}) {
    const problems = validateChatRequest(options);
    if (problems.length > 0) throw new Error(problems.join(' '));
    const call = {
      model: options.model,
      messages: chatWireMessages(options.messages),
      baseUrl: this.baseUrl,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      timeoutMs: chatTimeoutMs(options.timeoutMs, this.timeoutMs),
      signal: options.signal,
      headers: typeof options.sessionId === 'string' && options.sessionId !== ''
        ? { 'x-opencode-session': options.sessionId }
        : undefined
    };
    const chatRes = typeof options.onDelta === 'function'
      ? await streamChat({ ...call, onDelta: options.onDelta })
      : await sendChat(call);
    return {
      content: chatRes.content,
      model: chatRes.model,
      usage: chatRes.usage,
      durationMs: chatRes.durationMs,
      raw: chatRes.raw
    };
  }

  /**
   * Rewrite a raw request into a task prompt worth running.
   *
   * The prompt is classified first, so the rewrite knows which playbook it is
   * preparing for; the assigned role's model does the rewriting. The result is
   * text for the reader to review, not a dispatch: nothing is executed here.
   */
  async optimizePrompt(promptOrOptions, maybeOptions = {}) {
    const input = typeof promptOrOptions === 'string'
      ? { prompt: promptOrOptions, ...maybeOptions }
      : (promptOrOptions || {});
    const problems = validateOptimizeRequest(input);
    if (problems.length > 0) throw new Error(problems.join(' '));
    const raw = input.prompt.trim();

    const detailed = this.classifyPromptDetailed(raw);
    let playbookType = input.playbook || input.type || detailed.type;
    let roleName = input.role || detailed.role;
    let principles = input.principles || detailed.principles;

    if (!input.playbook && !input.type && detailed.ambiguous && input.semantic !== false) {
      try {
        const sem = await classifyPromptSemantic(raw, { baseUrl: this.baseUrl, rootDir: this.rootDir });
        if (sem && sem.score >= ROUTER_MIN_SCORE) {
          const rule = PLAYBOOK_TRIGGERS.find((r) => r.type === sem.type);
          if (rule) {
            playbookType = rule.type;
            roleName = rule.role;
            principles = rule.principles;
          }
        }
      } catch {
        // Semantic router degrades gracefully; keyword result stands.
      }
    }

    let playbookTitle = null;
    try {
      playbookTitle = this.listPlaybooks().find((p) => p.id === playbookType)?.title || null;
    } catch {
      playbookTitle = null;
    }

    let targetModel = input.model;
    if (!targetModel) {
      try {
        const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
        const mapping = await this.resolveRoleMapping(state, input.lane);
        targetModel = mapping.models[roleName] || mapping.models['feature, refactoring'];
      } catch {
        // The rewrite still runs on the gateway's default model when no
        // mapping can be resolved; a lane is a preference, not a requirement.
        targetModel = undefined;
      }
    }

    const result = await runOptimizePrompt(
      { prompt: raw, playbook: playbookType, playbookTitle, principles },
      {
        model: targetModel,
        baseUrl: this.baseUrl,
        timeoutMs: input.timeoutMs ?? this.timeoutMs,
        temperature: input.temperature,
        signal: input.signal,
        chat: input.chat
      }
    );
    return {
      ...result,
      original: raw,
      playbook: playbookType,
      role: roleName,
      principles
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
    const budgetMapping = await this.resolveRoleMapping(state, options.lane);
    const assignedModel = budgetMapping.models[role] || budgetMapping.models['feature, refactoring'];
    const messages = [
      ...(options.system ? [{ role: 'system', content: options.system }] : []),
      { role: 'user', content: prompt }
    ];
    const chatRes = await sendChat({ model: assignedModel, messages, baseUrl: this.baseUrl, temperature: options.temperature ?? 0.2, maxTokens: options.maxTokens, timeoutMs: options.timeoutMs ?? this.timeoutMs });
    return { content: chatRes.content, model: chatRes.model, usage: chatRes.usage, durationMs: chatRes.durationMs, raw: chatRes.raw };
  }

  /**
   * Run an adversarial panel critique across multiple distinct model families
   * (budget- and lane-aware).
   */
  async panel(prompt, options = {}) {
    if (options.models) {
      return await connectorRunPanel(prompt, {
        ...options,
        baseUrl: this.baseUrl
      });
    }
    const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    const budgetMapping = await this.resolveRoleMapping(state, options.lane);
    return await connectorRunPanel(prompt, {
      ...options,
      models: budgetMapping.panelList,
      baseUrl: this.baseUrl
    });
  }

  /**
   * Synchronize Cursor rule files with active ModelHitch models (budget- and
   * lane-aware).
   */
  async syncRules(options = {}) {
    const state = await fetchModelHitchState(this.baseUrl, { timeoutMs: this.timeoutMs });
    const budget = await this.resolveRoleMapping(state, options.lane);
    return syncCursorRules({ mapping: { models: budget.models }, project: options.project, budget });
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
