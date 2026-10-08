import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HF_PREFIX,
  HF_MIN_CONTEXT_TOKENS,
  LANES,
  ZSTACK_ROLES,
  describeHuggingFaceFilter,
  fetchHuggingFaceCapabilities,
  filterHuggingFaceModels,
  hasHuggingFaceKey,
  hfCurationExclusion,
  hfFamilyKey,
  hfGeneration,
  hfModelName,
  hfModelSize,
  hfOrg,
  isHuggingFaceModel,
  isInstructModel,
  isKnownLane,
  loadHuggingFaceCapabilities,
  normalizeLane,
  readHuggingFaceCapabilityCache,
  reduceHuggingFaceEntry,
  resolveBudgetMapping,
  resolveHuggingFaceLane,
  resolveRoleMapping
} from '../src/index.mjs';
// The run registry is not re-exported from the package index, and a lane is
// validated there too, so it is imported from its own module.
import { validateStartRequest, normalizeStartRequest } from '../src/runs.mjs';

/**
 * A fixture catalogue modelled on the real one's shapes, including the cases
 * that made the filter necessary: quantized duplicates, dated snapshots, an
 * instruction-tuned sibling beside a base checkpoint, a vision build, a guard
 * model, a community fine-tune, and a model whose name states no size.
 *
 * Every id here is invented for the test; none of it is fetched.
 */
const CATALOGUE = [
  `${HF_PREFIX}deepseek-ai/DeepSeek-V4-Pro`,
  `${HF_PREFIX}deepseek-ai/DeepSeek-V4-Pro-0813`,
  `${HF_PREFIX}deepseek-ai/DeepSeek-V4-Flash`,
  `${HF_PREFIX}deepseek-ai/DeepSeek-R1`,
  `${HF_PREFIX}zai-org/GLM-5.3`,
  `${HF_PREFIX}zai-org/GLM-5.3-FP8`,
  `${HF_PREFIX}zai-org/GLM-5.3-BF16`,
  `${HF_PREFIX}zai-org/GLM-4.5V`,
  `${HF_PREFIX}Qwen/Qwen3.5-397B-A17B`,
  `${HF_PREFIX}Qwen/Qwen3-Coder-30B-A3B-Instruct`,
  `${HF_PREFIX}Qwen/Qwen2.5-Coder-7B-Instruct`,
  `${HF_PREFIX}Qwen/Qwen3-235B-A22B`,
  `${HF_PREFIX}Qwen/Qwen3-235B-A22B-Instruct-2507`,
  `${HF_PREFIX}moonshotai/Kimi-K3`,
  `${HF_PREFIX}moonshotai/Kimi-K2.7-Code`,
  `${HF_PREFIX}meta-llama/Llama-Guard-4-12B`,
  `${HF_PREFIX}CohereLabs/c4ai-command-a-translate-08-2025`,
  `${HF_PREFIX}Sao10K/L3-8B-Stheno-v3.2`,
  `${HF_PREFIX}prism-ml/Ternary-Bonsai-27B-gguf`,
  `${HF_PREFIX}thinkingmachines/Inkling`,
  `${HF_PREFIX}google/gemma-3-4b-it`,
  `${HF_PREFIX}ibm-granite/granite-4.2-8b`
];

/** Capability metadata for the fixture, as the router's listing would carry it. */
function capabilitiesFixture(overrides = {}) {
  const models = {};
  for (const id of CATALOGUE) {
    models[hfModelName(id)] = {
      id: hfModelName(id),
      created: 1_770_000_000,
      live: true,
      supportsTools: true,
      supportsStructuredOutput: true,
      contextLength: 200_000,
      outputModalities: ['text'],
      pricePerMTok: 1,
      isFree: false,
      throughput: 60,
      firstTokenLatencyMs: 400,
      modelAuthor: true,
      ...(overrides[hfModelName(id)] || {})
    };
  }
  return models;
}

function filter(overrides = {}, options = {}) {
  return filterHuggingFaceModels(CATALOGUE, {
    tier: 'med-high',
    capabilities: capabilitiesFixture(overrides),
    capabilitySource: 'provided',
    ...options
  });
}

/** The rejection recorded for one model id, or undefined. */
function rejectionFor(report, id) {
  return report.rejected.find(r => r.id === id);
}

