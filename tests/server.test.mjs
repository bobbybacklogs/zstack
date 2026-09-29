import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { request as httpRequest } from 'node:http';
import {
  startServer,
  createApp,
  resolveStaticPath,
  isLoopback,
  WEB_ROOT,
  DEFAULT_HOST,
  DEFAULT_PORT
} from '../src/serve.mjs';
import { appendHistory } from '../src/history.mjs';
import { RunRegistry } from '../src/runs.mjs';

function tmpHistory() {
  return join(mkdtempSync(join(tmpdir(), 'zstack-srv-')), 'history.jsonl');
}

/** The SDK surface the server touches, scripted. */
function stubZStack(script = {}) {
  const calls = [];
  const events = script.events || [];
  return {
    calls,
    baseUrl: 'http://127.0.0.1:3939',
    timeoutMs: 30000,
    async status() {
      if (script.statusThrow) throw new Error(script.statusThrow);
      return script.status ?? {
        ok: true,
        baseUrl: 'http://127.0.0.1:3939',
        message: 'connected',
        activeProviders: ['opencode', 'deepseek'],
        mode: 'catalog',
        lane: 'auto',
        laneInfo: { name: 'Auto' },
        mapping: { 'feature, refactoring': 'opencode/deepseek-v4-pro' },
        panelModels: ['a', 'b'],
        budget: { tier: 'med-high', source: 'catalog', lane: 'auto' },
        budgetDetail: { laneApplied: true }
      };
    },
    getBudget: () => script.budget ?? { tier: 'med-high', source: 'catalog', lane: 'auto' },
    async setBudget(tier, source, lane) {
      if (script.setBudgetThrow) throw new Error(script.setBudgetThrow);
      calls.push({ tier, source, lane });
      return script.mapping ?? {
        models: { 'feature, refactoring': 'opencode/deepseek-v4-pro' },
        laneApplied: script.laneApplied !== false,
        panelList: ['a', 'b', 'c']
      };
    },
    listPlaybooks: () => script.playbooks ?? [
      { id: 'feature', title: 'Feature', trigger: 'Implementing new functionality.' },
      { id: 'bug-fix', title: 'Bug fix', trigger: 'Resolving bugs.' }
    ],
    listPrinciples: () => script.principles ?? [
      { id: 'prove-it-works', title: 'Prove it works', applyWhen: 'Before claiming done.' }
    ],
    async agent(options) {
      calls.push(options);
      if (script.beforeEvents) await script.beforeEvents(options);
      for (const event of events) {
        if (options.signal?.aborted) break;
        options.onEvent?.(event);
      }
      if (script.throw) {
        const err = new Error(script.throw);
        if (script.kind) err.kind = script.kind;
        throw err;
      }
      const workspaceDir = script.workspaceDir === null ? undefined : (script.workspaceDir ?? '/repo');
      return {
        ok: true,
        exitCode: 0,
        turns: 1,
        toolCalls: 1,
        failedTools: 0,
        declinedTools: 0,
        durationMs: 800,
        model: 'opencode/deepseek-v4-pro',
        playbook: 'feature',
        role: 'feature, refactoring',
        workspaceDir,
        usage: { total_tokens: 300 },
        narrative: 'All done.',
        steps: [{ kind: 'start', turn: 0, model: 'opencode/deepseek-v4-pro', workspace: workspaceDir ?? null }],
        fileChanges: []
      };
    }
  };
}

/** Boot a server on an ephemeral port and hand back its base URL. */
async function boot(options = {}) {
  const historyPath = options.historyPath ?? tmpHistory();
  const projectsPath = options.projectsPath
    ?? join(mkdtempSync(join(tmpdir(), 'zstack-srvproj-')), 'projects.json');
  // Every path the server writes to is isolated per boot. History and projects
  // already were; overrides joins them, because a leaked sidecar from one test
  // would rename, move, or hide another test's runs — and once leaked past the
  // suite, a real operator's.
  const overridesPath = options.overridesPath
    ?? join(mkdtempSync(join(tmpdir(), 'zstack-srvovr-')), 'run-overrides.json');
  const script = options.script ?? {};
  // The default stub result claims a fixed directory. A test that asserts the
  // run executes somewhere specific overrides it, so the fixture cannot win
  // against the code under test.
  if (script.workspaceDir === undefined && options.stubWorkspaceDir !== undefined) {
    script.workspaceDir = options.stubWorkspaceDir;
  }
  const zstack = options.zstack ?? stubZStack(script);
  const started = await startServer({ port: 0, zstack, historyPath, projectsPath, overridesPath });
  return {
    ...started,
    historyPath,
    projectsPath,
    overridesPath,
    zstack,
    api: (path, init) => fetch(`${started.url}api${path}`, init),
    close: () => new Promise((r) => started.server.close(r))
  };
}

const servers = [];
after(async () => {
  await Promise.all(servers.map((s) => s()));
});

async function bootTracked(options) {
  const s = await boot(options);
  servers.push(s.close);
  return s;
}

function json(body, extra = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extra.headers || {}) },
    body: JSON.stringify(body),
    ...extra
  };
}

