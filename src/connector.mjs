import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hasHuggingFaceKey, loadHuggingFaceCapabilities, resolveHuggingFaceLane } from './hf.mjs';

export const DEFAULT_BRIDGE_URL = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';

/**
 * Gateway failure hardening: bounded timeouts plus retry for idempotent GETs.
 * Timeout default 30000ms, overridable per-call or via MODELHITCH_TIMEOUT.
 */
export const DEFAULT_GATEWAY_TIMEOUT_MS = 30000;
export const GATEWAY_MAX_ATTEMPTS = 3;
export const GATEWAY_BACKOFF_BASE_MS = 250;
export const GATEWAY_BACKOFF_CAP_MS = 2000;
/** Retry 429 (honoring Retry-After) and 502/503/504; never retry 400/401/403/404/422. */
export const GATEWAY_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export function resolveGatewayTimeoutMs(options = {}) {
  const raw = options.timeoutMs ?? process.env.MODELHITCH_TIMEOUT ?? DEFAULT_GATEWAY_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GATEWAY_TIMEOUT_MS;
}

/** Structured gateway failure: { kind, status, message, baseUrl, attempts }. */
export class GatewayError extends Error {
  constructor({ kind, status = null, message, baseUrl, attempts = 1 }) {
    super(message);
    this.name = 'GatewayError';
    this.kind = kind;
    this.status = status;
    this.baseUrl = baseUrl;
    this.attempts = attempts;
  }

  toJSON() {
    return { kind: this.kind, status: this.status, message: this.message, baseUrl: this.baseUrl, attempts: this.attempts };
  }
}

/** Parse Retry-After (seconds or HTTP date) into milliseconds; null when absent. */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return Math.max(0, t - nowMs);
  return null;
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.code === 20;
}

function backoffMs(attempt) {
  return Math.min(GATEWAY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), GATEWAY_BACKOFF_CAP_MS);
}

/**
 * Gateway fetch with per-request timeout (AbortController), bounded retry with
 * exponential backoff for idempotent GETs, and structured GatewayError failures.
 * POSTs (task/prompt/panel) are attempted exactly once — never auto-retried.
 *
 * Returns { data, status, attempts }; data parsed per options.parse
 * ('json' | 'text' | 'raw'). Throws GatewayError with kind
 * 'unreachable' | 'timeout' | 'http' | 'parse'.
 */
export async function gatewayFetch(url, options = {}) {
  const {
    method = 'GET',
    headers,
    body,
    timeoutMs,
    parse = 'json',
    baseUrl,
    fetchImpl
  } = options;
  const impl = fetchImpl || fetch;
  const timeout = resolveGatewayTimeoutMs({ timeoutMs });
  const canRetry = options.retry ?? (method === 'GET');
  const maxAttempts = canRetry ? GATEWAY_MAX_ATTEMPTS : 1;
  let attempts = 0;

  for (;;) {
    attempts++;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeout);
    if (timer.unref) timer.unref();
    try {
      const res = await impl(url, { method, headers, body, signal: controller.signal });
      if (res.status === 429 || GATEWAY_RETRYABLE_STATUS.has(res.status)) {
        let retryAfter = null;
        try {
          retryAfter = parseRetryAfterMs(res.headers?.get?.('retry-after'));
        } catch {
          retryAfter = null;
        }
        try { await res.text(); } catch {
          // Best-effort drain only; the body is discarded.
        }
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
        if (canRetry && attempts < maxAttempts) {
          const wait = retryAfter != null
            ? Math.min(Math.max(backoffMs(attempts), retryAfter), GATEWAY_BACKOFF_CAP_MS)
            : backoffMs(attempts);
          await delay(wait);
          continue;
        }
        throw new GatewayError({
          kind: 'http',
          status: res.status,
          message: `ModelHitch error (HTTP ${res.status})`,
          baseUrl,
          attempts
        });
      }
      if (!res.ok) {
        let snippet = '';
        try {
          snippet = (await res.text()).slice(0, 300);
        } catch {
          snippet = '';
        }
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
        throw new GatewayError({
          kind: 'http',
          status: res.status,
          message: `ModelHitch error (HTTP ${res.status})${snippet ? ': ' + snippet : ''}`,
          baseUrl,
          attempts
        });
      }
      try {
        const data = parse === 'text' ? await res.text() : parse === 'raw' ? res : await res.json();
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
        return { data, status: res.status, attempts };
      } catch (err) {
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
        if (isAbortError(err)) {
          throw new GatewayError({
            kind: 'timeout',
            status: res.status,
            message: `Request timed out after ${timeout}ms (mid-response body)`,
            baseUrl,
            attempts
          });
        }
        throw new GatewayError({
          kind: 'parse',
          status: res.status,
          message: `Malformed response body: ${err?.message || 'invalid JSON'}`,
          baseUrl,
          attempts
        });
      }
    } catch (err) {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
      if (err instanceof GatewayError) throw err;
      if (isAbortError(err)) {
        if (options.signal?.aborted) {
          throw new GatewayError({ kind: 'timeout', message: 'Request aborted', baseUrl, attempts });
        }
        if (canRetry && attempts < maxAttempts) {
          await delay(backoffMs(attempts));
          continue;
        }
        throw new GatewayError({
          kind: 'timeout',
          message: `Request timed out after ${timeout}ms`,
          baseUrl,
          attempts
        });
      }
      if (canRetry && attempts < maxAttempts) {
        await delay(backoffMs(attempts));
        continue;
      }
      throw new GatewayError({
        kind: 'unreachable',
        message: err?.message || `Cannot reach ModelHitch on ${baseUrl}`,
        baseUrl,
        attempts
      });
    }
  }
}

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
 * Retries idempotent GETs; failures carry { kind, status, attempts, baseUrl }.
 */
