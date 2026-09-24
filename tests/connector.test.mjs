import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBridgeHealth,
  fetchModelHitchState,
  resolveRoleMapping,
  sendChat,
  ZSTACK_ROLES,
  ZStack
} from '../src/index.mjs';

describe('zstack ModelHitch connector', () => {
  it('connects to local ModelHitch bridge and checks health', async () => {
    const health = await checkBridgeHealth();
    assert.equal(health.ok, true, `Bridge should be healthy: ${health.error}`);
  });

  it('fetches config and active models from ModelHitch', async () => {
    const state = await fetchModelHitchState();
    assert.ok(state.activeProviders.length > 0, 'Should have active providers in ModelHitch');
    assert.ok(state.models.length > 0, 'Should have models available in ModelHitch');
  });

  it('resolves role mapping for all 15 zstack roles', async () => {
    const state = await fetchModelHitchState();
    const mapping = resolveRoleMapping(state);
    assert.ok(mapping.mode, 'Should determine operating mode');
    for (const role of ZSTACK_ROLES) {
      assert.ok(mapping.models[role], `Role [${role}] must have assigned model`);
    }
    assert.ok(mapping.panelList.length >= 1, 'Panel list must have at least 1 model');
  });

  it('executes a live test prompt through ModelHitch', async () => {
    const state = await fetchModelHitchState();
    const mapping = resolveRoleMapping(state);
    const model = mapping.models['feature, refactoring'];
    const res = await sendChat({
      model,
      messages: [{ role: 'user', content: 'Respond with exactly: pong' }]
    });
    assert.ok(res.content.length > 0, 'Response content should not be empty');
    assert.ok(res.usage.total_tokens > 0, 'Usage should track tokens');
  });
});

describe('zstack SDK class', () => {
  const z = new ZStack();

  it('lists playbooks and principles', () => {
    const playbooks = z.listPlaybooks();
    assert.equal(playbooks.length, 15, 'Should find 15 playbooks');

    const principles = z.listPrinciples();
    assert.equal(principles.length, 20, 'Should find 20 principles');
  });

  it('classifies prompts into appropriate playbooks', () => {
    const bug = z.classifyPrompt('Fix memory leak in web socket handler');
    assert.equal(bug.type, 'perf-issue');

    const feat = z.classifyPrompt('Implement OAuth2 token rotation');
    assert.equal(feat.type, 'feature');

    const ref = z.classifyPrompt('Clean up legacy unused helper functions');
    assert.equal(ref.type, 'refactoring');
  });

  it('provides about metadata', () => {
    const meta = z.about();
    assert.equal(meta.name, 'zstack');
    assert.equal(meta.version, '0.1.0');
    assert.equal(meta.playbookCount, 15);
    assert.equal(meta.principleCount, 20);
    assert.ok(meta.subsystems.length >= 4);
  });

  it('executes a task with playbook grounding via ModelHitch', async () => {
    const res = await z.task({
      prompt: 'Respond with ONLY: "task verified"',
      playbook: 'feature'
    });
    assert.ok(res.content.includes('task verified') || res.content.length > 0);
    assert.ok(res.usage.total_tokens > 0);
    assert.equal(res.playbook, 'feature');
  });
});
