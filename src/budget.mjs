import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZSTACK_ROLES, syncCursorRules } from './connector.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_BUDGET_FILE = join(__dirname, '..', 'verification', 'budget.json');

export const BUDGET_TIERS = {
  'low-med': {
    name: 'Low-Med',
    description: 'Cost-optimized & fast. Uses lightweight flash/mini models; lowest token expense.',
    profile: 'Fastest iteration, lowest cost'
  },
  'med-high': {
    name: 'Med-High',
    description: 'Balanced engineering default. Fast coders paired with capable frontier reasoning.',
    profile: 'Standard production engineering'
  },
  'high': {
    name: 'High',
    description: 'High rigor. Frontier reasoning models across architecture, bug triage, and refactors.',
    profile: 'Complex architectures & critical paths'
  },
  'max': {
    name: 'Max',
    description: 'Maximum reasoning effort. Top-tier frontier reasoning across all tasks and panel reviews.',
    profile: 'Adversarial rigor & exhaustive verification'
  }
};

export const BUDGET_SOURCES = {
  'config': 'ModelHitch Config Only — strictly uses models pinned in your ModelHitch config policies',
  'catalog': 'Active Provider Alignment — uses active ModelHitch providers but picks best tier models from catalog'
};

/**
 * Provider lanes. A lane decides which provider family role models resolve from,
 * independently of the budget tier (which decides how much model to buy).
 *
 * - `zen`   OpenCode Zen, pay-per-use (`opencode/<model>`)
 * - `go`    OpenCode Go, flat-rate subscription (`opencode-go/<model>`);
 *           the Go endpoint also requires a per-conversation session header
 * - `hitch` No OpenCode preference: resolve from ModelHitch's active providers
 *           and its configured default model
 * - `auto`  Default. Zen when an OpenCode key is active, otherwise hitch.
 */
export const LANES = {
  'auto': {
    id: 'auto',
    name: 'Auto',
    prefix: null,
    description: 'Detect from active ModelHitch providers: OpenCode Zen when an OpenCode key is present, otherwise ModelHitch routing.'
  },
  'zen': {
    id: 'zen',
    name: 'OpenCode Zen',
    prefix: 'opencode/',
    description: 'OpenCode Zen pay-per-use models (opencode/<model>). Billed per token against your Zen balance.'
  },
  'go': {
    id: 'go',
    name: 'OpenCode Go',
    prefix: 'opencode-go/',
    description: 'OpenCode Go / Go Plus flat-rate subscription models (opencode-go/<model>).'
  },
  'hitch': {
    id: 'hitch',
    name: 'ModelHitch Auto',
    prefix: null,
    description: 'No OpenCode preference: use the active ModelHitch providers and its configured default model.'
  }
};

/** Accept alternate spellings so `--lane opencode-go` and `go` agree. */
const LANE_ALIASES = {
  'opencode': 'zen',
  'opencode-zen': 'zen',
  'opencode-go': 'go',
  'go-plus': 'go',
  'modelhitch': 'hitch',
  'multi': 'hitch'
};

/** Resolve a lane id (with aliases), falling back to `auto` on unknown input. */
export function normalizeLane(lane) {
  const raw = String(lane ?? '').trim().toLowerCase();
  if (!raw) return 'auto';
  const canonical = LANE_ALIASES[raw] || raw;
  return LANES[canonical] ? canonical : 'auto';
}