export async function checkBridgeHealth(baseUrl = DEFAULT_BRIDGE_URL, options = {}) {
  try {
    const { data } = await gatewayFetch(`${baseUrl}/healthz`, {
      method: 'GET',
      parse: 'text',
      baseUrl,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl
    });
    return { ok: true, message: String(data).trim() };
  } catch (err) {
    if (err instanceof GatewayError) {
      return { ok: false, error: err.message, kind: err.kind, status: err.status, attempts: err.attempts, baseUrl };
    }
    return { ok: false, error: err.message || 'Cannot reach ModelHitch on ' + baseUrl, kind: 'unreachable', status: null, attempts: 1, baseUrl };
  }
}

/**
 * Fetch active configuration and model catalog from ModelHitch.
 * Throws a structured GatewayError only when both endpoints fail; a single
 * failure degrades to that part's default so partial outages stay usable.
 *
 * When a HuggingFace key is active the state also carries `hfCapabilities`:
 * the router's per-model tool, context, price, and recency metadata, which the
 * gateway's own `/v1/models` does not publish. It is cached on disk, so this
 * costs one HTTP GET per cache window rather than one per call, and it never
 * throws: a failed fetch leaves `source: 'unavailable'` and the HuggingFace
 * lane falls back to its offline curation rules rather than failing. Pass
 * `hfCapabilities: false` to skip it entirely.
 */
export async function fetchModelHitchState(baseUrl = DEFAULT_BRIDGE_URL, options = {}) {
  const get = (path) => gatewayFetch(`${baseUrl}${path}`, {
    method: 'GET',
    parse: 'json',
    baseUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl
  }).then(
    r => ({ ok: true, data: r.data, attempts: r.attempts }),
    err => ({ ok: false, err })
  );

  const [configRes, modelsRes] = await Promise.all([get('/v1/config'), get('/v1/models')]);

  if (!configRes.ok && !modelsRes.ok) {
    const err = configRes.err instanceof GatewayError ? configRes.err : modelsRes.err;
    if (err instanceof GatewayError) throw err;
    throw new GatewayError({ kind: 'unreachable', message: err?.message || 'Cannot reach ModelHitch', baseUrl, attempts: 1 });
  }

  const config = configRes.ok ? configRes.data || {} : {};
  const modelsData = modelsRes.ok ? modelsRes.data : null;
  const models = Array.isArray(modelsData?.data) ? modelsData.data : [];
  const keys = config.keys || {};

  let hfCapabilities = null;
  if (options.hfCapabilities !== false && hasHuggingFaceKey(keys)) {
    hfCapabilities = await loadHuggingFaceCapabilities({
      cachePath: options.hfCapabilitiesPath,
      refresh: options.refreshHfCapabilities === true,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs
    });
  }

  return {
    baseUrl,
    config,
    keys,
    models,
    activeProviders: Object.keys(keys).filter(k => !!keys[k]),
    hfCapabilities
  };
}

