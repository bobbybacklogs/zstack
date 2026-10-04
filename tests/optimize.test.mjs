import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ZStack,
  optimizePrompt,
  extractOptimizedPrompt,
  buildOptimizeSystemPrompt,
  validateOptimizeRequest,
  OPTIMIZE_MAX_PROMPT_CHARS
} from '../src/index.mjs';
import { startServer } from '../src/serve.mjs';

/** A loopback gateway answering the catalogue and one completion. */
function stubGateway(handler) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

/** The SDK surface the optimize route touches, scripted. */
function stubZStack(script = {}) {
  const calls = [];
  return {
    calls,
    baseUrl: 'http://127.0.0.1:3939',
    async optimizePrompt(options) {
      calls.push(options);
      if (script.throw) {
        const err = new Error(script.throw.message || 'boom');
        if (script.throw.kind) err.kind = script.throw.kind;
        throw err;
      }
      return {
        prompt: script.prompt ?? 'Add a retry with backoff to the fetch helper.',
        original: options.prompt,
        model: 'opencode/deepseek-v4-pro',
        playbook: 'feature',
        principles: ['foundational-thinking'],
        usage: { total_tokens: 20 },
        durationMs: 30
      };
    }
  };
}

const servers = [];
after(async () => {
  await Promise.all(servers.map((close) => close()));
});

async function bootOptimize(script = {}) {
  const zstack = stubZStack(script);
  const started = await startServer({
    port: 0,
    zstack,
    historyPath: join(mkdtempSync(join(tmpdir(), 'zstack-opt-')), 'history.jsonl'),
    projectsPath: join(mkdtempSync(join(tmpdir(), 'zstack-optp-')), 'projects.json'),
    overridesPath: join(mkdtempSync(join(tmpdir(), 'zstack-opto-')), 'overrides.json'),
    chatsPath: join(mkdtempSync(join(tmpdir(), 'zstack-optc-')), 'chats.json')
  });
  const handle = {
    ...started,
    zstack,
    api: (path, init) => fetch(`${started.url}api${path}`, init),
    close: () => new Promise((r) => started.server.close(r))
  };
  servers.push(handle.close);
  return handle;
}

describe('prompt optimization', () => {
  it('cleans fences, labels, and wrapping quotes', () => {
    assert.equal(extractOptimizedPrompt('```\nFix the parser.\n```'), 'Fix the parser.');
    assert.equal(extractOptimizedPrompt('```markdown\nFix the parser.\n```'), 'Fix the parser.');
    assert.equal(extractOptimizedPrompt('Optimized prompt: Fix the parser.'), 'Fix the parser.');
    assert.equal(extractOptimizedPrompt('"Fix the parser."'), 'Fix the parser.');
    assert.equal(extractOptimizedPrompt("'Fix the parser.'"), 'Fix the parser.');
    assert.equal(extractOptimizedPrompt('  Fix the parser.  '), 'Fix the parser.');
    assert.equal(extractOptimizedPrompt(''), '');
  });

  it('folds the playbook and principles into the system prompt', () => {
    const system = buildOptimizeSystemPrompt({
      playbook: 'bug-fix',
      playbookTitle: 'Bug fix',
      principles: ['fix-root-causes', 'prove-it-works']
    });
    assert.match(system, /bug-fix \(Bug fix\)/);
    assert.match(system, /fix-root-causes, prove-it-works/);
    assert.match(system, /Invent nothing/);
  });

  it('validates the request', () => {
    assert.deepEqual(validateOptimizeRequest({ prompt: 'do a thing' }), []);
    assert.ok(validateOptimizeRequest({ prompt: '   ' }).some((p) => /required/.test(p)));
    assert.ok(validateOptimizeRequest({ prompt: 42 }).some((p) => /required/.test(p)));
    assert.ok(validateOptimizeRequest({ prompt: 'x', playbook: 5 }).some((p) => /playbook must be a string/.test(p)));
    const long = 'x'.repeat(OPTIMIZE_MAX_PROMPT_CHARS + 1);
    assert.ok(validateOptimizeRequest({ prompt: long }).some((p) => /at most/.test(p)));
  });

  it('rewrites through an injected chat and cleans the result', async () => {
    const seen = [];
    const result = await optimizePrompt(
      { prompt: 'fix the flaky test', playbook: 'bug-fix', principles: ['fix-root-causes'] },
      {
        chat: async ({ messages }) => {
          seen.push(messages);
          return { content: '```\nFix the flaky retry test and prove it with a regression test.\n```', model: 'm/x', usage: { total_tokens: 4 }, durationMs: 9 };
        }
      }
    );
    assert.equal(result.prompt, 'Fix the flaky retry test and prove it with a regression test.');
    assert.equal(result.model, 'm/x');
    assert.equal(seen[0][0].role, 'system');
    assert.match(seen[0][0].content, /bug-fix/);
    assert.equal(seen[0][1].content, 'fix the flaky test');
  });

  it('refuses an empty prompt and an empty rewrite', async () => {
    await assert.rejects(() => optimizePrompt({ prompt: '  ' }), /required/);
    await assert.rejects(
      () => optimizePrompt({ prompt: 'x' }, { chat: async () => ({ content: '   ' }) }),
      (err) => err.kind === 'empty-optimization'
    );
  });
});

