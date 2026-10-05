import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../src/serve.mjs';
import { createProject } from '../src/projects.mjs';
import { GatewayError } from '../src/connector.mjs';

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function createTempDir(prefix = 'zstack-api-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initGitRepo() {
  const dir = createTempDir('zstack-api-repo-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# Test repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function stubZStack(options = {}) {
  const calls = [];
  return {
    calls,
    baseUrl: 'http://127.0.0.1:3939',
    async status() {
      return {
        ok: true,
        baseUrl: 'http://127.0.0.1:3939',
        message: 'connected',
        activeProviders: ['opencode'],
        mode: 'catalog',
        lane: 'auto'
      };
    },
    listPlaybooks: () => [
      { id: 'feature', title: 'Feature', trigger: 'Implementing new functionality.' },
      { id: 'bug-fix', title: 'Bug fix', trigger: 'Resolving bugs.' }
    ],
    listPrinciples: () => [
      { id: 'prove-it-works', title: 'Prove it works', applyWhen: 'Before claiming done.' }
    ],
    getBudget: () => ({ tier: 'med-high', source: 'catalog', lane: 'auto' }),
    async agent(opts) {
      calls.push(opts);
      if (options.beforeCall) await options.beforeCall(calls.length, opts);
      opts.onEvent?.({ type: 'start', model: 'opencode/test-model', workspace: opts.workspaceDir || null });
      opts.onEvent?.({ type: 'tool', name: 'read_file', target: 'README.md', outcome: 'ok' });
      return {
        ok: true,
        exitCode: 0,
        turns: 1,
        toolCalls: 1,
        failedTools: 0,
        declinedTools: 0,
        durationMs: 150,
        model: 'opencode/test-model',
        playbook: opts.playbook || 'feature',
        workspaceDir: opts.workspaceDir,
        usage: { total_tokens: 120 },
        narrative: 'Done work.',
        steps: [
          { kind: 'start', turn: 0, model: 'opencode/test-model', workspace: opts.workspaceDir ?? null },
          { kind: 'tool', turn: 1, name: 'read_file', target: 'README.md', outcome: 'ok' }
        ],
        fileChanges: [{ path: 'README.md', tool: 'read_file' }],
        sessionId: 'sess-api-test',
        maxTurns: opts.maxTurns ?? null,
        turnLimitReached: false
      };
    }
  };
}

async function bootServer(options = {}) {
  const dir = createTempDir('zstack-srv-');
  const historyPath = options.historyPath ?? join(dir, 'history.jsonl');
  const projectsPath = join(dir, 'projects.json');
  const overridesPath = join(dir, 'overrides.json');
  const chatsPath = join(dir, 'chats.json');
  const schedulesPath = options.schedulesPath ?? join(dir, 'schedules.json');
  const budgetPath = options.budgetPath ?? join(dir, 'budget.json');
  const zstack = options.zstack ?? stubZStack(options);
  const started = await startServer({
    port: 0,
    zstack,
    historyPath,
    projectsPath,
    overridesPath,
    chatsPath,
    schedulesPath,
    budgetPath,
    idempotencyPath: options.idempotencyPath,
    enableScheduler: options.enableScheduler ?? false,
    apiToken: options.apiToken,
    fetchModelHitchState: options.fetchModelHitchState
  });

  const api = (path, init = {}) => {
    const url = `${started.url}api${path}`;
    const headers = { ...(init.headers || {}) };
    if (options.apiToken && !headers['authorization'] && !headers['Authorization'] && !headers['x-api-token']) {
      headers['authorization'] = `Bearer ${options.apiToken}`;
    }
    return fetch(url, { ...init, headers });
  };

  const rawApi = (path, init = {}) => fetch(`${started.url}api${path}`, init);

  return {
    ...started,
    projectsPath,
    historyPath,
    schedulesPath,
    budgetPath,
    api,
    rawApi,
    zstack,
    close: () => new Promise((r) => started.server.close(r))
  };
}

function jsonBody(payload, extra = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extra.headers || {}) },
    body: JSON.stringify(payload),
    ...extra
  };
}

