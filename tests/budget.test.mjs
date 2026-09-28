import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUDGET_TIERS,
  BUDGET_SOURCES,
  LANES,
  getStoredBudget,
  saveStoredBudget,
  resolveBudgetMapping,
  normalizeLane,
  isKnownLane,
  ZSTACK_ROLES,
  ZStack
} from '../src/index.mjs';

function mockState() {
  return {
    keys: { opencode: 'x', openai: 'y', gemini: 'z', deepseek: 'w' },
    models: [
      { id: 'opencode/deepseek-v4-pro' },
      { id: 'opencode/deepseek-v4-flash' },
      { id: 'opencode/claude-sonnet-4-6' },
      { id: 'opencode/gpt-5.5' },
      { id: 'opencode/qwen3.7-max' },
      { id: 'openai/gpt-5.6-luna' },
      { id: 'deepseek/deepseek-v4-flash' },
      { id: 'gemini/models/gemini-3.6-flash' }
    ],
    config: { defaultProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash', policy: { trusted: [] } }
  };
}

describe('zstack budget tiers', () => {
  it('exposes all four required tiers', () => {
    for (const tier of ['low-med', 'med-high', 'high', 'max']) {
      assert.ok(BUDGET_TIERS[tier], `Tier ${tier} must exist`);
    }
  });

  it('exposes both model sources (config vs catalog)', () => {
    assert.ok(BUDGET_SOURCES['config'], 'Option A (config) must exist');
    assert.ok(BUDGET_SOURCES['catalog'], 'Option B (catalog) must exist');
  });

  it('resolves catalog mappings for every tier across all 15 roles', () => {
    for (const tier of Object.keys(BUDGET_TIERS)) {
      const resolved = resolveBudgetMapping({ tier, source: 'catalog', state: mockState() });
      assert.equal(resolved.tier, tier);
      assert.equal(resolved.source, 'catalog');
      for (const role of ZSTACK_ROLES) {
        assert.ok(resolved.models[role], `Tier ${tier} role [${role}] must have a model`);
      }
      assert.ok(resolved.panelList.length >= 1, `Tier ${tier} panel must not be empty`);
    }
  });

  it('resolves config-only mappings strictly from ModelHitch config', () => {
    const state = {
      keys: { opencode: 'x' },
      models: [{ id: 'myprov/my-model-flash' }],
      config: {
        defaultProviderId: 'myprov',
        defaultModel: 'my-model-flash',
        policy: { trusted: [{ providerId: 'myprov', models: ['my-model-flash', 'my-model-pro'] }] }
      }
    };
    const resolved = resolveBudgetMapping({ tier: 'med-high', source: 'config', state });
    assert.equal(resolved.source, 'config');
    for (const role of ZSTACK_ROLES) {
      assert.match(resolved.models[role], /myprov\//, `Config source must stay on myprov for role ${role}`);
    }
  });

  it('persists budget tier/source to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zstack-budget-'));
    const file = join(dir, 'budget.json');
    const saved = saveStoredBudget({ tier: 'high', source: 'config' }, file);
    assert.equal(saved.tier, 'high');
    assert.equal(saved.source, 'config');
    const loaded = getStoredBudget(file);
    assert.equal(loaded.tier, 'high');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.tier, 'high');
  });

  it('falls back to med-high on unknown tier', () => {
    const resolved = resolveBudgetMapping({ tier: 'nope', source: 'catalog', state: mockState() });
    assert.equal(resolved.tier, 'med-high');
  });

  it('SDK exposes budget helpers', () => {
    const z = new ZStack();
    const stored = z.getBudget();
    assert.ok(stored.tier, 'Stored budget must have a tier');
    assert.ok(typeof z.getBudgetMapping === 'function');
    assert.ok(typeof z.setBudget === 'function');
  });

  it('SDK rejects unknown budget tier', async () => {
    const z = new ZStack();
    await assert.rejects(() => z.setBudget('ultra'), /Unknown budget tier/);
  });
});