/**
 * A GET with headers under the caller's control.
 *
 * `fetch` treats `Host` as a forbidden header and drops it, so a test of the
 * host allowlist has to go through `node:http` to send one that is not real.
 */
function rawGet(url, headers = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolvePromise({ status: res.statusCode, body }));
      }
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

const runEvents = [
  { type: 'run-start', model: 'deepseek-v4-pro', provider: 'opencode-go', workspace: '/repo', playbook: 'feature' },
  { type: 'turn', turn: 1, tokens: 100 },
  { type: 'text', turn: 1, text: 'Working on it.' },
  { type: 'tool', turn: 1, name: 'read', args: { file_path: 'a.js' }, outcome: 'ok', durationMs: 2 },
  { type: 'done', turns: 1, tokens: 400, tools: 1, durationMs: 900 }
];

/**
 * Read an SSE stream until it closes or a deadline passes, returning the parsed
 * frames. Used instead of a client library so the wire format is under test.
 */
async function readSse(url, { headers = {}, until = 1, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames = [];
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame = { comments: [], data: null, id: null, event: null };
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) frame.comments.push(line);
          else if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
          else if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
        }
        frames.push(frame);
        if (frames.length >= until && frame.event === 'end') {
          controller.abort();
          return { frames, headers: res.headers, status: res.status, closed: true };
        }
      }
      if (frames.some((f) => f.event === 'end')) {
        controller.abort();
        return { frames, headers: res.headers, status: res.status, closed: true };
      }
    }
    return { frames, headers: res.headers, status: res.status, closed: true };
  } catch (err) {
    if (err.name === 'AbortError') return { frames, closed: false, timeout: true };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

describe('static path safety', () => {
  it('accepts ordinary asset paths', () => {
    assert.equal(resolveStaticPath('/'), join(WEB_ROOT, 'index.html'));
    assert.equal(resolveStaticPath('/app.js'), join(WEB_ROOT, 'app.js'));
    assert.equal(resolveStaticPath('/nested/thing.css'), join(WEB_ROOT, 'nested', 'thing.css'));
  });

  it('refuses every escape it can be handed', () => {
    // A URL that becomes a filesystem read is the one path that must not be
    // optimistic, so each encoding gets its own case.
    for (const bad of [
      '/../package.json',
      '/../../etc/passwd',
      '/a/../../package.json',
      '/%2e%2e/package.json',
      '/%2e%2e%2fpackage.json',
      '/..%2fpackage.json',
      '/%2e%2e%5cpackage.json',
      '/sub/../../src/serve.mjs',
      '/app.js%00.png',
      '/\\..\\package.json'
    ]) {
      assert.equal(resolveStaticPath(bad), null, `should refuse ${bad}`);
    }
  });

  it('keeps every accepted path inside the web root', () => {
    const root = resolve(WEB_ROOT);
    for (const ok of ['/', '/app.js', '/a/b/c/d.css']) {
      const resolved = resolveStaticPath(ok);
      assert.ok(resolved === root || resolved.startsWith(root + sep), `${ok} escaped`);
    }
  });

  it('treats only loopback as a safe default bind', () => {
    assert.equal(isLoopback('127.0.0.1'), true);
    assert.equal(isLoopback('localhost'), true);
    assert.equal(isLoopback('::1'), true);
    assert.equal(isLoopback('0.0.0.0'), false);
    assert.equal(isLoopback('192.168.1.5'), false);
    assert.equal(DEFAULT_HOST, '127.0.0.1');
    assert.equal(DEFAULT_PORT, 4141);
  });
});

describe('read endpoints', () => {
  it('reports bridge health and the policies it can honour', async () => {
    const s = await bootTracked();
    const res = await s.api('/health');
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.bridge.ok, true);
    assert.deepEqual(doc.bridge.providers, ['opencode', 'deepseek']);
    assert.deepEqual(doc.policies.map((p) => p.id), ['read-only', 'apply', 'strict']);
    // The effective history path, not the null a caller passed in.
    assert.equal(doc.history.path, s.historyPath);
    await s.close();
  });

  it('reports an unreachable bridge as a state, not an error', async () => {
    const s = await bootTracked({
      script: { status: { ok: false, baseUrl: 'http://127.0.0.1:3939', error: 'ECONNREFUSED' } }
    });
    const res = await s.api('/health');
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.bridge.ok, false);
    assert.equal(doc.bridge.error, 'ECONNREFUSED');
    await s.close();
  });

  it('lists playbooks, principles, lanes, tiers, and the stored budget', async () => {
    const s = await bootTracked();
    const doc = await (await s.api('/config')).json();
    assert.deepEqual(doc.tiers, ['low-med', 'med-high', 'high', 'max']);
    assert.deepEqual(doc.sources, ['config', 'catalog']);
    assert.deepEqual(doc.lanes.map((l) => l.id), ['auto', 'zen', 'go', 'hitch']);
    assert.equal(doc.playbooks[0].id, 'feature');
    assert.equal(doc.principles[0].id, 'prove-it-works');
    assert.equal(doc.budget.tier, 'med-high');
    await s.close();
  });

  it('merges live runs into the archived list without duplicating them', async () => {
    const historyPath = tmpHistory();
    appendHistory({ command: 'agent', promptPreview: 'old archived run', promptChars: 17, ok: true, steps: [] }, historyPath);
    const s = await bootTracked({
      historyPath,
      script: { events: runEvents, beforeEvents: () => new Promise((r) => setTimeout(r, 30)) }
    });

    const started = await (await s.api('/runs', json({ prompt: 'a brand new run' }))).json();
    const doc = await (await s.api('/runs')).json();
    assert.equal(doc.ok, true);
    // The live run has not finished, so it is not in history yet, and the list
    // must still show it.
    assert.ok(doc.runs.some((r) => r.id === started.id), 'live run must appear');
    assert.ok(doc.runs.some((r) => r.title === 'old archived run'));
    assert.equal(doc.runs.length, 2, 'no run may be listed twice');
    await s.close();
  });

  it('reports how many runs are still going', async () => {
    const s = await bootTracked({
      script: { events: runEvents, beforeEvents: () => new Promise((r) => setTimeout(r, 30)) }
    });
    await s.api('/runs', json({ prompt: 'live one' }));
    const doc = await (await s.api('/runs')).json();
    assert.equal(doc.liveCount, 1);
    await s.close();
  });

  it('serves an archived run as a page projected from history', async () => {
    const historyPath = tmpHistory();
    appendHistory({
      id: 'archived-1',
      command: 'agent',
      playbook: 'feature',
      model: 'opencode/deepseek-v4-pro',
      promptPreview: 'archived page',
      promptChars: 13,
      ok: true,
      agentic: true,
      applied: true,
      workspace: '/repo',
      turns: 1,
      toolCalls: 1,
      steps: [
        { kind: 'start', turn: 0, model: 'opencode/deepseek-v4-pro', workspace: '/repo' },
        { kind: 'turn', turn: 1, tokens: 10 },
        { kind: 'tool', turn: 1, name: 'edit', target: 'a.js', outcome: 'ok', durationMs: 5 }
      ],
      fileChanges: [{ path: 'a.js', tool: 'edit', turn: 1 }],
      narrative: 'I edited the file.'
    }, historyPath);
    const s = await bootTracked({ historyPath });

    const res = await s.api('/runs/archived-1');
    assert.equal(res.status, 200);
    const { page } = await res.json();
    assert.equal(page.id, 'archived-1');
    assert.equal(page.live, false);
    assert.equal(page.status, 'ok');
    assert.equal(page.title, 'archived page');
    assert.ok(page.blocks.some((b) => b.kind === 'tool' && b.target === 'a.js'));
    assert.ok(page.blocks.some((b) => b.kind === 'prose' && b.text === 'I edited the file.'));
    assert.equal(page.props.find((p) => p.key === 'policy').value, 'apply');
    await s.close();
  });

  it('answers an unknown run with 404 rather than an empty page', async () => {
    const s = await bootTracked();
    const res = await s.api('/runs/does-not-exist');
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /No run with id/);
    await s.close();
  });

  it('answers an unknown endpoint with 404', async () => {
    const s = await bootTracked();
    const res = await s.api('/nope');
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /No such endpoint/);
    await s.close();
  });

  it('refuses the wrong method on a known path', async () => {
    const s = await bootTracked();
    const res = await s.api('/health', { method: 'DELETE' });
    assert.equal(res.status, 405);
    await s.close();
  });
});