describe('ZStack.optimizePrompt', () => {
  it('classifies, resolves a model, and returns the cleaned prompt', async () => {
    const seen = [];
    const gateway = await stubGateway((req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/config') return res.end(JSON.stringify({ keys: { opencode: 'k' } }));
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'opencode/deepseek-v4-pro' }] }));
      seen.push(JSON.parse(body));
      res.end(JSON.stringify({
        model: 'opencode/deepseek-v4-pro',
        choices: [{ message: { content: 'Optimized prompt: Add a retry with backoff to the fetch helper.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
      }));
    });
    try {
      const z = new ZStack({ baseUrl: gateway.url });
      const result = await z.optimizePrompt('add a retry to the fetch helper');
      assert.equal(result.prompt, 'Add a retry with backoff to the fetch helper.');
      assert.equal(result.original, 'add a retry to the fetch helper');
      assert.equal(result.playbook, 'feature');
      assert.ok(result.role);
      assert.equal(seen.length, 1, 'one completion was dispatched');
    } finally {
      await gateway.close();
    }
  });

  it('accepts the string form', async () => {
    const gateway = await stubGateway((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/config') return res.end(JSON.stringify({ keys: { opencode: 'k' } }));
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'opencode/deepseek-v4-pro' }] }));
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: 'Clearer text.' } }], usage: { total_tokens: 1 } }));
    });
    try {
      const z = new ZStack({ baseUrl: gateway.url });
      const result = await z.optimizePrompt('make it clearer');
      assert.equal(result.prompt, 'Clearer text.');
    } finally {
      await gateway.close();
    }
  });
});

describe('optimize HTTP surface', () => {
  it('rewrites a prompt and echoes its classification', async () => {
    const s = await bootOptimize({ prompt: 'A tighter request.' });
    const res = await s.api('/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'too vague' })
    });
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.prompt, 'A tighter request.');
    assert.equal(doc.original, 'too vague');
    assert.equal(doc.playbook, 'feature');
    assert.equal(s.zstack.calls[0].prompt, 'too vague');
    await s.close();
  });

  it('reports validation problems with 400 and writes nothing', async () => {
    const s = await bootOptimize();
    const res = await s.api('/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '  ' })
    });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).problems.length >= 1);
    assert.equal(s.zstack.calls.length, 0);
    await s.close();
  });

  it('rejects the wrong method with 405', async () => {
    const s = await bootOptimize();
    assert.equal((await s.api('/optimize')).status, 405);
    await s.close();
  });

  it('maps a gateway timeout to 504', async () => {
    const s = await bootOptimize({ throw: { message: 'Request timed out', kind: 'timeout' } });
    const res = await s.api('/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'something' })
    });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).kind, 'timeout');
    await s.close();
  });
});