describe('durable run idempotency', () => {
  it('concurrent retries start one run and preserve requester through restart', async () => {
    const dir = createTempDir('zstack-admission-');
    const historyPath = join(dir, 'history.jsonl');
    const idempotencyPath = join(dir, 'keys');
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    const zstack = stubZStack({ beforeCall: () => gate });
    const first = await bootServer({ zstack, historyPath, idempotencyPath });
    const request = { prompt: 'Inspect this API', requester: 'workfolk:job-test', idempotencyKey: 'job-test' };
    let id;
    try {
      const replies = await Promise.all(Array.from({ length: 6 }, () => first.api('/runs', jsonBody(request))));
      assert.equal(replies.filter((r) => r.status === 201).length, 1);
      assert.equal(replies.filter((r) => r.status === 200).length, 5);
      const bodies = await Promise.all(replies.map((r) => r.json()));
      id = bodies[0].id;
      assert.ok(bodies.every((b) => b.id === id));
      assert.equal(zstack.calls.length, 1);
      assert.equal(bodies[0].page.requester, request.requester);
      assert.equal((await first.api('/runs', jsonBody({ ...request, prompt: 'Changed task' }))).status, 409);
      release();
      for (let tries = 0; tries < 100 && !first.registry.get(id).persisted; tries++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(first.registry.get(id).persisted, true);
    } finally { release(); await first.close(); }
    const restartedSdk = stubZStack();
    const restarted = await bootServer({ zstack: restartedSdk, historyPath, idempotencyPath });
    try {
      const replay = await restarted.api('/runs', jsonBody(request));
      assert.equal(replay.status, 200);
      const doc = await replay.json();
      assert.equal(doc.id, id);
      assert.equal(doc.page.requester, request.requester);
      assert.equal(doc.page.idempotencyKey, request.idempotencyKey);
      assert.equal(restartedSdk.calls.length, 0);
      assert.equal((await restarted.api('/runs', jsonBody({ ...request, policy: 'apply' }))).status, 409);
    } finally { await restarted.close(); }
  });

  it('never repeats an accepted run whose history was lost in a crash', async () => {
    const { reserveRunAdmission, requestFingerprint } = await import('../src/idempotency.mjs');
    const { normalizeStartRequest } = await import('../src/runs.mjs');
    const dir = createTempDir('zstack-interrupted-');
    const request = { prompt: 'Inspect this API', idempotencyKey: 'interrupted-job', policy: 'read-only' };
    reserveRunAdmission(request.idempotencyKey, {
      id: 'accepted-before-crash',
      fingerprint: requestFingerprint({ ...normalizeStartRequest(request), workspaceDir: process.cwd() })
    }, dir);
    const server = await bootServer({ idempotencyPath: dir });
    try {
      const reply = await server.api('/runs', jsonBody(request));
      assert.equal(reply.status, 409);
      assert.equal((await reply.json()).id, 'accepted-before-crash');
      assert.equal(server.zstack.calls.length, 0);
    } finally { await server.close(); }
  });

  it('rejects malformed admission metadata before starting a run', async () => {
    const server = await bootServer();
    try {
      for (const idempotencyKey of ['', 12, 'a'.repeat(257)]) {
        assert.equal((await server.api('/runs', jsonBody({ prompt: 'Task', idempotencyKey }))).status, 400);
      }
      assert.equal(server.zstack.calls.length, 0);
    } finally { await server.close(); }
  });
});

describe('HTTP API', () => {
  it('GET /api/health returns ok and bridge status', async () => {
    const s = await bootServer();
    try {
      const res = await s.api('/health');
      assert.equal(res.status, 200);
      const doc = await res.json();
      assert.equal(doc.ok, true);
      assert.ok(doc.bridge);
      assert.equal(doc.bridge.ok, true);
      assert.equal(doc.bridge.baseUrl, 'http://127.0.0.1:3939');
    } finally {
      await s.close();
    }
  });

  it('creates a run under read-only policy in a temp workspace and reads it back via GET /api/runs/:id', async () => {
    const s = await bootServer();
    const repoDir = initGitRepo();
    try {
      // POST /api/runs -> 201 with id
      const createRes = await s.api('/runs', jsonBody({
        prompt: 'Check codebase health',
        workspace: repoDir,
        playbook: 'feature'
      }));
      assert.equal(createRes.status, 201);
      const created = await createRes.json();
      assert.equal(created.ok, true);
      assert.ok(created.id);

      // Allow background agent turn to settle
      await new Promise((r) => setTimeout(r, 100));

      // GET /api/runs/:id
      const getRes = await s.api(`/runs/${encodeURIComponent(created.id)}`);
      assert.equal(getRes.status, 200);
      const run = await getRes.json();
      assert.equal(run.ok, true);
      assert.ok(run.status);
      assert.equal(typeof run.turns, 'number');
      assert.equal(typeof run.toolCalls, 'number');
      assert.ok(Array.isArray(run.outcomes));
      assert.ok(Array.isArray(run.fileChanges));
      assert.equal(run.workspace, repoDir);

      // Verify the SDK call received policy defaults to read-only (apply: false)
      assert.equal(s.zstack.calls.length, 1);
      assert.equal(s.zstack.calls[0].apply, false);
      assert.equal(s.zstack.calls[0].playbook, 'feature');
    } finally {
      await s.close();
    }
  });

  it('enforces ZSTACK_API_TOKEN authentication with 401 on missing or invalid token', async () => {
    const token = 'test-secret-token-123';
    const s = await bootServer({ apiToken: token });
    try {
      // 1. Without token -> 401
      const noTokenRes = await s.rawApi('/health');
      assert.equal(noTokenRes.status, 401);
      const noTokenDoc = await noTokenRes.json();
      assert.equal(noTokenDoc.ok, false);
      assert.equal(noTokenDoc.error, 'Unauthorized');
      assert.ok(noTokenDoc.detail);

      // 2. With invalid token -> 401
      const badTokenRes = await s.rawApi('/health', {
        headers: { authorization: 'Bearer wrong-token' }
      });
      assert.equal(badTokenRes.status, 401);
      const badTokenDoc = await badTokenRes.json();
      assert.equal(badTokenDoc.ok, false);
      assert.equal(badTokenDoc.error, 'Unauthorized');

      // 3. With valid Bearer token -> 200
      const goodBearerRes = await s.rawApi('/health', {
        headers: { authorization: `Bearer ${token}` }
      });
      assert.equal(goodBearerRes.status, 200);

      // 4. With valid x-api-token header -> 200
      const goodHeaderRes = await s.rawApi('/health', {
        headers: { 'x-api-token': token }
      });
      assert.equal(goodHeaderRes.status, 200);
    } finally {
      await s.close();
    }
  });

  it('rejects an empty or whitespace prompt with 400', async () => {
    const s = await bootServer();
    try {
      const res = await s.api('/runs', jsonBody({ prompt: '   ' }));
      assert.equal(res.status, 400);
      const doc = await res.json();
      assert.equal(doc.ok, false);
      assert.ok(doc.error);
      assert.ok(doc.detail);
      assert.match(doc.detail, /prompt/i);
    } finally {
      await s.close();
    }
  });

  it('rejects an unknown playbook with 400 naming the offending value', async () => {
    const s = await bootServer();
    try {
      const res = await s.api('/runs', jsonBody({ prompt: 'do work', playbook: 'invented-playbook' }));
      assert.equal(res.status, 400);
      const doc = await res.json();
      assert.equal(doc.ok, false);
      assert.match(doc.error, /invented-playbook/);
      assert.match(doc.detail, /invented-playbook/);
    } finally {
      await s.close();
    }
  });

  it('rejects an unknown lane with 400 naming the offending value', async () => {
    const s = await bootServer();
    try {
      const res = await s.api('/runs', jsonBody({ prompt: 'do work', lane: 'hyperspeed' }));
      assert.equal(res.status, 400);
      const doc = await res.json();
      assert.equal(doc.ok, false);
      assert.match(doc.error, /hyperspeed/);
      assert.match(doc.detail, /hyperspeed/);
    } finally {
      await s.close();
    }
  });

  it('returns 404 for a bogus run id on GET /api/runs/:id', async () => {
    const s = await bootServer();
    try {
      const res = await s.api('/runs/non-existent-run-id');
      assert.equal(res.status, 404);
      const doc = await res.json();
      assert.equal(doc.ok, false);
      assert.ok(doc.error);
      assert.ok(doc.detail);
      assert.match(doc.error, /non-existent-run-id/);
    } finally {
      await s.close();
    }
  });

  it('returns 404 for an unknown project id', async () => {
    const s = await bootServer();
    try {
      const res = await s.api('/runs', jsonBody({ prompt: 'do work', project: 'proj-missing' }));
      assert.equal(res.status, 404);
      const doc = await res.json();
      assert.equal(doc.ok, false);
      assert.match(doc.error, /proj-missing/);
    } finally {
      await s.close();
    }
  });

  it('faults with project name when stored project directory no longer exists', async () => {
    const s = await bootServer();
    const goneDir = join(createTempDir(), 'deleted-folder');
    mkdirSync(goneDir);
    const proj = createProject({ name: 'EphemeralProject', dir: goneDir }, s.projectsPath);
    rmSync(goneDir, { recursive: true, force: true });

    try {
      const res = await s.api('/runs', jsonBody({ prompt: 'do work', project: proj.id }));
      assert.equal(res.status, 400);
      const doc = await res.json();
      assert.equal(doc.ok, false);
      assert.match(doc.error, /EphemeralProject/);
      assert.match(doc.detail, /EphemeralProject/);
    } finally {
      await s.close();
    }
  });

  it('refuses a request for a workspace outside the named project', async () => {
    const s = await bootServer();
    const projDir = createTempDir('zstack-proj-');
    const outsideDir = createTempDir('zstack-outside-');
    const proj = createProject({ name: 'InsideProject', dir: projDir }, s.projectsPath);

    try {
      const res = await s.api('/runs', jsonBody({
        prompt: 'do work',
        project: proj.id,
        workspace: outsideDir
      }));
      assert.equal(res.status, 400);
      const doc = await res.json();
      assert.equal(doc.ok, false);
      assert.match(doc.detail, /outside/i);
    } finally {
      await s.close();
    }
  });

  it('returns 409 for a second concurrent run in the same canonical git repository', async () => {
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });

    const s = await bootServer({
      beforeCall: async (callNumber) => {
        if (callNumber === 1) {
          // Hold the first run active in flight
          await gate;
        }
      }
    });

    const repoDir = initGitRepo();

    try {
      // Start run 1 in repoDir
      const run1Res = await s.api('/runs', jsonBody({ prompt: 'first run in repo', workspace: repoDir }));
      assert.equal(run1Res.status, 201);
      const run1Doc = await run1Res.json();
      assert.ok(run1Doc.id);

      // Try starting run 2 in the same repoDir while run 1 is active -> 409
      const run2Res = await s.api('/runs', jsonBody({ prompt: 'second run in repo', workspace: repoDir }));
      assert.equal(run2Res.status, 409);
      const run2Doc = await run2Res.json();
      assert.equal(run2Doc.ok, false);
      assert.ok(run2Doc.error);
      assert.ok(run2Doc.detail);
      assert.match(run2Doc.detail, /already active/i);

      // Release gate so run 1 can complete
      releaseGate();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      releaseGate?.();
      await s.close();
    }
  });

  it('closes SSE stream cleanly on client disconnect without cancelling the run', async () => {
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });

    const s = await bootServer({
      beforeCall: async () => {
        await gate;
      }
    });

    const repoDir = initGitRepo();

    try {
      // Start a run
      const runRes = await s.api('/runs', jsonBody({ prompt: 'stream and disconnect', workspace: repoDir }));
      assert.equal(runRes.status, 201);
      const { id } = await runRes.json();

      // Connect to SSE stream
      const controller = new AbortController();
      const sseRes = await s.api(`/runs/${encodeURIComponent(id)}/events`, {
        signal: controller.signal
      });
      assert.equal(sseRes.status, 200);

      // Read initial frame
      const reader = sseRes.body.getReader();
      const { value } = await reader.read();
      assert.ok(value.length > 0);

      // Client disconnects
      controller.abort();
      await reader.cancel().catch(() => {});

      // Confirm run was NOT cancelled
      const runRecord = s.app.registry.get(id);
      assert.ok(runRecord);
      assert.equal(runRecord.cancelled, false);

      // Release gate
      releaseGate();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      releaseGate?.();
      await s.close();
    }
  });

  describe('Budget HTTP API', () => {
    function mockCatalogState() {
      return {
        activeProviders: ['opencode', 'deepseek', 'openai'],
        keys: { opencode: 'sk-zen', 'opencode-go': 'sk-go' },
        models: [
          { id: 'opencode/deepseek-v4-pro' },
          { id: 'opencode/deepseek-v4-flash' },
          { id: 'opencode/claude-opus-5-5' },
          { id: 'opencode/claude-sonnet-4-6' },
          { id: 'opencode/gpt-6-sol' },
          { id: 'opencode-go/deepseek-v4-pro' },
          { id: 'opencode-go/deepseek-v4-flash' },
          { id: 'opencode-go/gpt-5.6-luna' },
          { id: 'opencode-go/kimi-k3' },
          { id: 'deepseek/deepseek-v4-flash' },
          { id: 'openai/gpt-5.6-luna' }
        ],
        config: {
          defaultProviderId: 'deepseek',
          defaultModel: 'deepseek-v4-flash',
          policy: {
            trusted: [
              { providerId: 'deepseek', models: ['deepseek-v4-flash'] },
              { providerId: 'openai', models: ['gpt-5.6-luna'] }
            ]
          }
        }
      };
    }

    it('GET /api/budget returns stored budget, resolved models, and laneApplied', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => mockCatalogState()
      });
      try {
        const res = await s.api('/budget');
        assert.equal(res.status, 200);
        const doc = await res.json();
        assert.equal(doc.ok, true);
        assert.equal(doc.tier, 'med-high');
        assert.equal(doc.source, 'catalog');
        assert.equal(doc.lane, 'auto');
        assert.equal(doc.laneApplied, true);
        assert.ok(doc.models);
        assert.ok(typeof doc.models['feature, refactoring'] === 'string');
        assert.equal(doc.effectiveFor, 'subsequently started runs');
      } finally {
        await s.close();
      }
    });

    it('GET /api/budget returns 502 with kind: unreachable when bridge is unreachable', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => {
          throw new GatewayError({ kind: 'unreachable', message: 'Bridge is down', baseUrl: 'http://127.0.0.1:3939' });
        }
      });
      try {
        const res = await s.api('/budget');
        assert.equal(res.status, 502);
        const doc = await res.json();
        assert.equal(doc.ok, false);
        assert.equal(doc.kind, 'unreachable');
        assert.match(doc.error, /Bridge is down/);
      } finally {
        await s.close();
      }
    });

    it('POST /api/budget preview (confirm: false or omitted) returns prospective mapping and does NOT write', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => mockCatalogState()
      });
      try {
        // Initial state on disk
        const initialBudget = { tier: 'med-high', source: 'catalog', lane: 'auto' };
        writeFileSync(s.budgetPath, JSON.stringify(initialBudget, null, 2) + '\n', 'utf8');

        // Preview request without confirm
        const res = await s.api('/budget', jsonBody({ tier: 'max', lane: 'zen' }));
        assert.equal(res.status, 200);
        const doc = await res.json();
        assert.equal(doc.ok, true);
        assert.equal(doc.applied, false);
        assert.equal(doc.preview, true);
        assert.equal(doc.tier, 'max');
        assert.equal(doc.lane, 'zen');
        assert.equal(doc.laneApplied, true);
        assert.ok(doc.models);

        // Verify file on disk was NOT modified
        const diskContent = JSON.parse(readFileSync(s.budgetPath, 'utf8'));
        assert.equal(diskContent.tier, 'med-high');
        assert.equal(diskContent.lane, 'auto');
      } finally {
        await s.close();
      }
    });

    it('POST /api/budget with confirm: true writes atomically and returns confirmed budget', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => mockCatalogState()
      });
      try {
        const res = await s.api('/budget', jsonBody({
          tier: 'high',
          source: 'catalog',
          lane: 'go',
          confirm: true
        }));
        assert.equal(res.status, 200);
        const doc = await res.json();
        assert.equal(doc.ok, true);
        assert.equal(doc.applied, true);
        assert.equal(doc.tier, 'high');
        assert.equal(doc.source, 'catalog');
        assert.equal(doc.lane, 'go');
        assert.equal(doc.laneApplied, true);
        assert.equal(doc.effectiveFor, 'subsequently started runs');

        // Verify file on disk was updated
        const diskContent = JSON.parse(readFileSync(s.budgetPath, 'utf8'));
        assert.equal(diskContent.tier, 'high');
        assert.equal(diskContent.source, 'catalog');
        assert.equal(diskContent.lane, 'go');
        assert.ok(diskContent.lastUpdated);
      } finally {
        await s.close();
      }
    });

    it('POST /api/budget with source: config records lane but reports laneApplied: false', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => mockCatalogState()
      });
      try {
        const res = await s.api('/budget', jsonBody({
          tier: 'high',
          source: 'config',
          lane: 'go',
          confirm: true
        }));
        assert.equal(res.status, 200);
        const doc = await res.json();
        assert.equal(doc.ok, true);
        assert.equal(doc.laneApplied, false);
        assert.equal(doc.source, 'config');
        assert.equal(doc.lane, 'go');
        assert.match(doc.note, /ModelHitch config/);

        // Disk reflects recorded lane and config source
        const diskContent = JSON.parse(readFileSync(s.budgetPath, 'utf8'));
        assert.equal(diskContent.source, 'config');
        assert.equal(diskContent.lane, 'go');
      } finally {
        await s.close();
      }
    });

    it('POST /api/budget partial updates: tier-only preserves lane and source; lane-only preserves tier and source', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => mockCatalogState()
      });
      try {
        // Set baseline
        await s.api('/budget', jsonBody({ tier: 'high', source: 'catalog', lane: 'go', confirm: true }));

        // Tier-only update
        const tierRes = await s.api('/budget', jsonBody({ tier: 'low-med', confirm: true }));
        assert.equal(tierRes.status, 200);
        const tierDoc = await tierRes.json();
        assert.equal(tierDoc.tier, 'low-med');
        assert.equal(tierDoc.source, 'catalog');
        assert.equal(tierDoc.lane, 'go');

        let disk = JSON.parse(readFileSync(s.budgetPath, 'utf8'));
        assert.equal(disk.tier, 'low-med');
        assert.equal(disk.source, 'catalog');
        assert.equal(disk.lane, 'go');

        // Lane-only update
        const laneRes = await s.api('/budget', jsonBody({ lane: 'zen', confirm: true }));
        assert.equal(laneRes.status, 200);
        const laneDoc = await laneRes.json();
        assert.equal(laneDoc.tier, 'low-med');
        assert.equal(laneDoc.source, 'catalog');
        assert.equal(laneDoc.lane, 'zen');

        disk = JSON.parse(readFileSync(s.budgetPath, 'utf8'));
        assert.equal(disk.tier, 'low-med');
        assert.equal(disk.source, 'catalog');
        assert.equal(disk.lane, 'zen');
      } finally {
        await s.close();
      }
    });

    it('POST /api/budget rejects unknown fields with 400 naming allowed fields', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => mockCatalogState()
      });
      try {
        const res = await s.api('/budget', jsonBody({ tier: 'max', workspace: '/some/path' }));
        assert.equal(res.status, 400);
        const doc = await res.json();
        assert.equal(doc.ok, false);
        assert.match(doc.error, /Unknown field\(s\): workspace/);
        assert.match(doc.error, /Allowed fields: tier, source, lane, confirm/);
      } finally {
        await s.close();
      }
    });

    it('POST /api/budget rejects invalid tier, source, lane, and confirm with 400 naming allowed sets', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => mockCatalogState()
      });
      try {
        // Bad tier
        const resTier = await s.api('/budget', jsonBody({ tier: 'turbo' }));
        assert.equal(resTier.status, 400);
        const docTier = await resTier.json();
        assert.match(docTier.error, /Unknown budget tier: "turbo"/);
        assert.match(docTier.error, /low-med, med-high, high, max/);

        // Bad source
        const resSource = await s.api('/budget', jsonBody({ source: 'azure' }));
        assert.equal(resSource.status, 400);
        const docSource = await resSource.json();
        assert.match(docSource.error, /Unknown budget source: "azure"/);
        assert.match(docSource.error, /catalog, config/);

        // Bad lane
        const resLane = await s.api('/budget', jsonBody({ lane: 'hyperspeed' }));
        assert.equal(resLane.status, 400);
        const docLane = await resLane.json();
        assert.match(docLane.error, /Unknown provider lane: "hyperspeed"/);
        assert.match(docLane.error, /auto, zen, go, hitch/);

        // Bad confirm
        const resConfirm = await s.api('/budget', jsonBody({ confirm: 'yes' }));
        assert.equal(resConfirm.status, 400);
        const docConfirm = await resConfirm.json();
        assert.match(docConfirm.error, /must be a boolean/);
      } finally {
        await s.close();
      }
    });

    it('POST /api/budget returns 502 and does NOT write when gateway is unreachable', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => {
          throw new GatewayError({ kind: 'unreachable', message: 'Connection refused', baseUrl: 'http://127.0.0.1:3939' });
        }
      });
      try {
        const initialBudget = { tier: 'med-high', source: 'catalog', lane: 'auto' };
        writeFileSync(s.budgetPath, JSON.stringify(initialBudget, null, 2) + '\n', 'utf8');

        const res = await s.api('/budget', jsonBody({ tier: 'max', confirm: true }));
        assert.equal(res.status, 502);
        const doc = await res.json();
        assert.equal(doc.ok, false);
        assert.equal(doc.kind, 'unreachable');

        // File unchanged
        const disk = JSON.parse(readFileSync(s.budgetPath, 'utf8'));
        assert.equal(disk.tier, 'med-high');
      } finally {
        await s.close();
      }
    });

    it('POST /api/budget serializes concurrent confirmed writes without corruption', async () => {
      const s = await bootServer({
        fetchModelHitchState: async () => mockCatalogState()
      });
      try {
        const tiers = ['low-med', 'med-high', 'high', 'max', 'low-med'];
        const results = await Promise.all(tiers.map((tier) =>
          s.api('/budget', jsonBody({ tier, confirm: true }))
        ));

        for (const res of results) {
          assert.equal(res.status, 200);
          const doc = await res.json();
          assert.equal(doc.ok, true);
          assert.equal(doc.applied, true);
        }

        const diskContent = readFileSync(s.budgetPath, 'utf8');
        const parsed = JSON.parse(diskContent);
        assert.ok(parsed.tier);
        assert.ok(parsed.lastUpdated);
      } finally {
        await s.close();
      }
    });

    it('GET and POST /api/budget enforce ZSTACK_API_TOKEN', async () => {
      const s = await bootServer({
        apiToken: 'test-token-12345',
        fetchModelHitchState: async () => mockCatalogState()
      });
      try {
        // Without token -> 401
        const unauthGet = await s.rawApi('/budget', { method: 'GET' });
        assert.equal(unauthGet.status, 401);

        const unauthPost = await s.rawApi('/budget', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tier: 'max' })
        });
        assert.equal(unauthPost.status, 401);

        // With token -> 200
        const authGet = await s.rawApi('/budget', {
          method: 'GET',
          headers: { authorization: 'Bearer test-token-12345' }
        });
        assert.equal(authGet.status, 200);

        const authPost = await s.rawApi('/budget', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer test-token-12345'
          },
          body: JSON.stringify({ tier: 'max' })
        });
        assert.equal(authPost.status, 200);
      } finally {
        await s.close();
      }
    });
  });

  describe('Schedules HTTP API', () => {
    it('creates, lists, gets, patches, runs, and deletes schedules', async () => {
      const s = await bootServer();
      const repoDir = initGitRepo();

      try {
        // 1. Initial list is empty
        const emptyRes = await s.api('/schedules');
        assert.equal(emptyRes.status, 200);
        const emptyDoc = await emptyRes.json();
        assert.equal(emptyDoc.ok, true);
        assert.deepEqual(emptyDoc.schedules, []);

        // 2. Infer schedule from text
        const inferRes = await s.api('/schedules/infer', jsonBody({
          prompt: 'Every morning at 9am check for open PRs and test failures'
        }));
        assert.equal(inferRes.status, 200);
        const inferDoc = await inferRes.json();
        assert.equal(inferDoc.ok, true);
        assert.equal(inferDoc.inferred.matched, true);
        assert.equal(inferDoc.inferred.cron, '0 9 * * *');
        assert.equal(inferDoc.inferred.cleanedPrompt, 'Check for open PRs and test failures');

        // 3. Create schedule
        const createRes = await s.api('/schedules', jsonBody({
          name: 'Morning PR Check',
          cron: '0 9 * * 1-5',
          prompt: 'Check for open PRs',
          workspace: repoDir,
          policy: 'read-only'
        }));
        assert.equal(createRes.status, 201);
        const createDoc = await createRes.json();
        assert.equal(createDoc.ok, true);
        assert.ok(createDoc.schedule.id.startsWith('sched-'));
        assert.equal(createDoc.schedule.name, 'Morning PR Check');
        assert.equal(createDoc.schedule.cron, '0 9 * * 1-5');
        assert.equal(createDoc.schedule.enabled, true);
        const schedId = createDoc.schedule.id;

        // 4. List now contains created schedule
        const listRes = await s.api('/schedules');
        assert.equal(listRes.status, 200);
        const listDoc = await listRes.json();
        assert.equal(listDoc.schedules.length, 1);
        assert.equal(listDoc.schedules[0].id, schedId);

        // 5. Get schedule by ID
        const getRes = await s.api(`/schedules/${encodeURIComponent(schedId)}`);
        assert.equal(getRes.status, 200);
        const getDoc = await getRes.json();
        assert.equal(getDoc.schedule.id, schedId);

        // 6. Patch schedule
        const patchRes = await s.api(`/schedules/${encodeURIComponent(schedId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Updated Morning Check',
            cron: '0 10 * * 1-5',
            enabled: false
          })
        });
        assert.equal(patchRes.status, 200);
        const patchDoc = await patchRes.json();
        assert.equal(patchDoc.schedule.name, 'Updated Morning Check');
        assert.equal(patchDoc.schedule.cron, '0 10 * * 1-5');
        assert.equal(patchDoc.schedule.enabled, false);

        // 7. Manual trigger via POST /api/schedules/:id/run
        const runRes = await s.api(`/schedules/${encodeURIComponent(schedId)}/run`, {
          method: 'POST'
        });
        assert.equal(runRes.status, 200);
        const runDoc = await runRes.json();
        assert.equal(runDoc.ok, true);
        assert.equal(runDoc.status, 'triggered');
        assert.ok(runDoc.runId);

        // 8. Delete schedule
        const delRes = await s.api(`/schedules/${encodeURIComponent(schedId)}`, {
          method: 'DELETE'
        });
        assert.equal(delRes.status, 200);
        const delDoc = await delRes.json();
        assert.equal(delDoc.deleted, schedId);

        // 9. Verified deleted
        const afterDelRes = await s.api(`/schedules/${encodeURIComponent(schedId)}`);
        assert.equal(afterDelRes.status, 404);
      } finally {
        await s.close();
      }
    });

    it('validates schedule input and rejects bad cron or missing project', async () => {
      const s = await bootServer();
      try {
        // Bad cron
        const badCronRes = await s.api('/schedules', jsonBody({
          cron: 'bad cron string',
          prompt: 'Do work'
        }));
        assert.equal(badCronRes.status, 400);

        // Non-existent project
        const badProjRes = await s.api('/schedules', jsonBody({
          cron: '0 9 * * *',
          prompt: 'Do work',
          projectId: 'non-existent-proj'
        }));
        assert.equal(badProjRes.status, 404);
      } finally {
        await s.close();
      }
    });
  });
});