/** True when a lane value is a real lane or a documented alias ('' counts as auto). */
export function isKnownLane(lane) {
  const raw = String(lane ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !!(LANES[raw] || LANE_ALIASES[raw]);
}

/** Is any OpenCode key (Zen or Go) active in this ModelHitch state? */
export function hasOpenCodeKey(keys = {}) {
  return !!(keys['opencode'] || keys['opencode-go'] || process.env.OPENCODE_API_KEY);
}

/**
 * Read the current budget configuration.
 */
export function getStoredBudget(filePath = DEFAULT_BUDGET_FILE) {
  if (existsSync(filePath)) {
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      // fallback below
    }
  }
  return {
    tier: 'med-high',
    source: 'catalog',
    lane: 'auto',
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Save budget configuration to disk.
 */
export function saveStoredBudget(data, filePath = DEFAULT_BUDGET_FILE) {
  const current = getStoredBudget(filePath);
  const updated = {
    ...current,
    ...data,
    lastUpdated: new Date().toISOString()
  };
  writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  return updated;
}

/**
 * Resolve role mapping based on the chosen budget tier, model source, and lane.
 * `lane` selects the provider family (zen | go | hitch | auto); an explicit
 * `source: 'config'` overrides lane preference by pinning to ModelHitch policy.
 */
export function resolveBudgetMapping({ tier = 'med-high', source = 'catalog', lane = 'auto', state }) {
  const normalizedTier = BUDGET_TIERS[tier.toLowerCase()] ? tier.toLowerCase() : 'med-high';
  const normalizedSource = source === 'config' ? 'config' : 'catalog';
  const requestedLane = normalizeLane(lane);

  const { keys, models, config } = state;
  const hasOpenCode = hasOpenCodeKey(keys);
  const hasDeepSeek = !!(keys['deepseek'] || process.env.DEEPSEEK_API_KEY);
  const hasOpenAI = !!(keys['openai'] || process.env.OPENAI_API_KEY);
  const hasGemini = !!(keys['gemini'] || process.env.GEMINI_API_KEY);
  const hasVercel = !!(keys['vercel-ai-gateway'] || process.env.VERCEL_AI_GATEWAY_API_KEY);

  const modelIds = new Set((models || []).map(m => m.id));

  // Default fallback from config
  const defaultModel = config?.defaultProviderId && config?.defaultModel
    ? `${config.defaultProviderId}/${config.defaultModel}`
    : 'deepseek/deepseek-v4-flash';

  function pickFirst(candidates, fallback = defaultModel) {
    for (const c of candidates) {
      if (isServed(c)) return c;
    }
    return fallback;
  }

  /**
   * ModelHitch lists some families by bare model id (`deepseek-v4-flash`) while
   * routing accepts the provider-prefixed form (`deepseek/deepseek-v4-flash`).
   * Treat either spelling as served so availability filtering does not discard
   * models the gateway answers every day.
   */
  function isServed(id) {
    if (!id) return false;
    // ModelHitch's own configured default always routes; the catalog endpoint
    // under-reports some families (deepseek/* is served but never listed).
    if (id === defaultModel) return true;
    if (modelIds.size === 0) return true;
    if (modelIds.has(id)) return true;
    const segments = id.split('/');
    for (let i = 1; i < segments.length; i++) {
      if (modelIds.has(segments.slice(i).join('/'))) return true;
    }
    return false;
  }

  // `auto` keeps the historical detection: Zen when an OpenCode key is active,
  // otherwise ModelHitch routing. An explicit lane always wins.
  const resolvedLane = requestedLane === 'auto' ? (hasOpenCode ? 'zen' : 'hitch') : requestedLane;

  /**
   * Lane-aware pick. When the live catalog is unavailable the lane's canonical
   * candidates are trusted (the operator asked for that lane); when it is
   * available, only models the gateway actually serves are used.
   */
  function pickLane(candidates, laneDefault) {
    if (modelIds.size === 0) return candidates[0] ?? laneDefault;
    for (const c of candidates) {
      if (isServed(c)) return c;
    }
    if (isServed(laneDefault)) return laneDefault;
    return candidates.find(Boolean) ?? defaultModel;
  }

  let coderModel = defaultModel;
  let fastModel = defaultModel;
  let architectModel = defaultModel;
  let reasonerModel = defaultModel;
  let panelCandidates = [];

  // =========================================================================
  // OPTION A: Config-Only (strictly use models declared in ModelHitch config)
  // =========================================================================
  if (normalizedSource === 'config') {
    const trusted = config?.policy?.trusted || [];
    const configModels = [];
    for (const entry of trusted) {
      for (const m of entry.models || []) {
        configModels.push(`${entry.providerId}/${m}`);
      }
    }
    if (defaultModel && !configModels.includes(defaultModel)) {
      configModels.unshift(defaultModel);
    }

    if (configModels.length > 0) {
      switch (normalizedTier) {
        case 'low-med': {
          // Find flash, mini, or free models
          const flash = configModels.find(m => /flash|mini|free/i.test(m)) || configModels[0];
          coderModel = flash;
          fastModel = flash;
          architectModel = configModels.find(m => /gpt|gemini|sonnet|claude/i.test(m)) || flash;
          reasonerModel = architectModel;
          panelCandidates = [flash, architectModel].filter((v, i, a) => a.indexOf(v) === i);
          break;
        }
        case 'med-high': {
          coderModel = configModels.find(m => /deepseek|pro|chat/i.test(m)) || configModels[0];
          fastModel = configModels.find(m => /flash|mini/i.test(m)) || coderModel;
          architectModel = configModels.find(m => /gpt-5|gpt-6|claude|sonnet|luna/i.test(m)) || configModels[0];
          reasonerModel = configModels.find(m => /gpt-5|gpt-6|r1|o3|o1/i.test(m)) || architectModel;
          panelCandidates = configModels.slice(0, 3);
          break;
        }
        case 'high':
        case 'max': {
          architectModel = configModels.find(m => /gpt-5|gpt-6|claude|sonnet|luna/i.test(m)) || configModels[0];
          reasonerModel = configModels.find(m => /gpt-5|gpt-6|r1|o3|o1/i.test(m)) || architectModel;
          coderModel = (normalizedTier === 'max' ? reasonerModel : configModels.find(m => /deepseek|pro|chat/i.test(m))) || configModels[0];
          fastModel = coderModel;
          panelCandidates = configModels.slice(0, 4);
          break;
        }
      }
    }
  }

  // =========================================================================
  // OPTION B: Active Provider Catalog Alignment (picks optimal tier models)
  // =========================================================================
  else if (resolvedLane === 'go') {
    // OpenCode Go / Go Plus flat-rate catalog. No Claude on this lane; Luna and
    // Kimi carry architecture and reasoning duty.
    switch (normalizedTier) {
      case 'low-med':
        coderModel = pickLane(['opencode-go/deepseek-v4.1-flash', 'opencode-go/deepseek-v4-flash', 'opencode-go/mimo-v2.6-flash'], 'opencode-go/deepseek-v4-flash');
        fastModel = coderModel;
        architectModel = pickLane(['opencode-go/gpt-6-luna', 'opencode-go/gpt-5.6-luna'], 'opencode-go/gpt-6-luna');
        reasonerModel = architectModel;
        panelCandidates = [coderModel, architectModel].filter((v, i, a) => a.indexOf(v) === i);
        break;
      case 'med-high':
        coderModel = pickLane(['opencode-go/deepseek-v4-pro'], 'opencode-go/deepseek-v4-pro');
        fastModel = pickLane(['opencode-go/deepseek-v4-flash', 'opencode-go/deepseek-v4.1-flash'], 'opencode-go/deepseek-v4-flash');
        architectModel = pickLane(['opencode-go/gpt-5.6-luna', 'opencode-go/gpt-6-luna'], 'opencode-go/gpt-5.6-luna');
        reasonerModel = architectModel;
        panelCandidates = ['opencode-go/deepseek-v4-pro', 'opencode-go/gpt-5.6-luna', 'opencode-go/qwen3.8-max'];
        break;
      case 'high':
        coderModel = pickLane(['opencode-go/deepseek-v4-pro', 'opencode-go/kimi-k2.7-code'], 'opencode-go/deepseek-v4-pro');
        fastModel = coderModel;
        architectModel = pickLane(['opencode-go/gpt-5.6-luna', 'opencode-go/kimi-k3'], 'opencode-go/gpt-5.6-luna');
        reasonerModel = pickLane(['opencode-go/kimi-k3', 'opencode-go/gpt-5.6-luna'], 'opencode-go/kimi-k3');
        panelCandidates = ['opencode-go/deepseek-v4-pro', 'opencode-go/gpt-5.6-luna', 'opencode-go/glm-5.3'];
        break;
      case 'max':
        coderModel = pickLane(['opencode-go/kimi-k3', 'opencode-go/deepseek-v4-pro'], 'opencode-go/kimi-k3');
        fastModel = pickLane(['opencode-go/deepseek-v4-pro'], 'opencode-go/deepseek-v4-pro');
        architectModel = pickLane(['opencode-go/gpt-5.6-luna', 'opencode-go/kimi-k3'], 'opencode-go/gpt-5.6-luna');
        reasonerModel = pickLane(['opencode-go/kimi-k3', 'opencode-go/gpt-6-luna'], 'opencode-go/kimi-k3');
        panelCandidates = ['opencode-go/gpt-5.6-luna', 'opencode-go/kimi-k3', 'opencode-go/deepseek-v4-pro', 'opencode-go/qwen3.8-max'];
        break;
    }
  } else if (resolvedLane === 'zen') {
    // Ladders are ordered most-preferred first and filtered against the live
    // catalog, so delisted leaders fall through to whatever Zen serves today.
    switch (normalizedTier) {
      case 'low-med':
        coderModel = pickLane(['opencode/deepseek-v4-flash', 'opencode/deepseek-v4.1-flash', 'opencode/mimo-v2.6-flash-free'], 'opencode/deepseek-v4.1-flash');
        fastModel = coderModel;
        architectModel = pickLane(['opencode/claude-sonnet-4-6', 'opencode/claude-opus-5-5', 'opencode/gpt-5.6-luna', 'opencode/gpt-6-luna'], 'opencode/gpt-5.6-luna');
        reasonerModel = architectModel;
        panelCandidates = [coderModel, architectModel];
        break;
      case 'med-high':
        coderModel = pickLane(['opencode/deepseek-v4-pro'], 'opencode/deepseek-v4-pro');
        fastModel = pickLane(['opencode/deepseek-v4-flash', 'opencode/deepseek-v4.1-flash'], 'opencode/deepseek-v4.1-flash');
        architectModel = pickLane(['opencode/claude-sonnet-4-6', 'opencode/claude-opus-5-5', 'opencode/gpt-5.6-luna'], 'opencode/claude-opus-5-5');
        reasonerModel = pickLane(['opencode/gpt-5.5', 'opencode/gpt-6-sol', 'opencode/gpt-5.6-luna'], 'opencode/gpt-6-sol');
        panelCandidates = ['opencode/claude-opus-5-5', 'opencode/gpt-5.6-luna', 'opencode/deepseek-v4-pro'];
        break;
      case 'high':
        coderModel = pickLane(['opencode/deepseek-v4-pro', 'opencode/kimi-k2.7-code'], 'opencode/deepseek-v4-pro');
        fastModel = coderModel;
        architectModel = pickLane(['opencode/claude-sonnet-4-6', 'opencode/claude-opus-5-5'], 'opencode/claude-opus-5-5');
        reasonerModel = pickLane(['opencode/gpt-5.5', 'opencode/gpt-6-sol', 'opencode/gpt-5.6-luna'], 'opencode/gpt-6-sol');
        panelCandidates = ['opencode/claude-opus-5-5', 'opencode/gpt-5.6-luna', 'opencode/qwen3.8-max'];
        break;
      case 'max':
        coderModel = pickLane(['opencode/claude-sonnet-4-6', 'opencode/claude-opus-5-5', 'opencode/deepseek-v4-pro'], 'opencode/deepseek-v4-pro');
        fastModel = coderModel;
        architectModel = pickLane(['opencode/claude-sonnet-4-6', 'opencode/claude-opus-5-5'], 'opencode/claude-opus-5-5');
        reasonerModel = pickLane(['opencode/gpt-5.5', 'opencode/gpt-6-sol'], 'opencode/gpt-6-sol');
        panelCandidates = ['opencode/claude-opus-5-5', 'opencode/gpt-6-sol', 'opencode/deepseek-v4-pro', 'opencode/qwen3.8-max'];
        break;
    }
  } else {
    // Multi-provider lane: OpenAI, Gemini, DeepSeek, and any other active provider.
    switch (normalizedTier) {
      case 'low-med':
        coderModel = pickFirst(['deepseek/deepseek-v4-flash', 'openai/gpt-4o-mini', 'gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash']);
        fastModel = coderModel;
        architectModel = pickFirst(['gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash', 'openai/gpt-4o-mini', 'deepseek/deepseek-v4-flash']);
        reasonerModel = architectModel;
        panelCandidates = [coderModel, architectModel].filter((v, i, a) => a.indexOf(v) === i);
        break;
      case 'med-high':
        coderModel = pickFirst(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-chat', 'openai/gpt-5.6-luna']);
        fastModel = pickFirst(['deepseek/deepseek-v4-flash', 'gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash']);
        architectModel = pickFirst(['openai/gpt-5.6-luna', 'gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash']);
        reasonerModel = pickFirst(['openai/gpt-5.6-luna', 'deepseek/deepseek-reasoner', 'gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash']);
        panelCandidates = [];
        if (hasOpenAI) panelCandidates.push('openai/gpt-5.6-luna');
        if (hasGemini) panelCandidates.push('gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash');
        if (hasDeepSeek) panelCandidates.push('deepseek/deepseek-v4-flash');
        break;
      case 'high':
        coderModel = pickFirst(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-chat', 'openai/gpt-5.6-luna']);
        fastModel = coderModel;
        architectModel = pickFirst(['openai/gpt-5.6-luna', 'gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash']);
        reasonerModel = pickFirst(['openai/gpt-5.6-luna', 'deepseek/deepseek-reasoner']);
        panelCandidates = [];
        if (hasOpenAI) panelCandidates.push('openai/gpt-5.6-luna');
        if (hasGemini) panelCandidates.push('gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash');
        if (hasDeepSeek) panelCandidates.push('deepseek/deepseek-v4-flash');
        break;
      case 'max':
        coderModel = pickFirst(['openai/gpt-5.6-luna', 'deepseek/deepseek-reasoner', 'deepseek/deepseek-v4-flash']);
        fastModel = coderModel;
        architectModel = pickFirst(['openai/gpt-5.6-luna']);
        reasonerModel = pickFirst(['openai/gpt-5.6-luna', 'deepseek/deepseek-reasoner']);
        panelCandidates = [];
        if (hasOpenAI) panelCandidates.push('openai/gpt-5.6-luna');
        if (hasGemini) panelCandidates.push('gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash');
        if (hasDeepSeek) panelCandidates.push('deepseek/deepseek-v4-flash');
        break;
    }
  }

  // Distinct-family fallbacks for the panel. A one-model "panel" is not
  // adversarial, so a degenerate candidate set tops up from other active
  // provider families before settling for a single model.
  const familyPanel = [];
  if (hasOpenAI && isServed('openai/gpt-5.6-luna')) familyPanel.push('openai/gpt-5.6-luna');
  if (hasGemini) {
    for (const c of ['gemini/gemini-3.7-flash', 'gemini/models/gemini-3.6-flash']) {
      if (isServed(c)) {
        familyPanel.push(c);
        break;
      }
    }
  }
  if (hasDeepSeek) familyPanel.push(defaultModel);

  // Single finalize point. Panel members must exist in the live catalog because
  // panel dispatch sends each ID straight to the gateway with no per-model
  // fallback, so ad-libbing a delisted ID guarantees that member fails.
  const panelModels = [];
  const panelPool = modelIds.size === 0 ? panelCandidates : panelCandidates.filter(isServed);
  for (const m of panelPool) {
    if (m && !panelModels.includes(m)) panelModels.push(m);
  }
  // A one-model panel is not adversarial; top up from the resolved role models
  // and then from other active families.
  if (panelModels.length < 2) {
    for (const m of [coderModel, architectModel, reasonerModel, ...familyPanel]) {
      if (panelModels.length >= 2) break;
      if (m && !panelModels.includes(m)) panelModels.push(m);
    }
  }
  if (panelModels.length === 0) panelModels.push(defaultModel);
  const panelStr = panelModels.join(', ');

  const LANE_MODES = {
    'zen': 'opencode-zen',
    'go': 'opencode-go',
    'hitch': 'modelhitch-multi-provider'
  };

  return {
    tier: normalizedTier,
    tierInfo: BUDGET_TIERS[normalizedTier],
    source: normalizedSource,
    sourceDescription: BUDGET_SOURCES[normalizedSource],
    lane: resolvedLane,
    requestedLane,
    laneInfo: LANES[resolvedLane],
    mode: normalizedSource === 'config' ? 'modelhitch-config-pinned' : LANE_MODES[resolvedLane],
    // source: 'config' pins models from ModelHitch policy, so the lane choice
    // does not influence which models were selected.
    laneApplied: normalizedSource === 'catalog',
    models: {
      'feature, refactoring': coderModel,
      'bug-fix, perf-issue': coderModel,
      'fast exploration': fastModel,
      'judgment and prose': architectModel,
      'deep reasoning': reasonerModel,
      'how explorer': coderModel,
      'how explainer': architectModel,
      'how critics': panelStr,
      'why investigators': coderModel,
      'why synthesizer': architectModel,
      'reflect tooling': coderModel,
      'reflect synthesizer': architectModel,
      'arena runners': panelStr,
      'architect runners': panelStr,
      'interrogate reviewers': panelStr
    },
    panelList: panelModels
  };
}

/**
 * Interactive / CLI workflow to display, confirm beforehand, and apply a budget configuration.
 */
export async function promptAndSetBudget(options = {}) {
  const current = getStoredBudget(options.statePath);
  const targetTier = options.tier || current.tier || 'med-high';
  const targetSource = options.source || current.source || 'catalog';
  const targetLane = normalizeLane(options.lane || current.lane);

  const state = options.state;
  const resolved = resolveBudgetMapping({
    tier: targetTier,
    source: targetSource,
    lane: targetLane,
    state
  });

  console.log(`\n=== zstack Model Budget Configuration ===`);
  console.log(`Selected Tier:    ${resolved.tierInfo.name.toUpperCase()} (${resolved.tierInfo.profile})`);
  console.log(`Model Selection:  ${resolved.source === 'config' ? 'Option A: ModelHitch Config Only' : 'Option B: Active Provider Catalog Alignment'}`);
  console.log(`Provider Lane:    ${resolved.laneInfo.name}${resolved.requestedLane === 'auto' ? ' (auto-detected)' : ''}`);
  console.log(`Description:      ${resolved.tierInfo.description}`);
  if (!resolved.laneApplied) {
    console.log(`Note:             lane preference is inactive because source=config pins models from ModelHitch policy.`);
  }

  console.log('\nProposed Role-to-Model Mapping:');
  console.log('--------------------------------------------------------------------------------');
  for (const role of ZSTACK_ROLES) {
    const m = resolved.models[role];
    console.log(`  ${role.padEnd(25)} -> ${m}`);
  }
  console.log('--------------------------------------------------------------------------------');

  const autoConfirm = options.confirm || options.yes || options.apply;
  let isConfirmed = false;

  if (autoConfirm) {
    isConfirmed = true;
  } else if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\nConfirm and apply this budget mapping to Cursor rules? (y/N): ');
    rl.close();
    isConfirmed = answer.trim().toLowerCase() === 'y';
  } else {
    console.log('\nRun with --confirm (or -y) to apply this budget mapping without an interactive prompt.');
  }

  if (isConfirmed) {
    saveStoredBudget({ tier: resolved.tier, source: resolved.source, lane: resolved.requestedLane }, options.statePath);
    const rulePath = syncCursorRules({ mapping: { models: resolved.models }, budget: resolved, project: options.project });
    console.log(`\n[✓] Budget applied successfully!`);
    console.log(`    Budget Tier:  ${resolved.tierInfo.name}`);
    console.log(`    Source Mode:  ${resolved.source}`);
    console.log(`    Provider Lane: ${resolved.laneInfo.name}`);
    console.log(`    Rule File:    ${rulePath}\n`);
    return { applied: true, budget: resolved, rulePath };
  } else {
    console.log('\nBudget change cancelled. Previous settings remain active.\n');
    return { applied: false, budget: resolved };
  }
}