describe('zstack provider lanes', () => {
  function laneState() {
    return {
      keys: { opencode: 'x', 'opencode-go': 'y', openai: 'z', deepseek: 'w' },
      models: [
        { id: 'opencode/deepseek-v4-pro' },
        { id: 'opencode/claude-opus-5-5' },
        { id: 'opencode/gpt-6-sol' },
        { id: 'opencode/qwen3.8-max' },
        { id: 'opencode-go/deepseek-v4-pro' },
        { id: 'opencode-go/deepseek-v4-flash' },
        { id: 'opencode-go/gpt-5.6-luna' },
        { id: 'opencode-go/kimi-k3' },
        { id: 'opencode-go/qwen3.8-max' },
        { id: 'openai/gpt-5.6-luna' }
      ],
      config: { defaultProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash', policy: { trusted: [] } }
    };
  }

  it('exposes the four documented lanes', () => {
    for (const lane of ['auto', 'zen', 'go', 'hitch']) {
      assert.ok(LANES[lane], `lane ${lane} must exist`);
    }
  });

  it('normalizes lane aliases and rejects junk to auto', () => {
    assert.equal(normalizeLane('opencode-go'), 'go');
    assert.equal(normalizeLane('GO'), 'go');
    assert.equal(normalizeLane('modelhitch'), 'hitch');
    assert.equal(normalizeLane('nonsense'), 'auto');
    assert.equal(normalizeLane(undefined), 'auto');
    assert.equal(isKnownLane('go'), true);
    assert.equal(isKnownLane('opencode'), true);
    assert.equal(isKnownLane('nonsense'), false);
  });

  it('routes every role to opencode-go models on the go lane', () => {
    const resolved = resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'go', state: laneState() });
    assert.equal(resolved.lane, 'go');
    assert.equal(resolved.mode, 'opencode-go');
    assert.equal(resolved.laneApplied, true);
    for (const role of ZSTACK_ROLES) {
      assert.match(resolved.models[role], /opencode-go\//, `go lane role ${role} must stay on opencode-go`);
    }
    for (const m of resolved.panelList) {
      assert.match(m, /opencode-go\//, `go lane panel member ${m} must stay on opencode-go`);
    }
  });

  it('routes every role to opencode models on the zen lane', () => {
    const resolved = resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'zen', state: laneState() });
    assert.equal(resolved.lane, 'zen');
    assert.equal(resolved.mode, 'opencode-zen');
    for (const role of ZSTACK_ROLES) {
      assert.match(resolved.models[role], /opencode\//, `zen lane role ${role} must stay on opencode`);
      assert.doesNotMatch(resolved.models[role], /opencode-go\//, `zen lane role ${role} leaked onto go`);
    }
  });

  it('selects no OpenCode models on the hitch lane', () => {
    const resolved = resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'hitch', state: laneState() });
    assert.equal(resolved.lane, 'hitch');
    assert.equal(resolved.mode, 'modelhitch-multi-provider');
    for (const role of ZSTACK_ROLES) {
      assert.doesNotMatch(resolved.models[role], /opencode/, `hitch lane role ${role} must not pin OpenCode`);
    }
  });

  it('auto lane picks zen when an OpenCode key is active and hitch when not', () => {
    const zenState = laneState();
    assert.equal(resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'auto', state: zenState }).lane, 'zen');

    const noKeys = { ...laneState(), keys: { deepseek: 'w' } };
    assert.equal(resolveBudgetMapping({ tier: 'med-high', source: 'catalog', lane: 'auto', state: noKeys }).lane, 'hitch');
  });

  it('resolves all four tiers on every lane without empty panels or roles', () => {
    for (const lane of ['auto', 'zen', 'go', 'hitch']) {
      for (const tier of Object.keys(BUDGET_TIERS)) {
        const resolved = resolveBudgetMapping({ tier, source: 'catalog', lane, state: laneState() });
        assert.ok(resolved.panelList.length >= 2, `${lane}/${tier} panel must have at least 2 members`);
        for (const role of ZSTACK_ROLES) {
          assert.ok(resolved.models[role], `${lane}/${tier} role [${role}] must have a model`);
        }
      }
    }
  });

  it('never picks a panel member the gateway does not serve', () => {
    const state = laneState();
    state.models.push({ id: 'opencode-go/glm-5.3' });
    const resolved = resolveBudgetMapping({ tier: 'high', source: 'catalog', lane: 'go', state });
    const served = new Set(state.models.map(m => m.id));
    for (const m of resolved.panelList) {
      assert.ok(served.has(m), `panel member ${m} is absent from the catalog`);
    }
  });

  it('keeps the lane choice inactive when source pins models from config', () => {
    const state = {
      keys: { opencode: 'x' },
      models: [{ id: 'myprov/my-model-flash' }],
      config: {
        defaultProviderId: 'myprov',
        defaultModel: 'my-model-flash',
        policy: { trusted: [{ providerId: 'myprov', models: ['my-model-flash', 'my-model-pro'] }] }
      }
    };
    const resolved = resolveBudgetMapping({ tier: 'med-high', source: 'config', lane: 'go', state });
    assert.equal(resolved.laneApplied, false);
    assert.equal(resolved.mode, 'modelhitch-config-pinned');
    for (const role of ZSTACK_ROLES) {
      assert.match(resolved.models[role], /myprov\//, `config source must stay on myprov for role ${role}`);
    }
  });

  it('persists and reads back the lane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zstack-lane-'));
    const file = join(dir, 'budget.json');
    saveStoredBudget({ tier: 'med-high', source: 'catalog', lane: 'go' }, file);
    assert.equal(getStoredBudget(file).lane, 'go');
    const merged = saveStoredBudget({ tier: 'high' }, file);
    assert.equal(merged.lane, 'go', 'lane must survive a tier-only update');
  });
});
