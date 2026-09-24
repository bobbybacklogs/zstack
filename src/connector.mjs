import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_BRIDGE_URL = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';

export const ZSTACK_ROLES = [
  'feature, refactoring',
  'bug-fix, perf-issue',
  'fast exploration',
  'judgment and prose',
  'deep reasoning',
  'how explorer',
  'how explainer',
  'how critics',
  'why investigators',
  'why synthesizer',
  'reflect tooling',
  'reflect synthesizer',
  'arena runners',
  'architect runners',
  'interrogate reviewers'
];

/**
 * Check if the ModelHitch bridge daemon is running and healthy.
 */
export async function checkBridgeHealth(baseUrl = DEFAULT_BRIDGE_URL) {
  try {
    const res = await fetch(`${baseUrl}/healthz`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    return { ok: true, message: text.trim() };
  } catch (err) {
    return { ok: false, error: err.message || 'Cannot reach ModelHitch on ' + baseUrl };
  }
}

/**
 * Fetch active configuration and model catalog from ModelHitch.
 */
export async function fetchModelHitchState(baseUrl = DEFAULT_BRIDGE_URL) {
  const [configRes, modelsRes] = await Promise.all([
    fetch(`${baseUrl}/v1/config`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null),
    fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null)
  ]);

  const config = configRes || {};
  const models = Array.isArray(modelsRes?.data) ? modelsRes.data : [];
  const keys = config.keys || {};

  return {
    baseUrl,
    config,
    keys,
    models,
    activeProviders: Object.keys(keys).filter(k => !!keys[k])
  };
}

/**
 * Intelligently resolve the best model for each zstack role based on ModelHitch's active providers.
 * Prefers OpenCode if available, else falls back cleanly to Hitch's other active providers (DeepSeek, OpenAI, Gemini, etc.).
 */