describe('huggingface id parsing', () => {
  it('splits the provider prefix from the model name', () => {
    assert.equal(hfModelName('huggingface/deepseek-ai/DeepSeek-V4-Pro'), 'deepseek-ai/DeepSeek-V4-Pro');
    assert.equal(hfModelName('openai/gpt-5.6-luna'), 'openai/gpt-5.6-luna');
    assert.equal(isHuggingFaceModel('huggingface/Qwen/Qwen3-32B'), true);
    assert.equal(isHuggingFaceModel('opencode/deepseek-v4-pro'), false);
  });

  it('reads the publishing org, which survives the model name having slashes', () => {
    assert.equal(hfOrg('huggingface/deepseek-ai/DeepSeek-V4-Pro'), 'deepseek-ai');
    assert.equal(hfOrg('huggingface/Qwen/Qwen3-32B'), 'Qwen');
    assert.equal(hfOrg('huggingface/bare-name'), '');
  });

  it('reads parameter counts, and does not mistake a context length for one', () => {
    assert.deepEqual(hfModelSize('Qwen/Qwen3-Coder-30B-A3B-Instruct'), { total: 30, active: 3, effective: 3 });
    assert.deepEqual(hfModelSize('Qwen/Qwen3.8-2.4T-A95B'), { total: 2400, active: 95, effective: 95 });
    assert.deepEqual(hfModelSize('openai/gpt-oss-120b'), { total: 120, active: null, effective: 120 });
    assert.deepEqual(hfModelSize('CohereLabs/c4ai-command-r7b-12-2024').total, 7);
    // `-80k` is a context window, not 80 billion parameters: reading it as a
    // size would let a small model past the floor.
    assert.equal(hfModelSize('MiniMaxAI/MiniMax-M1-80k'), null);
    // Several frontier families state no size in the id at all.
    assert.equal(hfModelSize('deepseek-ai/DeepSeek-V4-Pro'), null);
  });

  it('grouping collapses quantized and dated copies of one model', () => {
    const key = hfFamilyKey('huggingface/zai-org/GLM-5.3');
    assert.equal(hfFamilyKey('huggingface/zai-org/GLM-5.3-FP8'), key);
    assert.equal(hfFamilyKey('huggingface/zai-org/GLM-5.3-BF16'), key);
    assert.equal(hfFamilyKey('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813'), hfFamilyKey('huggingface/deepseek-ai/DeepSeek-V4-Pro'));
    // A different size in the name is a different model, not a duplicate.
    assert.notEqual(hfFamilyKey('huggingface/Qwen/Qwen3-32B'), hfFamilyKey('huggingface/Qwen/Qwen3-14B'));
  });

  it('reads the generation, so a point release does not outrank its flagship', () => {
    assert.deepEqual(hfGeneration('huggingface/deepseek-ai/DeepSeek-V4-Pro').major, 4);
    assert.deepEqual(hfGeneration('huggingface/deepseek-ai/DeepSeek-V4.1-Flash').major, 4);
    assert.deepEqual(hfGeneration('huggingface/deepseek-ai/DeepSeek-R1').major, 1);
    assert.deepEqual(hfGeneration('huggingface/Qwen/Qwen3.5-397B-A17B').major, 3);
    assert.equal(hfGeneration('huggingface/thinkingmachines/Inkling').major, null);
  });

  it('recognizes an instruction-tuned build', () => {
    assert.equal(isInstructModel('huggingface/Qwen/Qwen3-Coder-30B-A3B-Instruct'), true);
    assert.equal(isInstructModel('huggingface/Qwen/Qwen3-235B-A22B'), false);
  });
});

