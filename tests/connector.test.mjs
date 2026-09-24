import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBridgeHealth,
  fetchModelHitchState,
  resolveRoleMapping,
  sendChat,
  ZSTACK_ROLES
} from '../src/connector.mjs';

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