export function resolveRoleMapping(state) {
  const { keys, models, config } = state;
  const hasOpenCode = !!(keys['opencode'] || keys['opencode-go'] || process.env.OPENCODE_API_KEY);
  const hasDeepSeek = !!(keys['deepseek'] || process.env.DEEPSEEK_API_KEY);
  const hasOpenAI = !!(keys['openai'] || process.env.OPENAI_API_KEY);
  const hasGemini = !!(keys['gemini'] || process.env.GEMINI_API_KEY);
  const hasVercel = !!(keys['vercel-ai-gateway'] || process.env.VERCEL_AI_GATEWAY_API_KEY);

  const modelIds = new Set(models.map(m => m.id));
  const defaultModel = config?.defaultProviderId && config?.defaultModel
    ? `${config.defaultProviderId}/${config.defaultModel}`
    : 'deepseek/deepseek-v4-flash';

  function pickModel(candidates, fallback) {
    for (const c of candidates) {
      if (modelIds.has(c)) return c;
    }
    return fallback;
  }

  // Determine role models
  let coderModel = defaultModel;
  let fastModel = defaultModel;
  let architectModel = defaultModel;
  let reasonerModel = defaultModel;

  if (hasOpenCode) {
    coderModel = 'opencode/deepseek-v4-pro';
    fastModel = 'opencode/deepseek-v4-flash';
    architectModel = 'opencode/claude-sonnet-4-6';
    reasonerModel = 'opencode/gpt-5.5';
  } else {
    // Pick Fast Coder
    if (hasDeepSeek) {
      coderModel = pickModel(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-chat'], coderModel);
      fastModel = pickModel(['deepseek/deepseek-v4-flash'], coderModel);
    } else if (hasOpenAI) {
      coderModel = pickModel(['openai/gpt-5.6-luna', 'openai/gpt-4o', 'openai/gpt-4o-mini'], coderModel);
      fastModel = pickModel(['openai/gpt-4o-mini', 'openai/gpt-5.6-luna'], coderModel);
    }

    // Pick Architect / Judgment
    if (hasOpenAI) {
      architectModel = pickModel(['openai/gpt-5.6-luna', 'openai/gpt-4o'], architectModel);
      reasonerModel = pickModel(['openai/gpt-5.6-luna', 'openai/o3', 'openai/o3-mini'], architectModel);
    } else if (hasGemini) {
      architectModel = pickModel(['gemini/models/gemini-3.6-flash', 'gemini/models/gemini-2.5-pro'], architectModel);
      reasonerModel = architectModel;
    } else if (hasDeepSeek) {
      architectModel = coderModel;
      reasonerModel = pickModel(['deepseek/deepseek-reasoner'], coderModel);
    }
  }

  // Construct Multi-Family Ensemble Panel (picks 1 model from each distinct provider family)
  const panelModels = [];
  if (hasOpenCode) {
    panelModels.push('opencode/claude-sonnet-4-6', 'opencode/gpt-5.5', 'opencode/deepseek-v4-pro');
  } else {
    if (hasOpenAI) panelModels.push('openai/gpt-5.6-luna');
    if (hasGemini) panelModels.push('gemini/models/gemini-3.6-flash');
    if (hasDeepSeek) panelModels.push('deepseek/deepseek-v4-flash');
    if (hasVercel && panelModels.length < 3) panelModels.push('vercel-ai-gateway/poolside/laguna-s-2.1-free');
  }
  if (panelModels.length === 0) panelModels.push(defaultModel);

  const panelStr = panelModels.join(', ');

  return {
    mode: hasOpenCode ? 'opencode-zen-go' : 'modelhitch-multi-provider',
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
 * Execute a completion request directly through ModelHitch.
 */
export async function sendChat({
  model,
  messages,
  temperature,
  maxTokens,
  baseUrl = DEFAULT_BRIDGE_URL
}) {
  const startTime = Date.now();
  
  // Some models (gpt-5.*, o1, o3, o4) only support default temperature (1) or reject custom temperature
  const isReasoningModel = /gpt-5|o[1-4]|reasoner/i.test(model);
  const body = {
    model,
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {})
  };
  
  if (!isReasoningModel && temperature !== undefined) {
    body.temperature = temperature;
  }

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const durationMs = Date.now() - startTime;
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`ModelHitch error (HTTP ${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content || '';
  const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return {
    content,
    model: data.model || model,
    usage,
    durationMs,
    raw: data
  };
}

/**
 * Run a prompt using a specific zstack role.
 */
export async function runRole(role, prompt, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BRIDGE_URL;
  const state = await fetchModelHitchState(baseUrl);
  const mapping = resolveRoleMapping(state);
  const assignedModel = mapping.models[role] || mapping.models['feature, refactoring'];

  const messages = [
    ...(options.system ? [{ role: 'system', content: options.system }] : []),
    { role: 'user', content: prompt }
  ];

  return await sendChat({
    model: assignedModel,
    messages,
    baseUrl,
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens
  });
}

/**
 * Run an adversarial review across the multi-family panel in parallel.
 */
export async function runPanel(prompt, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BRIDGE_URL;
  const state = await fetchModelHitchState(baseUrl);
  const mapping = resolveRoleMapping(state);
  const models = options.models || mapping.panelList;

  const messages = [
    {
      role: 'system',
      content: 'You are an adversarial engineering critic in zstack. Provide a rigorous, unslopped critique. Cite root causes, boundary discipline, and concrete failure modes. Avoid filler and praise.'
    },
    { role: 'user', content: prompt }
  ];

  const results = await Promise.allSettled(
    models.map(model => sendChat({ model, messages, baseUrl, temperature: 0.3 }))
  );

  return models.map((model, idx) => {
    const r = results[idx];
    if (r.status === 'fulfilled') {
      return {
        model,
        ok: true,
        content: r.value.content,
        usage: r.value.usage,
        durationMs: r.value.durationMs
      };
    } else {
      return {
        model,
        ok: false,
        error: r.reason?.message || 'Unknown error'
      };
    }
  });
}

/**
 * Synchronize local Cursor rules (~/.cursor/rules/zstack-models.mdc) with active ModelHitch models.
 */
export function syncCursorRules(options = {}) {
  const mapping = options.mapping;
  const targetDir = options.project
    ? join(process.cwd(), '.cursor', 'rules')
    : join(homedir(), '.cursor', 'rules');

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const filePath = join(targetDir, 'zstack-models.mdc');
  const lines = [
    '---',
    'description: zstack per-role model choices routed via ModelHitch (127.0.0.1:3939)',
    'alwaysApply: true',
    '---',
    '# zstack model configuration. Generated by zstack connector harness from active ModelHitch providers.'
  ];

  for (const role of ZSTACK_ROLES) {
    const m = mapping.models[role];
    if (m) {
      lines.push(`${role}: ${m}`);
    }
  }

  lines.push('');
  writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}