describe('huggingface curation gates (id only, no network)', () => {
  it('drops non-chat models: guards, translation, speech, embeddings, images, phone builds', () => {
    assert.match(hfCurationExclusion('huggingface/meta-llama/Llama-Guard-4-12B'), /safety classifier/);
    assert.match(hfCurationExclusion('huggingface/CohereLabs/c4ai-command-a-translate-08-2025'), /translation/);
    assert.match(hfCurationExclusion('huggingface/openai/whisper-large-v3'), /speech/);
    assert.match(hfCurationExclusion('huggingface/BAAI/bge-m3-embed'), /embedding/);
    assert.match(hfCurationExclusion('huggingface/stabilityai/stable-diffusion-xl'), /image/);
    assert.match(hfCurationExclusion('huggingface/zai-org/AutoGLM-Phone-9B-Multilingual'), /toy model/);
  });

  it('drops vision builds in all three spellings the catalogue uses', () => {
    assert.match(hfCurationExclusion('huggingface/Qwen/Qwen3-VL-235B-A22B-Instruct'), /vision/);
    assert.match(hfCurationExclusion('huggingface/zai-org/GLM-4.5V'), /vision/);
    assert.match(hfCurationExclusion('huggingface/CohereLabs/aya-vision-32b'), /vision/);
    // A version segment must not read as a vision marker.
    assert.equal(hfCurationExclusion('huggingface/mistralai/Mistral-Small-v3.2-24B'), null);
  });

  it('reports the task rule before the publisher rule, so an allowlist edit is not a dead end', () => {
    // `aisingapore` is not an allowlisted publisher, but the model is a
    // regional build: saying "regional" tells an operator the truth, and
    // saying "unrecognized publisher" would send them to edit the allowlist
    // only to find the model still excluded.
    assert.match(hfCurationExclusion('huggingface/aisingapore/Gemma-SEA-LION-v4-27B-IT'), /regional/);
    // With no task rule in play, the publisher is what is named.
    assert.equal(hfCurationExclusion('huggingface/thinkingmachines/Inkling'), 'unrecognized publisher: thinkingmachines');
  });

  it('drops previews, regional builds, and community roleplay fine-tunes', () => {
    assert.match(hfCurationExclusion('huggingface/tencent/Hy4-preview'), /preview/);
    assert.match(hfCurationExclusion('huggingface/Sao10K/L3-8B-Stheno-v3.2'), /roleplay/);
  });

  it('names the publisher it does not recognize rather than failing silently', () => {
    assert.equal(hfCurationExclusion('huggingface/deepseek-ai/DeepSeek-V4-Pro'), null);
    assert.equal(hfCurationExclusion('huggingface/prism-ml/Ternary-Bonsai-27B-gguf'), 'unrecognized publisher: prism-ml');
  });

  it('rejects anything that is not a HuggingFace model', () => {
    assert.equal(hfCurationExclusion('opencode/deepseek-v4-pro'), 'not a HuggingFace model');
  });
});

describe('huggingface capability gates', () => {
  it('drops a model with no tool calling, because the agent loop needs it', () => {
    const report = filter({ 'Qwen/Qwen3.5-397B-A17B': { supportsTools: false } });
    assert.equal(rejectionFor(report, `${HF_PREFIX}Qwen/Qwen3.5-397B-A17B`).gate, 'capability');
    assert.match(rejectionFor(report, `${HF_PREFIX}Qwen/Qwen3.5-397B-A17B`).reason, /tool calling/);
    assert.equal(report.admitted.some(m => m.id.endsWith('Qwen3.5-397B-A17B')), false);
  });

  it('drops a model with no live provider and one whose context is too small', () => {
    const report = filter({
      'moonshotai/Kimi-K3': { live: false },
      'Qwen/Qwen3-235B-A22B-Instruct-2507': { contextLength: HF_MIN_CONTEXT_TOKENS - 1 }
    });
    assert.match(rejectionFor(report, `${HF_PREFIX}moonshotai/Kimi-K3`).reason, /no live provider/);
    assert.match(rejectionFor(report, `${HF_PREFIX}Qwen/Qwen3-235B-A22B-Instruct-2507`).reason, /context window/);
  });

  it('drops a model that produces no text', () => {
    const report = filter({ 'google/gemma-3-4b-it': { outputModalities: ['image'] } });
    const rejected = report.rejected.find(r => r.id.endsWith('gemma-3-4b-it'));
    assert.ok(rejected, 'the model must be rejected');
  });

  it('treats an absent capability record as unknown, not as disqualifying', () => {
    const report = filterHuggingFaceModels(CATALOGUE, { tier: 'med-high', capabilities: {}, capabilitySource: 'provided' });
    const deepseek = report.admitted.find(m => m.id.endsWith('DeepSeek-V4-Pro'));
    assert.ok(deepseek, 'a model with no capability record must still be an admitted candidate');
    assert.equal(deepseek.capability, null);
  });

  it('reads the best live provider out of a router listing entry', () => {
    const reduced = reduceHuggingFaceEntry({
      id: 'deepseek-ai/DeepSeek-V4-Pro',
      created: 100,
      architecture: { output_modalities: ['text'] },
      providers: [
        { provider: 'a', status: 'staging', supports_tools: true, context_length: 8_000 },
        { provider: 'b', status: 'live', supports_tools: false, context_length: 32_000, pricing: { input: 1, output: 2 } },
        { provider: 'c', status: 'live', supports_tools: true, context_length: 131_072, pricing: { input: 3, output: 5 }, is_free: false, throughput: 40 }
      ]
    });
    assert.equal(reduced.id, 'deepseek-ai/DeepSeek-V4-Pro');
    assert.equal(reduced.live, true);
    assert.equal(reduced.supportsTools, true, 'one live provider offering tools is enough');
    assert.equal(reduced.contextLength, 131_072, 'the largest live context wins');
    assert.equal(reduced.pricePerMTok, 8, 'price comes from a provider that can actually call tools');
  });

  it('falls back to every live provider for price when none support tools', () => {
    const reduced = reduceHuggingFaceEntry({
      id: 'x/y',
      providers: [
        { provider: 'a', status: 'live', supports_tools: false, context_length: 16_384, pricing: { input: 1, output: 1 } }
      ]
    });
    assert.equal(reduced.supportsTools, false);
    assert.equal(reduced.pricePerMTok, 2, 'a model with no tool provider still reports its real price');
  });
});

