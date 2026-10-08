import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * The HuggingFace lane.
 *
 * HuggingFace's inference router serves hundreds of chat models, published by
 * anyone from frontier labs to anonymous fine-tuners. That is unlike the
 * OpenCode lanes, whose catalogues are curated by a vendor, and it means the
 * lane cannot pin hand-written ladders the way `zen` and `go` do: a
 * hand-written ladder over a churning open catalogue rots silently.
 *
 * So the lane pins nothing by hand. It filters first, then pins from what
 * survived. The filter is the curation, and every decision it makes is
 * reported with a reason, so a surprising pick can be traced to the rule that
 * allowed it.
 *
 * Filtering is layered so that it degrades honestly:
 *
 *   1. Capability gates (from the router's public model listing) drop models
 *      that cannot do zstack's work at all: no tool calling, too small a
 *      context window, no live provider, not a text model. This layer needs
 *      the network once per cache window, and its absence never invents a
 *      fact: an unfetched capability is reported as `unavailable`, not
 *      assumed good.
 *   2. Curation gates (from the model id alone) drop non-chat models, base
 *      checkpoints, quantized and dated duplicates of a model already in the
 *      list, and the tiny tail. This layer always runs, offline included.
 *   3. Ranking orders the survivors per role, using size, recency, context,
 *      cost, and speed. Cost matters more on the cheap tiers and not at all
 *      on `max`, where the question is only which model is best.
 *
 * The listing itself is public (`https://router.huggingface.co/v1/models`),
 * so the filter needs no token even though inference does. Inference is not
 * zstack's business here: the lane rides the ModelHitch gateway, which holds
 * the HuggingFace key, exactly like every other lane.
 */

/** Provider id ModelHitch uses for its HuggingFace router lane. */
export const HF_PROVIDER_ID = 'huggingface';
/** Every HuggingFace model id carries this prefix on the gateway wire. */
export const HF_PREFIX = 'huggingface/';
/** The router's own listing, which carries the per-model capability metadata. */
export const HF_MODELS_URL = 'https://router.huggingface.co/v1/models';

/**
 * Where the capability metadata is cached.
 *
 * Deliberately in `~/.zstack` beside chats, projects, and schedules, rather
 * than in the repository: what it records is which providers are live and what
 * they charge *on this machine, today*, which has nothing to do with the
 * checkout it happens to run from. A cache inside the repo would also leave a
 * 50 KB file churning in every working tree.
 */
export const HF_CAPABILITY_CACHE = process.env.ZSTACK_HF_CAPABILITIES_PATH
  || join(homedir(), '.zstack', 'hf-capabilities.json');
/** Capability metadata is a quality input, not a routing fact: it expires. */
export const HF_CAPABILITY_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A model must take the context zstack actually sends: the default context
 * budget is 12000 tokens of files plus the playbook and principles, and the
 * tool loop grows from there when it is truncated rather than refused.
 */
export const HF_MIN_CONTEXT_TOKENS = 32000;

/**
 * Recognized first-party model publishers, best-first.
 *
 * The lane is only as good as this list. It is an allowlist rather than a
 * denylist on purpose: with an open catalogue the unknown publishers vastly
 * outnumber the known ones, and a denylist would have to enumerate them all.
 * An unrecognized publisher is excluded with its name in the report, so
 * adding one is a one-line edit here rather than a mystery.
 *
 * Order is a preference for ranking and a tie-break, not a benchmark claim.
 * The tiers are: frontier labs whose models this repo already trusts on other
 * lanes, then capable general publishers, then strong smaller publishers.
 */
export const HF_PUBLISHERS = [
  'deepseek-ai',
  'Qwen',
  'moonshotai',
  'zai-org',
  'MiniMaxAI',
  'nvidia',
  'openai',
  'google',
  'meta-llama',
  'microsoft',
  'mistralai',
  'stepfun-ai',
  'inclusionAI',
  'XiaomiMiMo',
  'tencent',
  'CohereLabs',
  'ibm-granite'
];

/** Index of a publisher in the trust list, or -1 when unrecognized. */
export function hfPublisherRank(org) {
  return HF_PUBLISHERS.indexOf(String(org || ''));
}

/**
 * Id-only exclusions. Each rule names the thing it removes and why, because
 * the reasons are rendered verbatim in `zstack hf` and on the filter report.
 */
export const HF_TASK_EXCLUSIONS = [
  { id: 'guard', re: /(guard|safeguard|moderation|shieldgemma)/i, reason: 'safety classifier, not a chat model' },
  { id: 'translate', re: /(translate|translation|-mt-|bielik)/i, reason: 'translation model' },
  { id: 'speech', re: /(whisper|tts|asr|speech|voice|audio)/i, reason: 'speech model' },
  { id: 'embedding', re: /(embed|rerank|bge-|e5-)/i, reason: 'embedding or reranker model' },
  { id: 'image', re: /(stable-diffusion|flux|sdxl|image-gen|vision-encoder)/i, reason: 'image model' },
  { id: 'guard-vision', re: /(llama-guard)/i, reason: 'safety classifier, not a chat model' },
  { id: 'phone', re: /(phone|tiny-aya|smollm)/i, reason: 'on-device toy model' },
  { id: 'preview', re: /(-exp\b|experimental|preview|beta\b|-rl\b|nightly)/i, reason: 'preview or experimental build' },
  // Vision builds carry the marker in three spellings: a `-VL-` segment
  // (`Qwen3-VL-235B`), a `V` glued to the version (`GLM-4.5V`), or the word
  // itself. `\dv` needs the lookahead, or a version segment like `Bielik-v3`
  // would read as a vision model.
  { id: 'vision-only', re: /(vision|multimodal|(?:^|[-_])vl(?:[-_]|$)|\dv(?=[-_]|$))/i, reason: 'vision-specialized build' },
  { id: 'regional', re: /(sea-lion|aya-|-arabic|-fin\b|-multilingual$)/i, reason: 'regional or multilingual-specialized build' }
];

/** Quantized or re-exported builds of a model that is also listed plainly. */
export const HF_VARIANT_SUFFIX = /(-fp8|-bf16|-fp16|-nvfp4|-awq(-\d+bit)?|-gguf|-int[48]|-\d+bit|-ternary|\.gguf)$/i;

/** Community fine-tunes that are chat roleplay rather than engineering models. */
export const HF_FINETUNE_EXCLUSIONS = [
  { id: 'roleplay', re: /(stheno|lunaris|wizardlm|hermes|airoboros|dolphin|nous-|mythomax|goliath|euryale|psyfighter|chronos-hermes)/i, reason: 'community roleplay fine-tune' }
];

/** Size floors per tier, in billions of total parameters. */
export const HF_TIER_SIZE_FLOOR = {
  'low-med': 9,
  'med-high': 14,
  'high': 20,
  'max': 30
};

/**
 * Names that mark a speed-optimized variant of a stronger family. The "fast
 * exploration" role wants one of these, not merely the cheapest model in the
 * list: an 8B model from two generations ago is cheap and quick and still the
 * wrong answer.
 */
export const HF_FAST_MARKER = /(flash|mini|air|lite|small|turbo|nano)/i;

/**
 * How many of the best-scoring models count as top picks. The "fast" role is
 * chosen from these, so the pool is a rank rather than a score margin: a margin
 * widens as scores cluster and starts admitting models that are only nominally
 * near the top.
 */
export const HF_FAST_POOL_SIZE = 6;

/** Ceiling on the cost penalty, so price can reorder the near-best, not sink them. */
export const HF_COST_PENALTY_CAP = 20;

/**
 * Bonus for the newest generation a publisher ships in a naming line.
 *
 * The capability metadata carries release dates, but it is a network fetch and
 * may be absent, and without some staleness signal the ranking falls back on
 * publisher and size alone: an old reasoning model then outranks the current
 * flagship because both are "unrated, first-party". A generation number in the
 * name is available offline and is exactly the signal needed, so the newest
 * generation of each publisher is preferred whether or not the metadata
 * arrived. It is a heuristic on a name, which is why it is a modest bonus
 * rather than a gate.
 */
export const HF_GENERATION_BONUS = 6;

/**
 * Per-tier weighting. Cheap tiers care about price and speed; `max` cares only
 * about capability, so cost stops counting entirely there. The cost weight is
 * what makes the tiers differ at all on this lane: without it the expensive
 * flagship wins every tier and the cheap tiers stop being cheap.
 */
export const HF_TIER_WEIGHTS = {
  'low-med': { cost: 2, speed: 1, recency: 0.6 },
  'med-high': { cost: 0.5, speed: 0.7, recency: 0.8 },
  'high': { cost: 0.15, speed: 0.5, recency: 1 },
  'max': { cost: 0, speed: 0.3, recency: 1 }
};

/** Name-level affinity for the coding role, and for the reasoning role. */
export const HF_CODING_SIGNALS = [
  { re: /cod(er|e)/i, weight: 14, reason: 'code-specialized' },
  { re: /deepseek-v[34]/i, weight: 12, reason: 'deepseek coding family' },
  { re: /glm-5/i, weight: 10, reason: 'GLM engineering family' },
  { re: /kimi-k[23]/i, weight: 10, reason: 'Kimi agentic family' },
  { re: /minimax-m[23]/i, weight: 8, reason: 'MiniMax agentic family' },
  { re: /qwen3(\.[5-9])?/i, weight: 7, reason: 'Qwen general family' },
  { re: /gpt-oss/i, weight: 6, reason: 'open-weight GPT family' },
  { re: /nemotron/i, weight: 6, reason: 'Nemotron family' },
  { re: /ling-/i, weight: 5, reason: 'Ling family' },
  { re: /-pro\b/i, weight: 8, reason: 'pro variant' },
  { re: /-flash\b/i, weight: -4, reason: 'flash variant (cheaper, weaker)' },
  { re: /-mini\b/i, weight: -6, reason: 'mini variant (cheaper, weaker)' }
];

export const HF_REASONING_SIGNALS = [
  { re: /(think|reason|r1\b)/i, weight: 12, reason: 'reasoning-tuned' },
  { re: /deepseek-v4-pro/i, weight: 12, reason: 'flagship reasoner family' },
  { re: /glm-5\.[23]/i, weight: 10, reason: 'GLM flagship family' },
  { re: /kimi-k3/i, weight: 10, reason: 'Kimi flagship family' },
  { re: /qwen3\.[568]/i, weight: 9, reason: 'Qwen flagship family' },
  { re: /nemotron/i, weight: 8, reason: 'Nemotron family' },
  { re: /minimax-m[23]/i, weight: 7, reason: 'MiniMax family' },
  { re: /-flash\b/i, weight: -5, reason: 'flash variant (cheaper, weaker)' },
  { re: /-mini\b/i, weight: -6, reason: 'mini variant (cheaper, weaker)' }
];

/** Ids that mark an instruction-tuned build rather than a base checkpoint. */
const HF_INSTRUCT_MARKER = /(instruct|-it\b|-chat|thinking|chat-|-coder|reasoning)/i;

/** Strip the HuggingFace provider prefix from a gateway model id. */
export function hfModelName(modelId) {
  const raw = String(modelId || '');
  return raw.startsWith(HF_PREFIX) ? raw.slice(HF_PREFIX.length) : raw;
}

/** True when a gateway model id belongs to the HuggingFace lane. */
export function isHuggingFaceModel(modelId) {
  return String(modelId || '').startsWith(HF_PREFIX);
}

/**
 * Is a HuggingFace key active? The lane needs no zstack-side key for
 * inference, because the gateway holds this one; the key is what makes the
 * gateway list `huggingface/*` models at all, so its presence is the honest
 * test for whether the lane can resolve to anything.
 *
 * `HF_TOKEN` is also read from the environment, which keeps a machine whose
 * key lives in a `.env` working without a ModelHitch config entry. It is never
 * required: nothing in this module sends a token anywhere.
 */
export function hasHuggingFaceKey(keys = {}, env = process.env) {
  return !!(keys[HF_PROVIDER_ID] || env?.HF_TOKEN);
}

/** The publishing org of a HuggingFace model name (`Qwen/Qwen3-32B` -> `Qwen`). */
export function hfOrg(modelName) {
  const name = hfModelName(modelName);
  const slash = name.indexOf('/');
  return slash > 0 ? name.slice(0, slash) : '';
}

/**
 * Parameter count in billions, parsed from the model name.
 *
 * Only a `B`/`T` suffix counts: `MiniMax-M1-80k` is an 80k context, not an 80B
 * model, and reading it as a size would let a small model past the floor. MoE
 * names carry both totals (`30B-A3B`); `active` is the second number, which is
 * what the model spends per token. Returns `{ total, active, unit }` or null
 * when the name states no size at all — several frontier families omit it.
 */
export function hfModelSize(modelName) {
  const name = hfModelName(modelName);
  // `120b`, `1.5B`, `2.4T`, the `A17B`/`A3B` active-parameter form, and the
  // letter-prefixed `r7b` that Command R uses. A bare `B`/`T` suffix is what
  // makes it a size: `MiniMax-M1-80k` is a context window.
  const total = name.match(/(?:^|[-_.a-z])(\d+(?:\.\d+)?)\s*([BT])(?![a-z0-9])/i);
  const active = name.match(/-a(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i);
  if (!total && !active) return null;
  const toBillions = (value, unit) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return /t/i.test(unit || 'B') ? n * 1000 : n;
  };
  const totalB = total ? toBillions(total[1], total[2]) : null;
  const activeB = active ? Number(active[1]) : null;
  const effective = activeB != null ? activeB : totalB;
  return {
    total: totalB,
    active: activeB,
    effective: effective != null ? effective : null
  };
}

/** True when the id names an instruction-tuned build rather than a base model. */
export function isInstructModel(modelName) {
  return HF_INSTRUCT_MARKER.test(hfModelName(modelName));
}

/**
 * The dedupe key: org plus family name with quantized and dated suffixes
 * removed, so `zai-org/GLM-5.3`, `GLM-5.3-FP8` and `GLM-5.3-BF16` collapse to
 * one group and only the plain build is ever pinned.
 */
export function hfFamilyKey(modelName) {
  const name = hfModelName(modelName);
  const org = hfOrg(name);
  let stem = org ? name.slice(org.length + 1) : name;
  let previous;
  do {
    previous = stem;
    stem = stem.replace(HF_VARIANT_SUFFIX, '');
    // A trailing snapshot date (`-0813`, `-2507`, `-12-2024`) is a repackaging
    // of the same family, not a different model.
    stem = stem.replace(/[-_.]\d{4}$/, '').replace(/[-_.]\d{1,2}[-_.]\d{4}$/, '');
  } while (stem !== previous);
  return `${org}/${stem}`.toLowerCase();
}

/**
 * The id-only exclusion reason for a model, or null when it survives curation.
 * Pure and offline: it reads nothing but the id.
 *
 * Task and fine-tune rules run before the publisher allowlist on purpose. A
 * model that is both unrecognized and, say, a safety classifier is best
 * reported as the classifier: otherwise an operator adds the publisher to the
 * allowlist, reruns, and finds the model still missing with no new reason.
 */
export function hfCurationExclusion(modelId) {
  if (!isHuggingFaceModel(modelId)) return 'not a HuggingFace model';
  const name = hfModelName(modelId);
  const org = hfOrg(name);
  if (!org) return 'malformed model id';
  for (const rule of [...HF_TASK_EXCLUSIONS, ...HF_FINETUNE_EXCLUSIONS]) {
    if (rule.re.test(name)) return rule.reason;
  }
  if (hfPublisherRank(org) === -1) return `unrecognized publisher: ${org}`;
  return null;
}

/**
 * Read cached capability metadata. Returns null when absent, unreadable, or
 * older than the TTL, so a stale file is refetched rather than trusted.
 */
export function readHuggingFaceCapabilityCache(options = {}) {
  const cachePath = options.cachePath || HF_CAPABILITY_CACHE;
  const ttl = options.ttlMs ?? HF_CAPABILITY_TTL_MS;
  const now = options.now ?? Date.now();
  try {
    if (!existsSync(cachePath)) return null;
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.models) return null;
    const at = Number(parsed.at);
    if (!Number.isFinite(at) || now - at > ttl) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write capability metadata atomically; a cache write failure is never fatal. */
export function writeHuggingFaceCapabilityCache(data, options = {}) {
  const cachePath = options.cachePath || HF_CAPABILITY_CACHE;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Reduce one entry of the router listing to the fields the filter uses.
 *
 * A model is usable when at least one live provider serves it, so the best
 * live provider is the one that counts: a model served with tools by one
 * provider and without by another is tool-capable.
 *
 * Price, context, and speed are read from the providers that can actually
 * serve a zstack run — the tool-capable ones — whenever any exist. Reading
 * them from every live provider would let a cheap provider that cannot call
 * tools make the model look affordable and roomy, which is a price and a
 * context window no run could ever use.
 */
export function reduceHuggingFaceEntry(entry) {
  const id = hfModelName(entry?.id);
  if (!id) return null;
  const providers = Array.isArray(entry.providers) ? entry.providers : [];
  const live = providers.filter(p => p && p.status === 'live');
  const toolProviders = live.filter(p => p.supports_tools === true);
  const basis = toolProviders.length > 0 ? toolProviders : live;
  const contexts = basis.map(p => Number(p.context_length)).filter(n => Number.isFinite(n) && n > 0);
  const prices = basis
    .map(p => Number(p.pricing?.input) + Number(p.pricing?.output))
    .filter(n => Number.isFinite(n));
  const throughputs = basis.map(p => Number(p.throughput)).filter(n => Number.isFinite(n) && n > 0);
  const latencies = basis.map(p => Number(p.first_token_latency_ms)).filter(n => Number.isFinite(n) && n > 0);
  const outputs = entry.architecture?.output_modalities;
  return {
    id,
    created: Number.isFinite(Number(entry.created)) ? Number(entry.created) : null,
    live: live.length > 0,
    supportsTools: toolProviders.length > 0,
    supportsStructuredOutput: basis.some(p => p.supports_structured_output === true),
    contextLength: contexts.length > 0 ? Math.max(...contexts) : null,
    outputModalities: Array.isArray(outputs) ? outputs : null,
    pricePerMTok: prices.length > 0 ? Math.min(...prices) : null,
    isFree: basis.some(p => p.is_free === true),
    throughput: throughputs.length > 0 ? Math.max(...throughputs) : null,
    firstTokenLatencyMs: latencies.length > 0 ? Math.min(...latencies) : null,
    modelAuthor: basis.some(p => p.is_model_author === true)
  };
}

/**
 * Fetch per-model capability metadata from the router's public listing.
 *
 * Never throws: an unreachable network leaves the lane on its curation layer,
 * which is a worse filter, not a broken one. `source` is reported as
 * `unavailable` so a caller can say so rather than imply it filtered on
 * capability it never saw.
 */
export async function fetchHuggingFaceCapabilities(options = {}) {
  const url = options.url || HF_MODELS_URL;
  const impl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const res = await impl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'zstack' },
      signal: controller.signal
    });
    if (!res.ok) return { source: 'unavailable', error: `HTTP ${res.status}`, models: {} };
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    const models = {};
    for (const entry of list) {
      const reduced = reduceHuggingFaceEntry(entry);
      if (reduced) models[reduced.id] = reduced;
    }
    if (Object.keys(models).length === 0) {
      return { source: 'unavailable', error: 'listing carried no models', models: {} };
    }
    return { source: 'live', at: Date.now(), url, models };
  } catch (err) {
    return { source: 'unavailable', error: err?.message || 'capability fetch failed', models: {} };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The generation a name states, and the stem it belongs to:
 * `zai-org/GLM-5.3` -> `{ stem: 'glm-', version: 5.3, major: 5 }`,
 * `deepseek-ai/DeepSeek-R1` -> `{ stem: 'deepseek-r', version: 1, major: 1 }`.
 * A name with no number at all has a null version.
 *
 * Only `major` decides generation: a point release is the same generation as
 * the flagship it follows, so `DeepSeek-V4.1-Flash` must not demote
 * `DeepSeek-V4-Pro` for being one decimal behind.
 */
export function hfGeneration(modelName) {
  const name = hfModelName(modelName);
  const org = hfOrg(name);
  const stem = org ? name.slice(org.length + 1) : name;
  const match = stem.match(/(\d+(?:\.\d+)?)/);
  if (!match) return { stem: stem.toLowerCase(), version: null, major: null };
  const version = Number(match[1]);
  return {
    stem: stem.slice(0, match.index).toLowerCase(),
    version,
    major: Math.floor(version)
  };
}

/**
 * Capability metadata for the filter: the cache when fresh, the network when
 * not, and an empty map when neither is available. Injected `models` always
 * win, which is how tests and callers that already fetched can skip the I/O.
 */
export async function loadHuggingFaceCapabilities(options = {}) {
  if (options.capabilities && typeof options.capabilities === 'object') {
    return {
      source: options.capabilities.source || 'provided',
      at: options.capabilities.at ?? null,
      models: options.capabilities.models || options.capabilities
    };
  }
  if (options.refresh !== true) {
    const cached = readHuggingFaceCapabilityCache(options);
    if (cached) return { source: 'cache', at: cached.at, url: cached.url, models: cached.models };
  }
  const fetched = await fetchHuggingFaceCapabilities(options);
  if (fetched.source === 'live') {
    writeHuggingFaceCapabilityCache(
      { at: fetched.at, url: fetched.url, models: fetched.models },
      options
    );
  }
  return fetched;
}

/**
 * The capability-gate reason for one model, or null when it passes.
 * A capability record that was never fetched yields no reason: an unknown fact
 * is not a disqualifying one, and the report says the gate did not run.
 */
export function hfCapabilityExclusion(modelId, capability) {
  if (!capability) return null;
  if (capability.live === false) return 'no live provider';
  if (capability.supportsTools === false) return 'no tool calling (the agent loop needs it)';
  if (capability.outputModalities && !capability.outputModalities.includes('text')) {
    return 'no text output';
  }
  if (Number.isFinite(capability.contextLength) && capability.contextLength < HF_MIN_CONTEXT_TOKENS) {
    return `context window ${capability.contextLength} < ${HF_MIN_CONTEXT_TOKENS}`;
  }
  return null;
}

/**
 * Score a survivor for each role class. Returns transparent contributions so
 * the report can say why a model won rather than asserting that it did.
 */
export function scoreHuggingFaceModel(model, options = {}) {
  const tier = HF_TIER_WEIGHTS[options.tier] ? options.tier : 'med-high';
  const weights = HF_TIER_WEIGHTS[tier];
  const capability = options.capability || null;
  const size = hfModelSize(model.id);
  const name = hfModelName(model.id);
  const reasons = [];

  // Capability: size dominates, with active parameters counting for MoE since
  // that is what a token actually costs the model.
  const index = size?.effective != null ? Math.min(size.effective, 400) : 40;
  let base = Math.min(60, Math.round(Math.sqrt(index) * 3));
  if (size?.effective == null) {
    reasons.push('size unrated (first-party publisher, admitted on trust)');
    base = 30;
  } else {
    reasons.push(`${size.effective}B effective`);
  }

  const rank = hfPublisherRank(hfOrg(name));
  const publisherBonus = rank >= 0 ? Math.max(0, 12 - rank) : 0;
  if (publisherBonus > 0) reasons.push(`publisher ${hfOrg(name)} (+${publisherBonus})`);

  const coding = (options.codingSignals || HF_CODING_SIGNALS).reduce(
    (sum, s) => sum + (s.re.test(name) ? s.weight : 0),
    0
  );
  const reasoning = (options.reasoningSignals || HF_REASONING_SIGNALS).reduce(
    (sum, s) => sum + (s.re.test(name) ? s.weight : 0),
    0
  );

  let contextBonus = 0;
  if (Number.isFinite(capability?.contextLength)) {
    contextBonus = Math.min(12, Math.round(Math.log2(capability.contextLength / HF_MIN_CONTEXT_TOKENS) * 4));
    if (contextBonus > 0) reasons.push(`context ${capability.contextLength}`);
  }

  const generationBonus = options.generationBonus || 0;
  if (generationBonus > 0) reasons.push('newest generation from this publisher');

  let recencyBonus = 0;
  if (Number.isFinite(capability?.created) && Number.isFinite(options.now)) {
    const years = (options.now / 1000 - capability.created) / (365 * 24 * 3600);
    if (years >= 0) {
      recencyBonus = Math.max(-10, Math.round((1.5 - years) * 6 * weights.recency));
      if (recencyBonus !== 0) reasons.push(`released ${years.toFixed(1)}y ago`);
    }
  }

  let costPenalty = 0;
  if (weights.cost > 0 && Number.isFinite(capability?.pricePerMTok)) {
    if (capability.isFree) {
      reasons.push('free tier');
    } else {
      costPenalty = Math.min(
        HF_COST_PENALTY_CAP,
        Math.round(Math.log2(1 + capability.pricePerMTok) * 3 * weights.cost)
      );
      if (costPenalty > 0) reasons.push(`$${capability.pricePerMTok.toFixed(2)}/Mtok (-${costPenalty})`);
    }
  }

  let speedPenalty = 0;
  if (weights.speed > 0 && Number.isFinite(capability?.throughput)) {
    if (capability.throughput < 20) {
      speedPenalty = Math.min(12, Math.round((20 - capability.throughput) * weights.speed * 0.5));
      if (speedPenalty > 0) reasons.push(`${capability.throughput.toFixed(0)} tok/s`);
    } else if (capability.throughput > 80) {
      reasons.push(`fast (${capability.throughput.toFixed(0)} tok/s)`);
    }
  }

  const overall = base + publisherBonus + contextBonus + recencyBonus + generationBonus - costPenalty - speedPenalty;
  const moeNote = size?.active != null ? ` (MoE, ${size.active}B active)` : '';
  return {
    id: model.id,
    org: hfOrg(name),
    size,
    capability,
    score: {
      overall,
      coder: overall + coding,
      architect: overall + Math.round(reasoning / 2),
      reasoner: overall + reasoning
    },
    reasons: [`${reasons.join(', ')}${moeNote}`, `coder ${overall + coding}, reasoner ${overall + reasoning}`]
  };
}

/**
 * Run the whole filter over the HuggingFace models a gateway serves.
 *
 * `modelIds` is the live catalogue, so nothing outside it is ever returned:
 * a pinned id the gateway cannot serve would fail at dispatch, which is worse
 * than a lower-ranked model that works.
 */
export function filterHuggingFaceModels(modelIds, options = {}) {
  const tier = HF_TIER_SIZE_FLOOR[options.tier] ? options.tier : 'med-high';
  const floor = options.sizeFloor ?? HF_TIER_SIZE_FLOOR[tier];
  const capabilities = options.capabilities || null;
  const capabilitySource = options.capabilitySource || (capabilities ? 'provided' : 'unavailable');
  const ids = (modelIds || []).filter(isHuggingFaceModel);

  const rejected = [];
  const survivors = [];

  for (const modelId of ids) {
    const curation = hfCurationExclusion(modelId);
    if (curation) {
      rejected.push({ id: modelId, gate: 'curation', reason: curation });
      continue;
    }
    const capability = capabilities ? capabilities[hfModelName(modelId)] || null : null;
    const capabilityReason = hfCapabilityExclusion(modelId, capability);
    if (capabilityReason) {
      rejected.push({ id: modelId, gate: 'capability', reason: capabilityReason });
      continue;
    }
    const size = hfModelSize(modelId);
    if (size?.total != null && size.total < floor) {
      rejected.push({
        id: modelId,
        gate: 'size',
        reason: `${size.total}B below the ${tier} floor of ${floor}B`
      });
      continue;
    }
    survivors.push({ id: modelId, capability, size });
  }

  // Duplicate collapse: the same family listed as a plain build, a quantized
  // build, and a dated snapshot is one model, and the plain build is the one
  // to pin. A base checkpoint loses to an instruction-tuned sibling because
  // a base model is not a chat model.
  const groups = new Map();
  for (const s of survivors) {
    const key = hfFamilyKey(s.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const admitted = [];
  const seen = new Set();
  for (const [key, group] of groups) {
    const ranked = [...group].sort((a, b) => hfVariantRank(a.id) - hfVariantRank(b.id) || a.id.localeCompare(b.id));
    const winner = ranked[0];
    for (const loser of ranked.slice(1)) {
      rejected.push({
        id: loser.id,
        gate: 'duplicate',
        reason: `same model as ${winner.id} (${hfVariantReason(loser.id)})`
      });
    }
    if (seen.has(key)) continue;
    seen.add(key);
    admitted.push(winner);
  }

  // A base checkpoint is not a chat model, and pinning one is the quiet failure
  // this lane has to avoid: it answers fluently and engineers nothing. The gate
  // is narrow on purpose — it only drops a base model when an instruction-tuned
  // model whose name extends it also survived every other gate, so a base model
  // is kept when its instruct sibling was itself rejected. Grouping cannot
  // express this, because `X` and `X-Instruct` are different names, not copies.
  const trainable = [];
  for (const s of admitted) {
    if (!isInstructModel(s.id)) {
      const name = hfModelName(s.id);
      const sibling = admitted.find(o => o.id !== s.id && isInstructModel(o.id) && hfModelName(o.id).startsWith(name));
      if (sibling) {
        rejected.push({
          id: s.id,
          gate: 'duplicate',
          reason: `base checkpoint; instruction-tuned sibling ${sibling.id} preferred`
        });
        continue;
      }
    }
    trainable.push(s);
  }

  const now = options.now ?? Date.now();

  // The newest generation each publisher ships, computed once across the whole
  // admitted set: a model only counts as current relative to its own publisher.
  const bestVersionByOrg = new Map();
  for (const s of trainable) {
    const { major } = hfGeneration(s.id);
    if (major == null) continue;
    const org = hfOrg(s.id);
    const best = bestVersionByOrg.get(org);
    if (best === undefined || major > best) bestVersionByOrg.set(org, major);
  }

  const scored = trainable
    .map(s => {
      const { major } = hfGeneration(s.id);
      const org = hfOrg(s.id);
      const generationBonus = major != null && major === bestVersionByOrg.get(org) ? HF_GENERATION_BONUS : 0;
      return scoreHuggingFaceModel(s, { tier, capability: s.capability, now, generationBonus });
    })
    .sort((a, b) => b.score.overall - a.score.overall || a.id.localeCompare(b.id));

  return {
    tier,
    sizeFloor: floor,
    capabilitySource,
    considered: ids.length,
    admitted: scored,
    rejected: rejected.sort((a, b) => a.id.localeCompare(b.id))
  };
}

/** Lower is better: a plain build beats a quantized build, and undated beats a snapshot. */
function hfVariantRank(modelId) {  const name = hfModelName(modelId);
  let rank = 0;
  if (HF_VARIANT_SUFFIX.test(name)) rank += 4;
  if (/[-_.]\d{4}$/.test(name) || /[-_.]\d{1,2}[-_.]\d{4}$/.test(name)) rank += 2;
  if (!isInstructModel(name)) rank += 1;
  return rank;
}

function hfVariantReason(modelId) {
  const name = hfModelName(modelId);
  if (HF_VARIANT_SUFFIX.test(name)) return 'quantized build';
  if (/[-_.]\d{4}$/.test(name) || /[-_.]\d{1,2}[-_.]\d{4}$/.test(name)) return 'dated snapshot';
  if (!isInstructModel(name)) return 'base checkpoint';
  return 'duplicate listing';
}

/**
 * The quickest strong member of a pool.
 *
 * Quality leads, because the pool is already the best-scoring models and the
 * role is "fast", not "cheap": ordering by price first let a free minor model
 * win the role over a flagship's flash variant, which is the quality drop this
 * lane exists to avoid. Size then price break ties among equals.
 */
function pickFastest(pool) {
  const sizeOf = m => (m.size?.effective != null ? m.size.effective : 999);
  const costOf = m => (m.capability?.isFree ? 0 : (Number.isFinite(m.capability?.pricePerMTok) ? m.capability.pricePerMTok : 999));
  return [...pool].sort(
    (a, b) => b.score.overall - a.score.overall || sizeOf(a) - sizeOf(b) || costOf(a) - costOf(b) || a.id.localeCompare(b.id)
  )[0];
}

/**
 * Pin the filter's survivors to zstack's roles.
 *
 * Returns `applied: false` with a note when nothing survived, so the caller
 * falls back to its own default and says the lane did not apply. Inventing a
 * pin the gateway cannot serve is the one outcome ruled out.
 */
export function resolveHuggingFaceLane(modelIds, options = {}) {
  const report = filterHuggingFaceModels(modelIds, options);
  const admitted = report.admitted;
  if (admitted.length === 0) {
    return {
      applied: false,
      coder: null,
      fast: null,
      architect: null,
      reasoner: null,
      panel: [],
      report,
      note: report.considered === 0
        ? 'no HuggingFace models in the catalog (is HF_TOKEN set in ModelHitch?)'
        : `all ${report.considered} HuggingFace models were filtered out for the ${report.tier} tier`
    };
  }

  const byScore = key => [...admitted].sort(
    (a, b) => b.score[key] - a.score[key] || a.id.localeCompare(b.id)
  );

  // "Fast" is a speed-optimized build of a strong family, not the cheapest
  // model that cleared the floor: an 8B model from two generations ago is also
  // cheap and quick, and picking it would be exactly the quality drop the
  // filter exists to prevent. So the pool is the best-scoring models, and the
  // fastest-looking member of that pool wins. Only when nothing in the pool is
  // marked as a fast variant do size and cost decide.
  const topPool = [...admitted]
    .sort((a, b) => b.score.overall - a.score.overall || a.id.localeCompare(b.id))
    .slice(0, HF_FAST_POOL_SIZE);
  const fastPool = topPool.filter(m => HF_FAST_MARKER.test(hfModelName(m.id)));
  const fast = pickFastest(fastPool.length > 0 ? fastPool : topPool);

  // The cheap tier buys the cheap coder. The Zen and Go lanes pin a flash model
  // to the coder role at `low-med`, and a tier that meant something different
  // per lane would be a trap, so this lane follows.
  const coder = report.tier === 'low-med' ? fast : byScore('coder')[0];
  const architect = byScore('architect')[0];
  const reasoner = byScore('reasoner')[0];

  // A panel is only adversarial across distinct publishers, so members are
  // drawn from different orgs before a second model from one org is allowed.
  const panel = [];
  const orgs = new Set();
  for (const m of byScore('overall')) {
    if (panel.length >= 3) break;
    if (orgs.has(m.org)) continue;
    orgs.add(m.org);
    panel.push(m.id);
  }
  for (const m of [...admitted].sort((a, b) => b.score.overall - a.score.overall || a.id.localeCompare(b.id))) {
    if (panel.length >= 2) break;
    if (!panel.includes(m.id)) panel.push(m.id);
  }

  return {
    applied: true,
    coder: coder.id,
    fast: fast.id,
    architect: architect.id,
    reasoner: reasoner.id,
    panel,
    picks: { coder, fast, architect, reasoner },
    report,
    note: report.capabilitySource === 'unavailable'
      ? 'capability metadata unavailable: filtered on curation rules only'
      : null
  };
}

/**
 * A one-screen account of what the filter did, for `zstack hf` and the UI.
 * Grouped by gate so a rule that is too aggressive is visible as a count
 * rather than buried in a list of a hundred rejections.
 */
export function describeHuggingFaceFilter(report) {
  if (!report) return null;
  const byGate = {};
  for (const r of report.rejected) {
    byGate[r.gate] = (byGate[r.gate] || 0) + 1;
  }
  return {
    tier: report.tier,
    sizeFloor: report.sizeFloor,
    capabilitySource: report.capabilitySource,
    considered: report.considered,
    admitted: report.admitted.length,
    rejected: report.rejected.length,
    rejectedByGate: byGate,
    models: report.admitted.map(m => ({
      id: m.id,
      org: m.org,
      effectiveParamsB: m.size?.effective ?? null,
      contextLength: m.capability?.contextLength ?? null,
      supportsTools: m.capability?.supportsTools ?? null,
      score: m.score
    })),
    exclusions: report.rejected
  };
}