describe('starting and controlling runs', () => {
  it('accepts a run and returns its id and first page', async () => {
    const s = await bootTracked({ script: { events: runEvents } });
    const res = await s.api('/runs', json({ prompt: 'do the thing', playbook: 'feature' }));
    assert.equal(res.status, 202);
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.ok(doc.id);
    assert.equal(doc.page.title, 'do the thing');
    assert.equal(doc.page.live, true);
    await s.close();
  });

  it('reports every problem with a request at once', async () => {
    const s = await bootTracked();
    const res = await s.api('/runs', json({ prompt: '', lane: 'turbo', maxTurns: -1 }));
    assert.equal(res.status, 400);
    const doc = await res.json();
    assert.equal(doc.ok, false);
    assert.equal(doc.problems.length, 3);
    assert.match(doc.problems.join(' '), /needs a prompt/);
    assert.match(doc.problems.join(' '), /Unknown lane/);
    assert.match(doc.problems.join(' '), /maxTurns/);
    await s.close();
  });

  it('rejects a body that is not JSON and one that is not an object', async () => {
    const s = await bootTracked();
    const bad = await s.api('/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not valid JSON/);

    const arr = await s.api('/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2]' });
    assert.equal(arr.status, 400);
    assert.match((await arr.json()).error, /must be a JSON object/);
    await s.close();
  });

  it('refuses a body larger than it will buffer', async () => {
    const s = await bootTracked();
    const res = await s.api('/runs', json({ prompt: 'x'.repeat(300 * 1024) }));
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /larger than/);
    await s.close();
  });

  it('refuses a state-changing request from another origin', async () => {
    const s = await bootTracked();
    // The endpoints that start runs execute shell commands, so a page on
    // another site must not be able to reach them through the browser.
    const res = await s.api('/runs', json({ prompt: 'drive by' }, { headers: { origin: 'http://evil.example' } }));
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /Cross-origin/);
    await s.close();
  });

  it('allows its own origin through', async () => {
    const s = await bootTracked({ script: { events: runEvents } });
    const res = await s.api('/runs', json({ prompt: 'same origin' }, { headers: { origin: `http://127.0.0.1:${s.port}` } }));
    assert.equal(res.status, 202);
    await s.close();
  });

  it('refuses a request addressed to a name it does not answer for', async () => {
    const s = await bootTracked();
    // DNS rebinding: a page can point a name it controls at 127.0.0.1, and the
    // browser then treats it as same-origin, so the Origin check never fires.
    // The Host header still carries the attacker's name.
    const res = await rawGet(`${s.url}api/health`, { host: 'evil.example' });
    assert.equal(res.status, 403);
    assert.match(JSON.parse(res.body).error, /does not answer for host/);
    await s.close();
  });

  it('answers to any loopback spelling', async () => {
    const s = await bootTracked();
    for (const host of [`localhost:${s.port}`, `127.0.0.1:${s.port}`, `[::1]:${s.port}`]) {
      const res = await rawGet(`${s.url}api/health`, { host });
      assert.equal(res.status, 200, `host ${host} should be allowed`);
    }
    // A name that merely looks local is not local.
    const sneak = await rawGet(`${s.url}api/health`, { host: `localhost.evil.example:${s.port}` });
    assert.equal(sneak.status, 403);
    await s.close();
  });

  it('cancels a running run and reports that it stopped', async () => {
    const s = await bootTracked({
      script: {
        beforeEvents: (options) =>
          new Promise((resolve) => {
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        result: { ok: false, exitCode: 1, turns: 0, toolCalls: 0 }
      }
    });
    const started = await (await s.api('/runs', json({ prompt: 'a long one' }))).json();
    const cancelled = await (await s.api(`/runs/${started.id}/cancel`, { method: 'POST' })).json();
    assert.equal(cancelled.cancelled, true);

    for (let i = 0; i < 100; i++) {
      const page = (await (await s.api(`/runs/${started.id}`)).json()).page;
      if (page.status === 'cancelled') {
        assert.equal(page.blocks.at(-1).label, 'Run stopped');
        await s.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail('run never reported itself as cancelled');
  });

  it('answers 404 when asked to cancel a run it does not own', async () => {
    const s = await bootTracked();
    const res = await s.api('/runs/unknown-id/cancel', { method: 'POST' });
    assert.equal(res.status, 404);
    await s.close();
  });
});

describe('budget and status', () => {
  it('applies a budget change and reports the resolved models', async () => {
    const s = await bootTracked();
    const res = await s.api('/budget', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'max', source: 'catalog', lane: 'go' })
    });
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.laneApplied, true);
    assert.deepEqual(s.zstack.calls[0], { tier: 'max', source: 'catalog', lane: 'go' });
    await s.close();
  });

  it('explains when the lane was recorded but not applied', async () => {
    const s = await bootTracked({ script: { laneApplied: false } });
    const doc = await (await s.api('/budget', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'high' })
    })).json();
    assert.equal(doc.laneApplied, false);
    assert.match(doc.note, /config/);
    await s.close();
  });

  it('rejects a bad tier with 400', async () => {
    const s = await bootTracked({ script: { setBudgetThrow: 'Unknown budget tier: turbo.' } });
    const res = await s.api('/budget', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'turbo' })
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown budget tier/);
    await s.close();
  });

  it('reports role mappings from the bridge', async () => {
    const s = await bootTracked();
    const doc = await (await s.api('/status')).json();
    assert.equal(doc.connected, true);
    assert.equal(doc.mapping['feature, refactoring'], 'opencode/deepseek-v4-pro');
    assert.equal(doc.laneApplied, true);
    await s.close();
  });

  it('reports a disconnected bridge without failing the request', async () => {
    const s = await bootTracked({ script: { statusThrow: 'socket hang up' } });
    const res = await s.api('/status');
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.connected, false);
    assert.match(doc.error, /socket hang up/);
    await s.close();
  });
});