describe('huggingface duplicate collapse', () => {
  it('keeps the plain build and reports which model the dropped copy duplicates', () => {
    const report = filter();
    const fp8 = rejectionFor(report, `${HF_PREFIX}zai-org/GLM-5.3-FP8`);
    assert.equal(fp8.gate, 'duplicate');
    assert.match(fp8.reason, /same model as huggingface\/zai-org\/GLM-5\.3/);
    assert.ok(report.admitted.some(m => m.id === `${HF_PREFIX}zai-org/GLM-5.3`));
    assert.equal(report.admitted.some(m => m.id.endsWith('GLM-5.3-FP8')), false);
  });

  it('keeps the undated build over a dated snapshot', () => {
    const report = filter();
    assert.ok(report.admitted.some(m => m.id === `${HF_PREFIX}deepseek-ai/DeepSeek-V4-Pro`));
    assert.equal(report.admitted.some(m => m.id.endsWith('DeepSeek-V4-Pro-0813')), false);
  });

  it('prefers an instruction-tuned sibling over the base checkpoint', () => {
    const report = filter();
    assert.ok(report.admitted.some(m => m.id === `${HF_PREFIX}Qwen/Qwen3-235B-A22B-Instruct-2507`));
    assert.equal(
      report.admitted.some(m => m.id === `${HF_PREFIX}Qwen/Qwen3-235B-A22B`),
      false,
      'the base checkpoint must lose to its instruct sibling'
    );
  });
});

describe('huggingface size floor', () => {
  it('drops the tiny tail and keeps what is at or above the tier floor', () => {
    const report = filter();
    assert.match(rejectionFor(report, `${HF_PREFIX}Qwen/Qwen2.5-Coder-7B-Instruct`).reason, /below the med-high floor of 14B/);
    assert.equal(report.admitted.some(m => m.id.endsWith('Qwen2.5-Coder-7B-Instruct')), false);
    // 30B total clears a 14B floor even though only 3B is active: the floor is a
    // tail cut, and the active count ranks rather than gates.
    assert.ok(report.admitted.some(m => m.id.endsWith('Qwen3-Coder-30B-A3B-Instruct')));
  });

  it('raises the floor with the tier, so a cheap tier admits more than max', () => {
    const low = filterHuggingFaceModels(CATALOGUE, { tier: 'low-med', capabilities: capabilitiesFixture() });
    const max = filterHuggingFaceModels(CATALOGUE, { tier: 'max', capabilities: capabilitiesFixture() });
    assert.ok(low.sizeFloor < max.sizeFloor);
    assert.ok(low.admitted.length >= max.admitted.length);
  });
});

