import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ZStack,
  validateChatRequest,
  chatWireMessages,
  chatTimeoutMs,
  streamChat,
  GatewayError,
  CHAT_MAX_REQUEST_MESSAGES,
  DEFAULT_CHAT_TIMEOUT_MS
} from '../src/index.mjs';
import { startServer } from '../src/serve.mjs';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A loopback server that answers an OpenAI-shaped catalogue and completion. */
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

/** The SDK surface the server's chat routes touch, scripted. */
function stubZStack(script = {}) {
  const calls = [];
  return {
    calls,
    baseUrl: 'http://127.0.0.1:3939',
    async models() {
      if (script.modelsThrow) throw new Error(script.modelsThrow);
      return script.models ?? {
        connected: true,
        activeProviders: ['opencode', 'vercel-ai-gateway'],
        models: ['opencode/deepseek-v4-pro', 'vercel-ai-gateway/poolside/laguna-s-2.1-free']
      };
    },
    async chat(options) {
      calls.push(options);
      if (script.chatThrow) {
        const err = new Error(script.chatThrow.message || 'boom');
        if (script.chatThrow.kind) err.kind = script.chatThrow.kind;
        throw err;
      }
      return {
        content: script.content ?? 'pong',
        model: options.model,
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        durationMs: 12
      };
    }
  };
}

const servers = [];
after(async () => {
  await Promise.all(servers.map((close) => close()));
});

async function bootChat(script = {}) {
  const historyPath = join(tmpDir('zstack-chat-'), 'history.jsonl');
  const projectsPath = join(tmpDir('zstack-chatproj-'), 'projects.json');
  const overridesPath = join(tmpDir('zstack-chatovr-'), 'run-overrides.json');
  const zstack = stubZStack(script);
  const started = await startServer({ port: 0, zstack, historyPath, projectsPath, overridesPath });
  const handle = {
    ...started,
    historyPath,
    zstack,
    api: (path, init) => fetch(`${started.url}api${path}`, init),
    close: () => new Promise((r) => started.server.close(r))
  };
  servers.push(handle.close);
  return handle;
}

function json(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

describe('chat request validation', () => {
  it('accepts a well-formed turn', () => {
    assert.deepEqual(
      validateChatRequest({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
      []
    );
  });

  it('reports every problem at once', () => {
    const problems = validateChatRequest({ model: '', messages: [{ role: 'narrator', content: '' }] });
    assert.ok(problems.some((p) => /needs a model/.test(p)));
    assert.ok(problems.some((p) => /role must be one of/.test(p)));
    assert.ok(problems.some((p) => /content must be a non-empty string/.test(p)));
  });

  it('refuses an empty, oversized, or non-array message list', () => {
    assert.ok(validateChatRequest({ model: 'm', messages: [] }).some((p) => /non-empty messages/.test(p)));
    assert.ok(validateChatRequest({ model: 'm', messages: 'nope' }).some((p) => /non-empty messages/.test(p)));
    const many = Array.from({ length: CHAT_MAX_REQUEST_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }));
    assert.ok(validateChatRequest({ model: 'm', messages: many }).some((p) => /at most/.test(p)));
  });

  it('rejects a non-string sessionId but allows its absence', () => {
    assert.deepEqual(validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], sessionId: undefined }), []);
    assert.ok(validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], sessionId: 5 }).some((p) => /sessionId must be a string/.test(p)));
  });

  it('strips client-only fields down to the wire shape', () => {
    assert.deepEqual(
      chatWireMessages([{ role: 'user', content: 'hi', at: '2026-01-01', tokens: 5 }]),
      [{ role: 'user', content: 'hi' }]
    );
  });
});

describe('chat timeout resolution', () => {
  it('prefers an explicit value, then the instance, then the environment', () => {
    const saved = process.env.MODELHITCH_TIMEOUT;
    try {
      delete process.env.MODELHITCH_TIMEOUT;
      assert.equal(chatTimeoutMs(1000, 2000), 1000);
      assert.equal(chatTimeoutMs(undefined, 2000), 2000);
      process.env.MODELHITCH_TIMEOUT = '7000';
      assert.equal(chatTimeoutMs(undefined, undefined), 7000);
    } finally {
      if (saved === undefined) delete process.env.MODELHITCH_TIMEOUT;
      else process.env.MODELHITCH_TIMEOUT = saved;
    }
  });

  it('falls back to the chat default, not the gateway default', () => {
    const saved = process.env.MODELHITCH_TIMEOUT;
    try {
      delete process.env.MODELHITCH_TIMEOUT;
      assert.equal(chatTimeoutMs(undefined, undefined), DEFAULT_CHAT_TIMEOUT_MS);
      assert.ok(DEFAULT_CHAT_TIMEOUT_MS > 30000, 'chat must outlast the 30s routing default');
    } finally {
      if (saved !== undefined) process.env.MODELHITCH_TIMEOUT = saved;
    }
  });
});