describe('run event stream', () => {
  it('replays a finished run and closes the stream', async () => {
    const s = await bootTracked({ script: { events: runEvents } });
    const started = await (await s.api('/runs', json({ prompt: 'replay me' }))).json();
    // Give the run time to finish so this exercises the backlog path.
    await new Promise((r) => setTimeout(r, 60));

    const { frames, headers, closed } = await readSse(`${s.url}api/runs/${started.id}/events`);
    assert.match(headers.get('content-type'), /text\/event-stream/);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.equal(closed, true, 'a finished run must not hold the stream open');

    assert.equal(frames[0].event, 'open');
    assert.equal(frames.at(-1).event, 'end');
    assert.deepEqual(frames.map((f) => f.id), frames.map((_, i) => i + 1));

    const blocks = frames.filter((f) => f.event === 'blocks');
    assert.ok(blocks.length >= 3);
    const kinds = blocks.flatMap((f) => f.data.items.map((i) => i.block.kind));
    assert.ok(kinds.includes('tool') && kinds.includes('summary'));
    await s.close();
  });

  it('streams a run that is still going, then closes when it ends', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const s = await bootTracked({
      script: {
        beforeEvents: async (options) => {
          options.onEvent(runEvents[0]);
          await gate;
          for (const event of runEvents.slice(1)) options.onEvent(event);
        }
      }
    });
    const started = await (await s.api('/runs', json({ prompt: 'live stream' }))).json();

    const controller = new AbortController();
    const res = await fetch(`${s.url}api/runs/${started.id}/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames = [];

    const pump = async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (raw.startsWith(':')) continue;
          const event = /event: (.+)/.exec(raw)?.[1];
          const data = JSON.parse(/data: (.+)/.exec(raw)[1]);
          frames.push({ event, data });
        }
      }
    };
    const pumping = pump();

    // The opening event arrives while the run is still in flight, which is the
    // whole point of the stream.
    for (let i = 0; i < 200 && !frames.some((f) => f.event === 'blocks'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(frames.some((f) => f.event === 'blocks'), 'a live run must stream before it ends');
    assert.ok(!frames.some((f) => f.event === 'end'), 'the stream must stay open while running');

    release();
    for (let i = 0; i < 200 && !frames.some((f) => f.event === 'end'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(frames.some((f) => f.event === 'end'), 'the stream must close when the run ends');
    controller.abort();
    await pumping.catch(() => {});
    await s.close();
  });

  it('resumes from the last id a client saw, with no gap', async () => {
    const s = await bootTracked({ script: { events: runEvents } });
    const started = await (await s.api('/runs', json({ prompt: 'resume me' }))).json();
    await new Promise((r) => setTimeout(r, 60));

    const whole = await readSse(`${s.url}api/runs/${started.id}/events`);
    const cut = whole.frames[2].id;

    const resumed = await readSse(`${s.url}api/runs/${started.id}/events`, {
      headers: { 'last-event-id': String(cut) }
    });
    const expected = whole.frames.filter((f) => f.id > cut).map((f) => f.id);
    assert.deepEqual(resumed.frames.map((f) => f.id), expected);
    assert.ok(resumed.frames.length > 0);
    await s.close();
  });

  it('accepts the resume point as a query parameter too', async () => {
    const s = await bootTracked({ script: { events: runEvents } });
    const started = await (await s.api('/runs', json({ prompt: 'resume by query' }))).json();
    await new Promise((r) => setTimeout(r, 60));

    const whole = await readSse(`${s.url}api/runs/${started.id}/events`);
    const cut = whole.frames[1].id;
    const resumed = await readSse(`${s.url}api/runs/${started.id}/events?since=${cut}`);
    assert.deepEqual(resumed.frames.map((f) => f.id), whole.frames.filter((f) => f.id > cut).map((f) => f.id));
    await s.close();
  });

  it('answers 404 for the stream of a run it does not have', async () => {
    const s = await bootTracked();
    const res = await fetch(`${s.url}api/runs/missing/events`);
    assert.equal(res.status, 404);
    await s.close();
  });
});

describe('projects', () => {
  function tmpDir() {
    return mkdtempSync(join(tmpdir(), 'zstack-srvdir-'));
  }

  it('lists no projects at first', async () => {
    const s = await bootTracked();
    const doc = await (await s.api('/projects')).json();
    assert.equal(doc.ok, true);
    assert.deepEqual(doc.projects, []);
    assert.ok(typeof doc.path === 'string' && doc.path.endsWith('projects.json'));
    await s.close();
  });

  it('creates a project and reads it back', async () => {
    const s = await bootTracked();
    const dir = tmpDir();
    const created = await (await s.api('/projects', json({ name: 'Site', dir }))).json();
    assert.equal(created.ok, true);
    assert.equal(created.project.name, 'Site');
    assert.equal(created.project.dir, dir);
    assert.ok(created.project.id.startsWith('p-'));
    assert.equal(created.project.defaultPlaybook, null);
    assert.equal(created.project.defaultPolicy, null);

    const listed = await (await s.api('/projects')).json();
    assert.equal(listed.projects.length, 1);
    assert.equal(listed.projects[0].id, created.project.id);
    await s.close();
  });

  it('stores and validates project defaults', async () => {
    const s = await bootTracked();
    const dir = tmpDir();
    // The stub catalogue names feature and bug-fix, so both are accepted.
    const created = await (await s.api('/projects', json({
      name: 'Site', dir, defaultPlaybook: 'feature', defaultPolicy: 'apply'
    }))).json();
    assert.equal(created.ok, true);
    assert.equal(created.project.defaultPlaybook, 'feature');
    assert.equal(created.project.defaultPolicy, 'apply');

    const bad = await s.api('/projects', json({
      name: 'Other', dir: tmpDir(), defaultPlaybook: 'nope', defaultPolicy: 'yolo'
    }));
    assert.equal(bad.status, 400);
    const doc = await bad.json();
    assert.ok(doc.problems.some((p) => p.includes('Unknown playbook')));
    assert.ok(doc.problems.some((p) => p.includes('Unknown policy')));
    await s.close();
  });

  it('clears a default by writing it empty', async () => {
    const s = await bootTracked();
    const created = await (await s.api('/projects', json({
      name: 'Site', dir: tmpDir(), defaultPlaybook: 'feature', defaultPolicy: 'apply'
    }))).json();
    const put = (body) => s.api(`/projects/${created.project.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const updated = await (await put({ defaultPolicy: '' })).json();
    assert.equal(updated.ok, true);
    assert.equal(updated.project.defaultPolicy, null);
    assert.equal(updated.project.defaultPlaybook, 'feature');
    await s.close();
  });

  it('annotates a run page with its project name', async () => {
    const s = await bootTracked({ script: { events: runEvents, workspaceDir: null } });
    const created = await (await s.api('/projects', json({ name: 'Site', dir: tmpDir() }))).json();
    const started = await (await s.api('/runs', json({ prompt: 'named page', projectId: created.project.id }))).json();
    await new Promise((r) => setTimeout(r, 80));
    const run = await (await s.api(`/runs/${started.id}`)).json();
    assert.equal(run.ok, true);
    assert.equal(run.page.projectId, created.project.id);
    assert.equal(run.page.projectName, 'Site');
    await s.close();
  });

  it('leaves the project name off a page whose project is gone', async () => {
    const s = await bootTracked({ script: { events: runEvents, workspaceDir: null } });
    const created = await (await s.api('/projects', json({ name: 'Site', dir: tmpDir() }))).json();
    const started = await (await s.api('/runs', json({ prompt: 'orphaned page', projectId: created.project.id }))).json();
    await new Promise((r) => setTimeout(r, 80));
    await s.api(`/projects/${created.project.id}`, { method: 'DELETE' });
    const run = await (await s.api(`/runs/${started.id}`)).json();
    assert.equal(run.ok, true);
    assert.equal(run.page.projectId, created.project.id);
    assert.ok(!('projectName' in run.page));
    await s.close();
  });

  it('reports every validation problem at once', async () => {
    const s = await bootTracked();
    const res = await s.api('/projects', json({ name: '', dir: '' }));
    assert.equal(res.status, 400);
    const doc = await res.json();
    assert.equal(doc.ok, false);
    assert.ok(Array.isArray(doc.problems) && doc.problems.length >= 2);
    await s.close();
  });

  it('refuses a directory that does not exist', async () => {
    const s = await bootTracked();
    const res = await s.api('/projects', json({ name: 'Site', dir: join(tmpdir(), 'zstack-no-such-dir-xyz') }));
    assert.equal(res.status, 400);
    const doc = await res.json();
    assert.ok(doc.problems.some((p) => p.includes('does not exist')));
    await s.close();
  });

  it('refuses a duplicate name', async () => {
    const s = await bootTracked();
    const dir = tmpDir();
    await s.api('/projects', json({ name: 'Site', dir }));
    const res = await s.api('/projects', json({ name: 'site', dir: tmpDir() }));
    assert.equal(res.status, 400);
    const doc = await res.json();
    assert.ok(doc.problems.some((p) => p.includes('already exists')));
    await s.close();
  });

  it('renames a project without changing its id', async () => {
    const s = await bootTracked();
    const created = await (await s.api('/projects', json({ name: 'Site', dir: tmpDir() }))).json();
    const res = await s.api(
      `/projects/${created.project.id}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Storefront' }) }
    );
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.project.id, created.project.id);
    assert.equal(doc.project.name, 'Storefront');
    await s.close();
  });

  it('answers 404 when updating or deleting an unknown project', async () => {
    const s = await bootTracked();
    const put = await s.api('/projects/p-nope', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' })
    });
    assert.equal(put.status, 404);
    const del = await s.api('/projects/p-nope', { method: 'DELETE' });
    assert.equal(del.status, 404);
    await s.close();
  });

  it('deletes a project without touching history', async () => {
    const s = await bootTracked({ script: { events: runEvents, workspaceDir: null } });
    const created = await (await s.api('/projects', json({ name: 'Site', dir: tmpDir() }))).json();
    const started = await (await s.api('/runs', json({ prompt: 'owned', projectId: created.project.id }))).json();
    assert.equal(started.ok, true);
    await new Promise((r) => setTimeout(r, 80));

    const del = await s.api(`/projects/${created.project.id}`, { method: 'DELETE' });
    assert.equal((await del.json()).ok, true);
    assert.deepEqual((await (await s.api('/projects')).json()).projects, []);

    // The run is still in history with its projectId: deleting a project never
    // deletes work. The single-run endpoint prefers the retained live page
    // while this process still holds it, so the projectId is checked on the
    // list card, which is the archived record.
    const run = await (await s.api(`/runs/${started.id}`)).json();
    assert.equal(run.ok, true);
    const listed = await (await s.api(`/runs?limit=10`)).json();
    assert.ok(listed.runs.some((r) => r.id === started.id && r.projectId === created.project.id));
    await s.close();
  });

  it('rejects the wrong method with 405', async () => {
    const s = await bootTracked();
    const res = await s.api('/projects/some-id', { method: 'POST' });
    assert.equal(res.status, 405);
    await s.close();
  });

  it('answers 404 for a PATCH or DELETE of a run it does not have', async () => {
    const s = await bootTracked();
    const patch = await s.api('/runs/r-nope', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' })
    });
    assert.equal(patch.status, 404);
    const del = await s.api('/runs/r-nope', { method: 'DELETE' });
    assert.equal(del.status, 404);
    await s.close();
  });

  it('starts a run under a project, in the project directory', async () => {
    const dir = tmpDir();
    // The stub harness answers like the real one: it reports the directory it
    // executed in, which is the project directory the server handed it.
    const s = await bootTracked({ script: { events: runEvents, workspaceDir: dir } });
    const created = await (await s.api('/projects', json({ name: 'Site', dir }))).json();
    const started = await (await s.api('/runs', json({ prompt: 'project run', projectId: created.project.id }))).json();
    assert.equal(started.ok, true);
    await new Promise((r) => setTimeout(r, 80));

    const call = s.zstack.calls.find((c) => typeof c.prompt === 'string');
    assert.equal(call.workspaceDir, dir);

    const runs = await (await s.api(`/projects/${created.project.id}/runs`)).json();
    assert.equal(runs.ok, true);
    assert.equal(runs.project.id, created.project.id);
    assert.ok(runs.runs.some((r) => r.id === started.id && r.projectId === created.project.id));
    assert.equal(runs.runs.find((r) => r.id === started.id).workspace, dir);
    await s.close();
  });

  it('refuses a run for an unknown project', async () => {
    const s = await bootTracked();
    const res = await s.api('/runs', json({ prompt: 'where?', projectId: 'p-nope' }));
    assert.equal(res.status, 400);
    const doc = await res.json();
    assert.ok(doc.problems.some((p) => p.includes('No project')));
    await s.close();
  });

  it('refuses a run naming both a project and a workspace', async () => {
    const s = await bootTracked();
    const created = await (await s.api('/projects', json({ name: 'Site', dir: tmpDir() }))).json();
    const res = await s.api('/runs', json({
      prompt: 'ambiguous', projectId: created.project.id, workspaceDir: tmpDir()
    }));
    assert.equal(res.status, 400);
    const doc = await res.json();
    assert.ok(doc.problems.some((p) => p.includes('not both')));
    await s.close();
  });

  it('lists a project run by its project name on the main list', async () => {
    const s = await bootTracked({ script: { events: runEvents } });
    const created = await (await s.api('/projects', json({ name: 'Site', dir: tmpDir() }))).json();
    const started = await (await s.api('/runs', json({ prompt: 'named', projectId: created.project.id }))).json();
    await new Promise((r) => setTimeout(r, 80));
    const listed = await (await s.api('/runs?limit=10')).json();
    assert.equal(listed.runs.find((r) => r.id === started.id).projectName, 'Site');
    await s.close();
  });

  it('answers 404 for the runs of a project it does not have', async () => {
    const s = await bootTracked();
    const res = await s.api('/projects/p-nope/runs');
    assert.equal(res.status, 404);
    await s.close();
  });

  it('renames a run: the page and the card agree, history untouched', async () => {
    const s = await bootTracked({ script: { events: runEvents, workspaceDir: null } });
    const started = await (await s.api('/runs', json({ prompt: 'original prompt words' }))).json();
    await new Promise((r) => setTimeout(r, 80));

    const res = await s.api(`/runs/${started.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Release checklist' })
    });
    assert.equal(res.status, 200);
    const patched = await res.json();
    assert.equal(patched.ok, true);
    assert.equal(patched.page.title, 'Release checklist');

    // The re-read page and the list card carry the same title.
    const run = await (await s.api(`/runs/${started.id}`)).json();
    assert.equal(run.page.title, 'Release checklist');
    const listed = await (await s.api('/runs?limit=10')).json();
    assert.equal(listed.runs.find((r) => r.id === started.id).title, 'Release checklist');

    // The prompt preview survives in the body: renaming never destroys the
    // record of what was asked. A live page carries the full prompt (it has
    // not archived yet); an archived page carries the preview block. Either
    // way the original words are on the page, not just in the file.
    const promptProp = run.page.props.find((p) => p.key === 'prompt' && /original prompt words/.test(p.value || ''));
    const promptBlock = run.page.blocks.find((b) => b.kind === 'prose' && b.label === 'Prompt' && /original prompt words/.test(b.text || ''));
    assert.ok(promptProp || promptBlock, 'the original prompt is on the page');
    await s.close();
  });

  it('clears a custom title back to the derived one', async () => {
    const s = await bootTracked({ script: { events: runEvents, workspaceDir: null } });
    const started = await (await s.api('/runs', json({ prompt: 'original prompt words' }))).json();
    await new Promise((r) => setTimeout(r, 80));
    const patch = (body) => s.api(`/runs/${started.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    await patch({ title: 'Temporary' });
    const cleared = await (await patch({ title: '' })).json();
    assert.equal(cleared.ok, true);
    assert.match(cleared.page.title, /original prompt words/);
    await s.close();
  });

  it('refuses a bad run patch with every problem at once', async () => {
    const s = await bootTracked({ script: { events: runEvents, workspaceDir: null } });
    const started = await (await s.api('/runs', json({ prompt: 'patch me' }))).json();
    await new Promise((r) => setTimeout(r, 80));
    const res = await s.api(`/runs/${started.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 42, projectId: 'p-nope', bogus: true })
    });
    assert.equal(res.status, 400);
    const doc = await res.json();
    assert.ok(doc.problems.some((p) => p.includes('must be a string')));
    assert.ok(doc.problems.some((p) => p.includes('No project with id p-nope')));
    assert.ok(doc.problems.some((p) => p.includes('Unknown field')));
    await s.close();
  });

  it('moves a run between projects and detaches it', async () => {
    const s = await bootTracked({ script: { events: runEvents, workspaceDir: null } });
    const first = await (await s.api('/projects', json({ name: 'One', dir: tmpDir() }))).json();
    const second = await (await s.api('/projects', json({ name: 'Two', dir: tmpDir() }))).json();
    const started = await (await s.api('/runs', json({ prompt: 'movable', projectId: first.project.id }))).json();
    await new Promise((r) => setTimeout(r, 80));
    const patch = (body) => s.api(`/runs/${started.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });

    const moved = await (await patch({ projectId: second.project.id })).json();
    assert.equal(moved.page.projectId, second.project.id);
    assert.equal(moved.page.projectName, 'Two');
    const inTwo = await (await s.api(`/projects/${second.project.id}/runs`)).json();
    assert.ok(inTwo.runs.some((r) => r.id === started.id));
    const inOne = await (await s.api(`/projects/${first.project.id}/runs`)).json();
    assert.ok(!inOne.runs.some((r) => r.id === started.id));

    const detached = await (await patch({ projectId: null })).json();
    assert.equal(detached.page.projectId, null);
    assert.ok(!('projectName' in detached.page));
    await s.close();
  });

  it('deletes a run from the lists but keeps the page', async () => {
    const s = await bootTracked({ script: { events: runEvents, workspaceDir: null } });
    const created = await (await s.api('/projects', json({ name: 'Site', dir: tmpDir() }))).json();
    const started = await (await s.api('/runs', json({ prompt: 'doomed', projectId: created.project.id }))).json();
    await new Promise((r) => setTimeout(r, 80));

    const del = await s.api(`/runs/${started.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, started.id);

    // Gone from the main list and from the project page…
    const listed = await (await s.api('/runs?limit=10')).json();
    assert.ok(!listed.runs.some((r) => r.id === started.id));
    const inProject = await (await s.api(`/projects/${created.project.id}/runs`)).json();
    assert.ok(!inProject.runs.some((r) => r.id === started.id));

    // …but the page still resolves, because hiding is a list concern, not
    // erasure: the record stays in history.
    const run = await (await s.api(`/runs/${started.id}`)).json();
    assert.equal(run.ok, true);
    assert.equal(run.page.id, started.id);
    await s.close();
  });
});