/**
 * Intelligently resolve the best model for each zstack role based on ModelHitch's active providers.
 * Prefers OpenCode if available, else falls back cleanly to Hitch's other active providers (DeepSeek, OpenAI, Gemini, etc.).
 *
 * Pass `lane` ('zen' | 'go' | 'hitch' | 'hf' | 'auto') to force a provider family:
 * 'zen' uses opencode/<model>, 'go' uses opencode-go/<model>, 'hitch' skips
 * OpenCode entirely, and 'hf' resolves from the HuggingFace catalogue through
 * the same quality filter the budget resolver uses. 'auto' (the default) keeps
 * the detection above.
 */
export function resolveRoleMapping(state, options = {}) {
  const { keys, models, config } = state;
  const hasOpenCodeKey = !!(keys['opencode'] || keys['opencode-go'] || process.env.OPENCODE_API_KEY);
  const hasDeepSeek = !!(keys['deepseek'] || process.env.DEEPSEEK_API_KEY);
  const hasOpenAI = !!(keys['openai'] || process.env.OPENAI_API_KEY);
  const hasGemini = !!(keys['gemini'] || process.env.GEMINI_API_KEY);
  const hasVercel = !!(keys['vercel-ai-gateway'] || process.env.VERCEL_AI_GATEWAY_API_KEY);

  const requested = String(options.lane || 'auto').toLowerCase();
  const lane = requested === 'auto'
    ? (hasOpenCodeKey ? 'zen' : 'hitch')
    : (requested === 'zen' || requested === 'go' || requested === 'hitch' || requested === 'hf' ? requested : 'zen');
  const hasOpenCode = lane !== 'hitch' && lane !== 'hf';
  const prefix = lane === 'go' ? 'opencode-go/' : 'opencode/';

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

  if (lane === 'go') {
    coderModel = `${prefix}deepseek-v4-pro`;
    fastModel = `${prefix}deepseek-v4-flash`;
    architectModel = `${prefix}gpt-5.6-luna`;
    reasonerModel = `${prefix}kimi-k3`;
  } else if (lane === 'zen') {
    coderModel = `${prefix}deepseek-v4-pro`;
    fastModel = `${prefix}deepseek-v4-flash`;
    architectModel = `${prefix}claude-sonnet-4-6`;
    reasonerModel = `${prefix}gpt-5.5`;
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
  if (lane === 'hf') {
    // The HuggingFace filter owns this lane's picks, including the panel. It is
    // the same call the budget resolver makes, so the legacy path cannot pick a
    // model the curated path would have rejected.
    const hfLane = resolveHuggingFaceLane(models.map(m => m.id), {
      tier: options.tier || 'med-high',
      capabilities: state.hfCapabilities?.models || null,
      capabilitySource: state.hfCapabilities?.source || 'unavailable'
    });
    if (hfLane.applied) {
      coderModel = hfLane.coder;
      fastModel = hfLane.fast;
      architectModel = hfLane.architect;
      reasonerModel = hfLane.reasoner;
      panelModels.push(...hfLane.panel);
    } else {
      // Nothing survived the filter: fall back to plain ModelHitch routing
      // rather than pinning a HuggingFace model the filter rejected.
      if (hasOpenAI) panelModels.push('openai/gpt-5.6-luna');
      if (hasGemini) panelModels.push('gemini/models/gemini-3.6-flash');
      if (hasDeepSeek) panelModels.push('deepseek/deepseek-v4-flash');
    }
  } else if (lane === 'go') {
    panelModels.push(`${prefix}deepseek-v4-pro`, `${prefix}gpt-5.6-luna`, `${prefix}qwen3.8-max`);
  } else if (lane === 'zen') {
    panelModels.push(`${prefix}claude-sonnet-4-6`, `${prefix}gpt-5.5`, `${prefix}deepseek-v4-pro`);
  } else {
    if (hasOpenAI) panelModels.push('openai/gpt-5.6-luna');
    if (hasGemini) panelModels.push('gemini/models/gemini-3.6-flash');
    if (hasDeepSeek) panelModels.push('deepseek/deepseek-v4-flash');
    if (hasVercel && panelModels.length < 3) panelModels.push('vercel-ai-gateway/poolside/laguna-s-2.1-free');
  }
  if (panelModels.length === 0) panelModels.push(defaultModel);

  const panelStr = panelModels.join(', ');
  const MODES = { zen: 'opencode-zen', go: 'opencode-go', hitch: 'modelhitch-multi-provider', hf: 'huggingface-router' };

  return {
    mode: MODES[lane] || (hasOpenCode ? 'opencode-zen-go' : 'modelhitch-multi-provider'),
    lane,
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
 * The chat-completions request body, shared by the streaming and non-streaming
 * paths so the two can never send different parameters for the same call.
 *
 * Some models (gpt-5.*, o1, o3, o4, deepseek-reasoner) reject a custom
 * temperature, so it is only attached for models that accept one.
 */
function buildChatBody({ model, messages, temperature, maxTokens, stream = false }) {
  const isReasoningModel = /gpt-5|o[1-4]|reasoner/i.test(model);
  return {
    model,
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(stream ? { stream: true } : {}),
    ...(!isReasoningModel && temperature !== undefined ? { temperature } : {})
  };
}

/**
 * Execute a completion request directly through ModelHitch.
 * POSTs are attempted exactly once — never auto-retried.
 */
export async function sendChat({
  model,
  messages,
  temperature,
  maxTokens,
  baseUrl = DEFAULT_BRIDGE_URL,
  timeoutMs,
  fetchImpl,
  signal,
  headers
}) {
  const startTime = Date.now();

  const { data, attempts } = await gatewayFetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    // Caller headers (a per-conversation session id) ride alongside the body
    // type rather than in place of it; the gateway normalizes session handling
    // across providers, but only when it receives the header.
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(buildChatBody({ model, messages, temperature, maxTokens })),
    parse: 'json',
    baseUrl,
    timeoutMs,
    fetchImpl,
    signal
  });

  const durationMs = Date.now() - startTime;
  const choice = data.choices?.[0];
  const content = choice?.message?.content || '';
  const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return {
    content,
    model: data.model || model,
    usage,
    durationMs,
    attempts,
    raw: data
  };
}

/** The empty usage a stream reports when the provider sent none. */
const EMPTY_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/**
 * The text a single streaming chunk carries, or '' when it carries none.
 *
 * Providers differ: most send `choices[0].delta.content` as a string, some send
 * it as an array of parts, and a few emit the whole message shape on a
 * non-streamed frame. Only the text is read; reasoning deltas are not part of
 * the answer and are dropped.
 */
function deltaText(chunk) {
  const choice = chunk?.choices?.[0];
  const raw = choice?.delta?.content ?? choice?.message?.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

/**
 * Stream one completion, feeding text deltas to `onDelta` as they arrive.
 *
 * Resolves with the same shape `sendChat` returns once the stream ends. This is
 * a single POST whose response body is read incrementally; there is no retry,
 * because a stream that failed halfway cannot be restarted at the same place.
 *
 * Not every model honours `stream: true`. When the gateway answers with JSON
 * instead of `text/event-stream`, the whole reply is parsed and handed over as
 * one delta, so a caller gets text either way rather than an empty answer.
 */
export async function streamChat({
  model,
  messages,
  temperature,
  maxTokens,
  baseUrl = DEFAULT_BRIDGE_URL,
  timeoutMs,
  fetchImpl,
  signal,
  headers,
  onDelta
}) {
  const impl = fetchImpl || fetch;
  const timeout = resolveGatewayTimeoutMs({ timeoutMs });
  const startTime = Date.now();
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeout);
  if (timer.unref) timer.unref();

  const cleanup = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  };

  try {
    const res = await impl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(buildChatBody({ model, messages, temperature, maxTokens, stream: true })),
      signal: controller.signal
    });

    if (!res.ok) {
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 300);
      } catch {
        snippet = '';
      }
      throw new GatewayError({
        kind: 'http',
        status: res.status,
        message: `ModelHitch error (HTTP ${res.status})${snippet ? ': ' + snippet : ''}`,
        baseUrl,
        attempts: 1
      });
    }

    const contentType = res.headers?.get?.('content-type') || '';
    if (!/text\/event-stream/i.test(contentType)) {
      // The provider ignored `stream`. Parse the whole body and hand it over as
      // one delta so the caller still gets the reply.
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      if (content && onDelta) onDelta(content);
      return {
        content,
        model: data.model || model,
        usage: data.usage || EMPTY_USAGE,
        durationMs: Date.now() - startTime,
        attempts: 1,
        raw: data
      };
    }

    let content = '';
    let usage = null;
    let modelName = model;
    let lastChunk = null;
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = '';

    // One SSE frame is a run of `data:` lines ended by a blank line. Frames are
    // consumed as they close so a delta is delivered the moment it lands rather
    // than when the next frame arrives.
    const handleFrame = (frame) => {
      const dataLines = [];
      for (const line of frame.split('\n')) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trimStart());
      }
      if (dataLines.length === 0) return false;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') return true;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return false;
      }
      lastChunk = chunk;
      if (typeof chunk.model === 'string' && chunk.model !== '') modelName = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const text = deltaText(chunk);
      if (text) {
        content += text;
        if (onDelta) onDelta(text);
      }
      return false;
    };

    let done = false;
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      // CRLF is normalized away so frames split on a plain blank line; a raw CR
      // never appears inside an SSE data payload.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (handleFrame(frame)) {
          done = true;
          break;
        }
      }
      if (done) break;
    }
    if (!done && buffer.trim() !== '') handleFrame(buffer);

    // A stream that carried no usage (the common case) reports none rather than
    // zeros, so a caller can tell "not reported" from "nothing spent".
    return {
      content,
      model: modelName,
      usage: usage || EMPTY_USAGE,
      durationMs: Date.now() - startTime,
      attempts: 1,
      raw: lastChunk
    };
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    if (isAbortError(err)) {
      throw new GatewayError({
        kind: 'timeout',
        message: signal?.aborted ? 'Request aborted' : `Request timed out after ${timeout}ms`,
        baseUrl,
        attempts: 1
      });
    }
    throw new GatewayError({
      kind: 'unreachable',
      message: err?.message || `Cannot reach ModelHitch on ${baseUrl}`,
      baseUrl,
      attempts: 1
    });
  } finally {
    cleanup();
  }
}

/**
 * Run a prompt using a specific zstack role.
 */
export async function runRole(role, prompt, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BRIDGE_URL;
  const state = await fetchModelHitchState(baseUrl, { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl });
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
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    signal: options.signal
  });
}

/**
 * Run an adversarial review across the multi-family panel in parallel.
 * Per-model failures are reported with ok:false plus errorKind; the panel
 * as a whole never throws because one family failed.
 */
export async function runPanel(prompt, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BRIDGE_URL;
  const state = await fetchModelHitchState(baseUrl, { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl });
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
    models.map(model => sendChat({ model, messages, baseUrl, temperature: 0.3, timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl, signal: options.signal }))
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
        error: r.reason?.message || 'Unknown error',
        errorKind: r.reason?.kind || 'unknown'
      };
    }
  });
}

/**
 * Synchronize local Cursor rules (~/.cursor/rules/zstack-models.mdc) with active ModelHitch models.
 */
export function syncCursorRules(options = {}) {
  const mapping = options.mapping;
  const budget = options.budget || null;
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

  if (budget) {
    lines.push(`# Budget tier: ${budget.tier} (${budget.tierInfo?.name || budget.tier}) | Source: ${budget.source}`);
  }

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
