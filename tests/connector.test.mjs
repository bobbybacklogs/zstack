import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  checkBridgeHealth,
  fetchModelHitchState,
  resolveRoleMapping,
  sendChat,
  gatewayFetch,
  GatewayError,
  resolveGatewayTimeoutMs,
  DEFAULT_GATEWAY_TIMEOUT_MS,
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

  it('checks upstream pstack status on demand', async () => {
    const upstream = await z.checkUpstream();
    assert.ok(typeof upstream.hasUpdates === 'boolean');
    assert.ok(upstream.state);
  });
});

describe('gateway failure hardening (stub server)', () => {
  let server;
  let baseUrl;
  let counts;

  before(async () => {
    counts = { hang: 0, err500: 0, limited: 0, badjson: 0, post500: 0 };
    let limitedCalls = 0;
    server = createServer((req, res) => {
      if (req.url === '/hang') {
        counts.hang++;
        return; // never respond: client must hit the timeout, not hang
      }
      if (req.url === '/err500') {
        counts.err500++;
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
        return;
      }
      if (req.url === '/limited') {
        counts.limited++;
        limitedCalls++;
        if (limitedCalls === 1) {
          res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '0' });
          res.end('slow down');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/badjson') {
        counts.badjson++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('this is not json {{{');
        return;
      }
      if (req.url === '/post500' && req.method === 'POST') {
        counts.post500++;
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('post failed');
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('nope');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('classifies a stalled socket as timeout', async () => {
    const err = await gatewayFetch(`${baseUrl}/hang`, { baseUrl, timeoutMs: 200 }).then(
      () => null,
      e => e
    );
    assert.ok(err instanceof GatewayError, 'must throw GatewayError');
    assert.equal(err.kind, 'timeout');
    assert.ok(err.attempts >= 1 && err.attempts <= 3);
  });

  it('reports HTTP 500 without retrying', async () => {
    const before = counts.err500;
    const err = await gatewayFetch(`${baseUrl}/err500`, { baseUrl, timeoutMs: 2000 }).then(
      () => null,
      e => e
    );
    assert.equal(err.kind, 'http');
    assert.equal(err.status, 500);
    assert.equal(err.attempts, 1);
    assert.equal(counts.err500 - before, 1);
  });

  it('retries 429 honoring Retry-After and succeeds', async () => {
    const { data, attempts } = await gatewayFetch(`${baseUrl}/limited`, { baseUrl, timeoutMs: 2000 });
    assert.deepEqual(data, { ok: true });
    assert.equal(attempts, 2);
  });

  it('classifies invalid JSON bodies as parse errors', async () => {
    const err = await gatewayFetch(`${baseUrl}/badjson`, { baseUrl, timeoutMs: 2000 }).then(
      () => null,
      e => e
    );
    assert.equal(err.kind, 'parse');
    assert.equal(err.status, 200);
  });

  it('attempts POST endpoints exactly once', async () => {
    const before = counts.post500;
    const err = await gatewayFetch(`${baseUrl}/post500`, {
      method: 'POST',
      baseUrl,
      timeoutMs: 2000,
      body: '{}',
      headers: { 'Content-Type': 'application/json' }
    }).then(() => null, e => e);
    assert.equal(err.kind, 'http');
    assert.equal(counts.post500 - before, 1, 'POST must never auto-retry');
  });

  it('resolves the timeout from env and options', () => {
    assert.equal(resolveGatewayTimeoutMs({ timeoutMs: 500 }), 500);
    assert.equal(resolveGatewayTimeoutMs({}), DEFAULT_GATEWAY_TIMEOUT_MS);
  });

  it('never retries 404 failures', async () => {
    const err = await gatewayFetch(`${baseUrl}/missing`, { baseUrl, timeoutMs: 2000 }).then(
      () => null,
      e => e
    );
    assert.equal(err.kind, 'http');
    assert.equal(err.status, 404);
    assert.equal(err.attempts, 1);
  });
});