describe('huggingface lane pinning', () => {
  it('resolves every tier without an empty role or a one-model panel', () => {
    for (const tier of ['low-med', 'med-high', 'high', 'max']) {
      const lane = resolveHuggingFaceLane(CATALOGUE, { tier, capabilities: capabilitiesFixture(), capabilitySource: 'provided' });
      assert.equal(lane.applied, true, `${tier} must resolve`);
      assert.ok(lane.panel.length >= 2, `${tier} panel must not be a single model`);
      for (const role of ['coder', 'fast', 'architect', 'reasoner']) {
        assert.match(lane[role], /^huggingface\//, `${tier} ${role} must stay on HuggingFace`);
      }
      // Every pin must be a model the gateway actually serves, because a panel
      // member that is absent fails at dispatch with no per-model fallback.
      for (const id of [lane.coder, lane.fast, lane.architect, lane.reasoner, ...lane.panel]) {
        assert.ok(CATALOGUE.includes(id), `${tier} pinned ${id}, which the catalogue does not serve`);
      }
    }
  });

  it('is deterministic: the same catalogue scores the same way twice', () => {
    const a = resolveHuggingFaceLane(CATALOGUE, { tier: 'med-high', capabilities: capabilitiesFixture() });
    const b = resolveHuggingFaceLane(CATALOGUE, { tier: 'med-high', capabilities: capabilitiesFixture() });
    assert.deepEqual(
      { coder: a.coder, fast: a.fast, architect: a.architect, reasoner: a.reasoner, panel: a.panel },
      { coder: b.coder, fast: b.fast, architect: b.architect, reasoner: b.reasoner, panel: b.panel }
    );
  });

  it('draws panel members from distinct publishers, so the panel is adversarial', () => {
    const lane = resolveHuggingFaceLane(CATALOGUE, { tier: 'med-high', capabilities: capabilitiesFixture() });
    const orgs = lane.panel.map(id => hfOrg(id));
    assert.equal(new Set(orgs).size, orgs.length, `panel orgs must be distinct, got ${orgs.join(', ')}`);
  });

  it('pins the flagship to the coder role and a flash build to the fast role', () => {
    const lane = resolveHuggingFaceLane(CATALOGUE, { tier: 'med-high', capabilities: capabilitiesFixture() });
    assert.equal(lane.coder, `${HF_PREFIX}deepseek-ai/DeepSeek-V4-Pro`);
    assert.match(lane.fast, /Flash|flash|mini|air|lite|small/);
    assert.notEqual(lane.fast, lane.coder, 'the fast role is not a second coder');
  });

  it('follows the cheap-tier convention: low-med buys the cheap coder', () => {
    const low = resolveHuggingFaceLane(CATALOGUE, { tier: 'low-med', capabilities: capabilitiesFixture() });
    const mid = resolveHuggingFaceLane(CATALOGUE, { tier: 'med-high', capabilities: capabilitiesFixture() });
    assert.equal(low.coder, low.fast, 'the Zen and Go lanes pin a flash model to the coder role at low-med');
    assert.notEqual(low.coder, mid.coder, 'a cheap tier must not buy the same coder as med-high');
  });

  it('never pins a model that does not support tools when it has the metadata', () => {
    const capabilities = capabilitiesFixture({ 'moonshotai/Kimi-K2.7-Code': { supportsTools: false } });
    const lane = resolveHuggingFaceLane(CATALOGUE, { tier: 'med-high', capabilities, capabilitySource: 'provided' });
    assert.notEqual(lane.coder, `${HF_PREFIX}moonshotai/Kimi-K2.7-Code`);
    assert.equal(lane.panel.includes(`${HF_PREFIX}moonshotai/Kimi-K2.7-Code`), false);
  });

  it('reports why it could not apply instead of pinning a fabricated model', () => {
    const empty = resolveHuggingFaceLane([], { tier: 'med-high' });
    assert.equal(empty.applied, false);
    assert.equal(empty.coder, null);
    assert.deepEqual(empty.panel, []);
    assert.match(empty.note, /HF_TOKEN/);

    const allRejected = resolveHuggingFaceLane(
      [`${HF_PREFIX}meta-llama/Llama-Guard-4-12B`, `${HF_PREFIX}Sao10K/L3-8B-Stheno-v3.2`],
      { tier: 'med-high' }
    );
    assert.equal(allRejected.applied, false);
    assert.match(allRejected.note, /2 HuggingFace models were filtered out/);
  });
});

describe('huggingface offline behaviour', () => {
  it('still resolves on curation rules alone, and says the capability gate did not run', () => {
    const lane = resolveHuggingFaceLane(CATALOGUE, { tier: 'med-high', capabilities: null, capabilitySource: 'unavailable' });
    assert.equal(lane.applied, true);
    assert.match(lane.note, /capability metadata unavailable/);
    assert.match(lane.report.capabilitySource, /unavailable/);
  });

  it('prefers the current generation over a stale model of the same publisher', () => {
    // Without capability metadata there are no release dates, so the name's
    // generation is the only staleness signal. R1 is the older line.
    const lane = resolveHuggingFaceLane(CATALOGUE, { tier: 'med-high', capabilities: null, capabilitySource: 'unavailable' });
    assert.notEqual(lane.reasoner, `${HF_PREFIX}deepseek-ai/DeepSeek-R1`);
    assert.notEqual(lane.architect, `${HF_PREFIX}deepseek-ai/DeepSeek-R1`);
  });
});

describe('huggingface capability cache and fetch', () => {
  it('ignores a corrupt cache file rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zstack-hf-'));
    const file = join(dir, 'hf.json');
    writeFileSync(file, '{ not json', 'utf8');
    assert.equal(readHuggingFaceCapabilityCache({ cachePath: file }), null);
  });

  it('ignores a cache older than its TTL, so a stale listing is refetched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zstack-hf-'));
    const file = join(dir, 'hf.json');
    writeFileSync(file, JSON.stringify({ at: 1000, models: { 'x/y': { live: true } } }), 'utf8');
    assert.ok(readHuggingFaceCapabilityCache({ cachePath: file, now: 2000, ttlMs: 5000 }));
    assert.equal(readHuggingFaceCapabilityCache({ cachePath: file, now: 100_000, ttlMs: 5000 }), null);
  });

  it('reduces a router listing and degrades to unavailable without throwing', async () => {
    const ok = await fetchHuggingFaceCapabilities({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'Qwen/Qwen3-32B', created: 5, providers: [{ provider: 'p', status: 'live', supports_tools: true, context_length: 40_000 }] }] })
      })
    });
    assert.equal(ok.source, 'live');
    assert.equal(ok.models['Qwen/Qwen3-32B'].supportsTools, true);

    const failing = await fetchHuggingFaceCapabilities({ fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(failing.source, 'unavailable');
    assert.match(failing.error, /offline/);
    assert.deepEqual(failing.models, {});

    const notOk = await fetchHuggingFaceCapabilities({ fetchImpl: async () => ({ ok: false, status: 503 }) });
    assert.equal(notOk.source, 'unavailable');
    assert.match(notOk.error, /HTTP 503/);
  });

  it('lets a caller inject capabilities instead of fetching, and never needs a token', async () => {
    const injected = await loadHuggingFaceCapabilities({ capabilities: { models: { 'a/b': { live: true } } } });
    assert.equal(injected.source, 'provided');
    assert.deepEqual(Object.keys(injected.models), ['a/b']);

    // A key is only ever a signal that the gateway can serve the lane; nothing
    // in this module sends it anywhere.
    assert.equal(hasHuggingFaceKey({ huggingface: 'x' }), true);
    assert.equal(hasHuggingFaceKey({}), false);
    assert.equal(hasHuggingFaceKey({}, { HF_TOKEN: 'from-env' }), true);
  });
});

