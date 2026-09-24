import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUDGET_TIERS,
  BUDGET_SOURCES,
  getStoredBudget,
  saveStoredBudget,
  resolveBudgetMapping,
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