describe('static client', () => {
  it('serves the client at the root', async () => {
    const s = await bootTracked();
    const res = await fetch(s.url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /zstack/i);
    await s.close();
  });

  it('answers a missing asset with 404, not an HTML page', async () => {
    const s = await bootTracked();
    const res = await fetch(`${s.url}no-such-asset.js`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    await s.close();
  });

  it('refuses a traversal attempt over HTTP', async () => {
    const s = await bootTracked();
    for (const bad of ['/../package.json', '/%2e%2e%2fpackage.json', '/..%5cpackage.json']) {
      const res = await fetch(`${s.url}${bad.slice(1)}`);
      assert.ok(res.status === 400 || res.status === 404, `${bad} returned ${res.status}`);
      const text = await res.text();
      assert.doesNotMatch(text, /"name": "zstack"/, `${bad} leaked the package manifest`);
    }
    await s.close();
  });
});

describe('binding', () => {
  it('refuses a port already in use instead of picking another', async () => {
    const first = await bootTracked();
    await assert.rejects(
      () => startServer({ port: first.port, host: '127.0.0.1', zstack: stubZStack(), historyPath: tmpHistory() }),
      (err) => {
        assert.equal(err.code, 'EADDRINUSE');
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /already in use/);
        assert.match(err.message, /--port/);
        return true;
      }
    );
    await first.close();
  });

  it('binds loopback by default', async () => {
    const s = await bootTracked();
    assert.equal(s.server.address().address, '127.0.0.1');
    await s.close();
  });

  it('builds a handler that a caller can mount itself', () => {
    const app = createApp({ zstack: stubZStack(), historyPath: tmpHistory() });
    assert.equal(typeof app.handler, 'function');
    assert.ok(app.registry instanceof RunRegistry);
    app.registry.shutdown();
  });
});