describe('huggingface lane wiring', () => {
  function laneState() {
    return {
      keys: { huggingface: 'x', opencode: 'y' },
      models: [{ id: 'opencode/deepseek-v4-pro' }, ...CATALOGUE.map(id => ({ id }))],
      config: { defaultProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash', policy: { trusted: [] } },
      hfCapabilities: { source: 'provided', models: capabilitiesFixture() }
    };
  }

  it('is a documented lane with a prefix and a mode', () => {
    assert.ok(LANES.hf);
    assert.equal(LANES.hf.prefix, HF_PREFIX);
    assert.equal(normalizeLane('huggingface'), 'hf');
    assert.equal(normalizeLane('hf-router'), 'hf');
    assert.equal(normalizeLane('HF'), 'hf');
    assert.equal(isKnownLane('hf'), true);
  });

  it('routes every role to a HuggingFace model on the hf lane', () => {
    const resolved = resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'hf', state: laneState() });
    assert.equal(resolved.lane, 'hf');
    assert.equal(resolved.mode, 'huggingface-router');
    assert.equal(resolved.laneApplied, true);
    for (const role of ZSTACK_ROLES) {
      assert.match(resolved.models[role], /^huggingface\//, `hf lane role ${role} must stay on HuggingFace`);
    }
    for (const m of resolved.panelList) {
      assert.match(m, /^huggingface\//, `hf lane panel member ${m} must stay on HuggingFace`);
    }
    assert.ok(resolved.panelList.length >= 2, 'the panel must not collapse to one model');
  });

  it('carries the filter verdict so the pinning can be audited', () => {
    const resolved = resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'hf', state: laneState() });
    assert.ok(resolved.hfLaneFilter);
    assert.equal(resolved.hfLaneFilter.tier, 'med-high');
    assert.equal(resolved.hfLaneFilter.considered, CATALOGUE.length);
    assert.equal(resolved.hfLaneFilter.admitted + resolved.hfLaneFilter.rejected, CATALOGUE.length);
    assert.ok(resolved.hfLaneFilter.exclusions.length > 0, 'rejections must be reported with their reasons');
    assert.match(resolved.hfLaneFilter.models[0].id, /^huggingface\//);
  });

  it('says the lane did not apply when no HuggingFace model is served', () => {
    const state = { keys: { deepseek: 'w' }, models: [{ id: 'deepseek/deepseek-v4-flash' }], config: {} };
    const resolved = resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'hf', state });
    assert.equal(resolved.lane, 'hf');
    assert.match(resolved.laneNote, /no HuggingFace models in the catalog/);
    // The mapping must fall back to something real rather than an invented id.
    for (const role of ZSTACK_ROLES) {
      assert.doesNotMatch(resolved.models[role], /^huggingface\//, `role ${role} claims an HF model with an empty catalogue`);
    }
  });

  it('leaves the lane inactive when source=config pins the models', () => {
    const state = {
      keys: { huggingface: 'x' },
      models: CATALOGUE.map(id => ({ id })),
      config: { defaultProviderId: 'myprov', defaultModel: 'my-model', policy: { trusted: [{ providerId: 'myprov', models: ['my-model'] }] } }
    };
    const resolved = resolveBudgetMapping({ tier: 'med-high', source: 'config', lane: 'hf', state });
    assert.equal(resolved.laneApplied, false);
    assert.equal(resolved.mode, 'modelhitch-config-pinned');
    assert.equal(resolved.hfLaneFilter, null);
  });

  it('keeps the legacy resolver on HuggingFace instead of collapsing it to Zen', () => {
    const mapping = resolveRoleMapping(laneState(), { lane: 'hf' });
    assert.equal(mapping.lane, 'hf');
    assert.equal(mapping.mode, 'huggingface-router');
    for (const role of ZSTACK_ROLES) {
      assert.match(mapping.models[role], /^huggingface\//, `legacy resolver role ${role} must stay on HuggingFace`);
    }
  });

  it('does not make HuggingFace the auto lane', () => {
    const state = laneState();
    assert.equal(resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'auto', state }).lane, 'zen');
    const noOpenCode = { ...state, keys: { huggingface: 'x' } };
    assert.equal(resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'auto', state: noOpenCode }).lane, 'hitch');
  });

  it('is accepted where a lane is validated, by the run API and the CLI alike', () => {
    // `POST /api/runs` used to carry its own `['auto','zen','go','hitch']` array
    // while `/api/budget` read `LANES`, so a new lane was accepted on one path
    // and rejected with a 400 on the other. Both now ask the same question.
    assert.deepEqual(validateStartRequest({ prompt: 'do work', lane: 'hf' }), []);
    assert.deepEqual(validateStartRequest({ prompt: 'do work', lane: 'huggingface' }), []);
    assert.match(validateStartRequest({ prompt: 'do work', lane: 'nope' })[0], /Unknown lane "nope"\. Valid lanes: .*hf/);
    // A run records the canonical id, not whichever alias the caller used.
    assert.equal(normalizeStartRequest({ prompt: 'do work', lane: 'huggingface' }).lane, 'hf');
    assert.equal(normalizeStartRequest({ prompt: 'do work' }).lane, undefined);
  });
});

describe('huggingface filter report', () => {
  it('summarizes by gate without losing the individual reasons', () => {
    const report = describeHuggingFaceFilter(filter());
    assert.equal(report.considered, CATALOGUE.length);
    assert.equal(report.admitted + report.rejected, CATALOGUE.length);
    const gateTotal = Object.values(report.rejectedByGate).reduce((a, b) => a + b, 0);
    assert.equal(gateTotal, report.rejected);
    assert.ok(report.rejectedByGate.curation > 0);
    assert.ok(report.rejectedByGate.duplicate > 0);
    assert.ok(report.models.every(m => typeof m.score.coder === 'number' && typeof m.score.reasoner === 'number'));
    assert.equal(describeHuggingFaceFilter(null), null);
  });
});