describe('streamChat', () => {
  it('parses SSE deltas across chunk boundaries and stops at [DONE]', async () => {
    const deltas = [];
    const gateway = await stubGateway((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // The first frame is split mid-JSON to prove the parser buffers partial
      // frames rather than dropping a delta that lands on a chunk boundary.
      res.write('data: {"model":"test/m","choices":[{"delta":{"content":"Hel');
      setTimeout(() => {
        res.write('lo"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 10);
    });
    try {
      const result = await streamChat({
        model: 'test/fallback',
        messages: [{ role: 'user', content: 'hi' }],
        baseUrl: gateway.url,
        onDelta: (text) => deltas.push(text)
      });
      assert.deepEqual(deltas, ['Hello', ' world']);
      assert.equal(result.content, 'Hello world');
      assert.equal(result.model, 'test/m');
      assert.equal(result.usage.total_tokens, 3);
    } finally {
      await gateway.close();
    }
  });

  it('falls back to the whole body when the provider ignores stream', async () => {
    const deltas = [];
    const gateway = await stubGateway((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'test/m',
        choices: [{ message: { content: 'one shot' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      }));
    });
    try {
      const result = await streamChat({
        model: 'test/m',
        messages: [{ role: 'user', content: 'hi' }],
        baseUrl: gateway.url,
        onDelta: (text) => deltas.push(text)
      });
      assert.deepEqual(deltas, ['one shot']);
      assert.equal(result.content, 'one shot');
    } finally {
      await gateway.close();
    }
  });

  it('throws a structured http error on a non-200', async () => {
    const gateway = await stubGateway((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"bad model"}');
    });
    try {
      await assert.rejects(
        () => streamChat({ model: 'x', messages: [{ role: 'user', content: 'hi' }], baseUrl: gateway.url }),
        (err) => err instanceof GatewayError && err.kind === 'http' && err.status === 400
      );
    } finally {
      await gateway.close();
    }
  });

  it('reports an external abort as an aborted request, not a failure', async () => {
    const controller = new AbortController();
    const gateway = await stubGateway((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      const keep = setTimeout(() => { if (!res.writableEnded) res.end(); }, 5000);
      res.on('close', () => clearTimeout(keep));
    });
    try {
      await assert.rejects(
        () => streamChat({
          model: 'x',
          messages: [{ role: 'user', content: 'hi' }],
          baseUrl: gateway.url,
          signal: controller.signal,
          onDelta: () => controller.abort()
        }),
        (err) => err instanceof GatewayError && err.kind === 'timeout' && /aborted/i.test(err.message)
      );
    } finally {
      await gateway.close();
    }
  });

  it('is reachable through ZStack.chat with an onDelta', async () => {
    const deltas = [];
    const gateway = await stubGateway((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const z = new ZStack({ baseUrl: gateway.url });
      const result = await z.chat({
        model: 'test/m',
        messages: [{ role: 'user', content: 'hi' }],
        onDelta: (text) => deltas.push(text)
      });
      assert.deepEqual(deltas, ['streamed']);
      assert.equal(result.content, 'streamed');
    } finally {
      await gateway.close();
    }
  });
});

describe('SDK chat against a stub gateway', () => {
  it('posts the transcript to the pinned model and forwards the session header', async () => {
    const seen = [];
    const gateway = await stubGateway((req, res, body) => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'test/model',
        choices: [{ message: { content: 'hello back' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }));
    });
    try {
      const z = new ZStack({ baseUrl: gateway.url });
      const result = await z.chat({
        model: 'test/model',
        messages: [{ role: 'user', content: 'hi' }],
        sessionId: 'chat-abc'
      });
      assert.equal(result.content, 'hello back');
      assert.equal(result.model, 'test/model');
      assert.equal(result.usage.total_tokens, 5);
      assert.equal(seen[0].url, '/v1/chat/completions');
      assert.equal(seen[0].headers['x-opencode-session'], 'chat-abc');
      assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'hi' }]);
    } finally {
      await gateway.close();
    }
  });

  it('refuses a malformed turn before any network call', async () => {
    const z = new ZStack({ baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(() => z.chat({ model: '', messages: [] }), /needs a model/);
  });

  it('lists the catalogue from the gateway', async () => {
    const gateway = await stubGateway((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/config') res.end(JSON.stringify({ keys: { opencode: 'k' } }));
      else res.end(JSON.stringify({ data: [{ id: 'b/model' }, { id: 'a/model' }] }));
    });
    try {
      const z = new ZStack({ baseUrl: gateway.url });
      const listing = await z.models();
      assert.equal(listing.connected, true);
      assert.deepEqual(listing.models, ['a/model', 'b/model']);
    } finally {
      await gateway.close();
    }
  });

  it('reports a down bridge as disconnected rather than throwing', async () => {
    // Claim a port, then close it, so the fetch is refused immediately instead
    // of waiting out a retry backoff.
    const gateway = await stubGateway((req, res) => res.end('{}'));
    const url = gateway.url;
    await gateway.close();
    const z = new ZStack({ baseUrl: url });
    const listing = await z.models();
    assert.equal(listing.connected, false);
    assert.deepEqual(listing.models, []);
    assert.ok(listing.error);
  });
});

describe('chat HTTP surface', () => {
  it('proxies one turn and returns the reply', async () => {
    const s = await bootChat({ content: 'the answer' });
    const res = await s.api('/chat', json({
      model: 'opencode/deepseek-v4-pro',
      messages: [{ role: 'user', content: 'question' }],
      sessionId: 'chat-1'
    }));
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.content, 'the answer');
    assert.equal(doc.model, 'opencode/deepseek-v4-pro');
    assert.equal(doc.usage.total_tokens, 3);
    // Forwarded whole, including the session header the SDK turns into a header.
    assert.equal(s.zstack.calls.length, 1);
    assert.equal(s.zstack.calls[0].sessionId, 'chat-1');
    assert.deepEqual(s.zstack.calls[0].messages, [{ role: 'user', content: 'question' }]);
    await s.close();
  });

  it('writes nothing to history: a chat is not a run', async () => {
    const s = await bootChat();
    const res = await s.api('/chat', json({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(res.status, 200);
    assert.equal(existsSync(s.historyPath), false);
    await s.close();
  });

  it('reports every validation problem at once with 400', async () => {
    const s = await bootChat();
    const res = await s.api('/chat', json({ model: '', messages: [] }));
    assert.equal(res.status, 400);
    const doc = await res.json();
    assert.equal(doc.ok, false);
    assert.ok(Array.isArray(doc.problems) && doc.problems.length >= 2);
    assert.equal(s.zstack.calls.length, 0);
    await s.close();
  });

  it('refuses an oversized body with 413', async () => {
    const s = await bootChat();
    const res = await s.api('/chat', json({
      model: 'm',
      messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }]
    }));
    assert.equal(res.status, 413);
    assert.equal(s.zstack.calls.length, 0);
    await s.close();
  });

  it('maps a gateway timeout to 504 and an unreachable bridge to 502', async () => {
    const timedOut = await bootChat({ chatThrow: { message: 'Request timed out', kind: 'timeout' } });
    const timeoutRes = await timedOut.api('/chat', json({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(timeoutRes.status, 504);
    assert.equal((await timeoutRes.json()).kind, 'timeout');
    await timedOut.close();

    const down = await bootChat({ chatThrow: { message: 'Cannot reach ModelHitch', kind: 'unreachable' } });
    const downRes = await down.api('/chat', json({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(downRes.status, 502);
    assert.equal((await downRes.json()).kind, 'unreachable');
    await down.close();
  });

  it('rejects the wrong method on the fixed chat path with 405', async () => {
    const s = await bootChat();
    const res = await s.api('/chat');
    assert.equal(res.status, 405);
    await s.close();
  });

  it('serves the catalogue for the pin picker', async () => {
    const s = await bootChat();
    const res = await s.api('/models');
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.connected, true);
    assert.deepEqual(doc.activeProviders, ['opencode', 'vercel-ai-gateway']);
    assert.ok(doc.models.some((m) => /free$/.test(m)));
    await s.close();
  });

  it('reports an unreachable bridge as a disconnected catalogue, not a failure', async () => {
    const s = await bootChat({ models: { connected: false, error: 'bridge down', models: [] } });
    const res = await s.api('/models');
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.connected, false);
    assert.equal(doc.error, 'bridge down');
    assert.deepEqual(doc.models, []);
    await s.close();
  });
});
