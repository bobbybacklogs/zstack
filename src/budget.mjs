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
 * Resolve role mapping based on the chosen budget tier and model source.
 */
export function resolveBudgetMapping({ tier = 'med-high', source = 'catalog', state }) {
  const normalizedTier = BUDGET_TIERS[tier.toLowerCase()] ? tier.toLowerCase() : 'med-high';
  const normalizedSource = source === 'config' ? 'config' : 'catalog';

  const { keys, models, config } = state;
  const hasOpenCode = !!(keys['opencode'] || keys['opencode-go'] || process.env.OPENCODE_API_KEY);
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
      if (modelIds.has(c)) return c;
    }
    return fallback;
  }

  let coderModel = defaultModel;
  let fastModel = defaultModel;
  let architectModel = defaultModel;
  let reasonerModel = defaultModel;
  let panelModels = [];

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
          panelModels = [flash, architectModel].filter((v, i, a) => a.indexOf(v) === i);
          break;
        }
        case 'med-high': {
          coderModel = configModels.find(m => /deepseek|pro|chat/i.test(m)) || configModels[0];
          fastModel = configModels.find(m => /flash|mini/i.test(m)) || coderModel;
          architectModel = configModels.find(m => /gpt-5|claude|sonnet|luna/i.test(m)) || configModels[0];
          reasonerModel = configModels.find(m => /gpt-5|r1|o3|o1/i.test(m)) || architectModel;
          panelModels = configModels.slice(0, 3);
          break;
        }
        case 'high':
        case 'max': {
          architectModel = configModels.find(m => /gpt-5|claude|sonnet|luna/i.test(m)) || configModels[0];
          reasonerModel = configModels.find(m => /gpt-5|r1|o3|o1/i.test(m)) || architectModel;
          coderModel = (normalizedTier === 'max' ? reasonerModel : configModels.find(m => /deepseek|pro|chat/i.test(m))) || configModels[0];
          fastModel = coderModel;
          panelModels = configModels.slice(0, 4);
          break;
        }
      }
    }
  }

  // =========================================================================
  // OPTION B: Active Provider Catalog Alignment (picks optimal tier models)
  // =========================================================================
  else {
    if (hasOpenCode) {
      switch (normalizedTier) {
        case 'low-med':
          coderModel = pickFirst(['opencode/deepseek-v4-flash', 'opencode/mimo-v2.6-flash'], 'opencode/deepseek-v4-flash');
          fastModel = coderModel;
          architectModel = pickFirst(['opencode/claude-sonnet-4-6', 'opencode/gpt-5.5'], 'opencode/claude-sonnet-4-6');
          reasonerModel = architectModel;
          panelModels = ['opencode/deepseek-v4-flash', 'opencode/claude-sonnet-4-6'];
          break;
        case 'med-high':
          coderModel = pickFirst(['opencode/deepseek-v4-pro', 'opencode-go/deepseek-v4-pro'], 'opencode/deepseek-v4-pro');
          fastModel = pickFirst(['opencode/deepseek-v4-flash'], 'opencode/deepseek-v4-flash');
          architectModel = pickFirst(['opencode/claude-sonnet-4-6', 'opencode/gpt-5.5'], 'opencode/claude-sonnet-4-6');
          reasonerModel = pickFirst(['opencode/gpt-5.5', 'opencode/claude-sonnet-4-6'], 'opencode/gpt-5.5');
          panelModels = ['opencode/claude-sonnet-4-6', 'opencode/gpt-5.5', 'opencode/deepseek-v4-pro'];
          break;
        case 'high':
          coderModel = pickFirst(['opencode/deepseek-v4-pro', 'opencode/kimi-k2.7-code'], 'opencode/deepseek-v4-pro');
          fastModel = coderModel;
          architectModel = pickFirst(['opencode/claude-sonnet-4-6'], 'opencode/claude-sonnet-4-6');
          reasonerModel = pickFirst(['opencode/gpt-5.5', 'opencode/claude-sonnet-4-6'], 'opencode/gpt-5.5');
          panelModels = ['opencode/claude-sonnet-4-6', 'opencode/gpt-5.5', 'opencode/qwen3.7-max'];
          break;
        case 'max':
          coderModel = pickFirst(['opencode/claude-sonnet-4-6', 'opencode/deepseek-v4-pro'], 'opencode/deepseek-v4-pro');
          fastModel = coderModel;
          architectModel = pickFirst(['opencode/claude-sonnet-4-6'], 'opencode/claude-sonnet-4-6');
          reasonerModel = pickFirst(['opencode/gpt-5.5'], 'opencode/gpt-5.5');
          panelModels = ['opencode/claude-sonnet-4-6', 'opencode/gpt-5.5', 'opencode/deepseek-v4-pro', 'opencode/qwen3.7-max'];
          break;
      }
    } else {
      // Multi-provider fallback (OpenAI, Gemini, DeepSeek, etc.)
      switch (normalizedTier) {
        case 'low-med':
          coderModel = pickFirst(['deepseek/deepseek-v4-flash', 'openai/gpt-4o-mini', 'gemini/models/gemini-3.6-flash']);
          fastModel = coderModel;
          architectModel = pickFirst(['gemini/models/gemini-3.6-flash', 'openai/gpt-4o-mini', 'deepseek/deepseek-v4-flash']);
          reasonerModel = architectModel;
          panelModels = [coderModel, architectModel].filter((v, i, a) => a.indexOf(v) === i);
          break;
        case 'med-high':
          coderModel = pickFirst(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-chat', 'openai/gpt-5.6-luna']);
          fastModel = pickFirst(['deepseek/deepseek-v4-flash', 'gemini/models/gemini-3.6-flash']);
          architectModel = pickFirst(['openai/gpt-5.6-luna', 'gemini/models/gemini-3.6-flash']);
          reasonerModel = pickFirst(['openai/gpt-5.6-luna', 'deepseek/deepseek-reasoner', 'gemini/models/gemini-3.6-flash']);
          panelModels = [];
          if (hasOpenAI) panelModels.push('openai/gpt-5.6-luna');
          if (hasGemini) panelModels.push('gemini/models/gemini-3.6-flash');
          if (hasDeepSeek) panelModels.push('deepseek/deepseek-v4-flash');
          break;
        case 'high':
          coderModel = pickFirst(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-chat', 'openai/gpt-5.6-luna']);
          fastModel = coderModel;
          architectModel = pickFirst(['openai/gpt-5.6-luna', 'gemini/models/gemini-3.6-flash']);
          reasonerModel = pickFirst(['openai/gpt-5.6-luna', 'deepseek/deepseek-reasoner']);
          panelModels = [];
          if (hasOpenAI) panelModels.push('openai/gpt-5.6-luna');
          if (hasGemini) panelModels.push('gemini/models/gemini-3.6-flash');
          if (hasDeepSeek) panelModels.push('deepseek/deepseek-v4-flash');
          break;
        case 'max':
          coderModel = pickFirst(['openai/gpt-5.6-luna', 'deepseek/deepseek-reasoner', 'deepseek/deepseek-v4-flash']);
          fastModel = coderModel;
          architectModel = pickFirst(['openai/gpt-5.6-luna']);
          reasonerModel = pickFirst(['openai/gpt-5.6-luna', 'deepseek/deepseek-reasoner']);
          panelModels = [];
          if (hasOpenAI) panelModels.push('openai/gpt-5.6-luna');
          if (hasGemini) panelModels.push('gemini/models/gemini-3.6-flash');
          if (hasDeepSeek) panelModels.push('deepseek/deepseek-v4-flash');
          break;
      }
    }
  }

  if (panelModels.length === 0) panelModels.push(defaultModel);
  const panelStr = panelModels.join(', ');

  return {
    tier: normalizedTier,
    tierInfo: BUDGET_TIERS[normalizedTier],
    source: normalizedSource,
    sourceDescription: BUDGET_SOURCES[normalizedSource],
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

  const state = options.state;
  const resolved = resolveBudgetMapping({
    tier: targetTier,
    source: targetSource,
    state
  });

  console.log(`\n=== zstack Model Budget Configuration ===`);
  console.log(`Selected Tier:    ${resolved.tierInfo.name.toUpperCase()} (${resolved.tierInfo.profile})`);
  console.log(`Model Selection:  ${resolved.source === 'config' ? 'Option A: ModelHitch Config Only' : 'Option B: Active Provider Catalog Alignment'}`);
  console.log(`Description:      ${resolved.tierInfo.description}`);

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
    saveStoredBudget({ tier: resolved.tier, source: resolved.source }, options.statePath);
    const rulePath = syncCursorRules({ mapping: { models: resolved.models }, budget: resolved, project: options.project });
    console.log(`\n[✓] Budget applied successfully!`);
    console.log(`    Budget Tier:  ${resolved.tierInfo.name}`);
    console.log(`    Source Mode:  ${resolved.source}`);
    console.log(`    Rule File:    ${rulePath}\n`);
    return { applied: true, budget: resolved, rulePath };
  } else {
    console.log('\nBudget change cancelled. Previous settings remain active.\n');
    return { applied: false, budget: resolved };
  }
}
