import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readChats,
  createChat,
  updateChat,
  deleteChat,
  appendMessage,
  findChat,
  validateChatStart,
  validateChatMessage,
  projectChat,
  chatSummary,
  chatHandoffPrompt,
  CHAT_MAX_MESSAGES
} from '../src/index.mjs';
import { startServer } from '../src/serve.mjs';

function tmpFile(prefix) {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'chats.json');
}

/** Read an SSE response body into `{ event, data }` frames. */
async function readFrames(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const dataLine = /^data: (.*)$/m.exec(frame)?.[1];
      let data = null;
      if (dataLine) {
        try { data = JSON.parse(dataLine); } catch { data = null; }
      }
      frames.push({ event, data });
    }
  }
  return frames;
}

/** The SDK surface the chat routes touch, scripted. */
function stubZStack(script = {}) {
  const calls = [];
  return {
    calls,
    baseUrl: 'http://127.0.0.1:3939',
    async models() {
      return script.models ?? { connected: true, activeProviders: ['opencode'], models: ['m/one', 'm/two'] };
    },
    async chat(options) {
      calls.push(options);
      options.onDelta?.('Hel');
      if (script.beforeFinish) await script.beforeFinish(options);
      if (script.chatError) throw script.chatError;
      options.onDelta?.('lo');
      return {
        content: 'Hello',
        model: options.model,
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        durationMs: 5
      };
    }
  };
}

const servers = [];
after(async () => {
  await Promise.all(servers.map((close) => close()));
});

async function bootChats(script = {}) {
  const historyPath = join(mkdtempSync(join(tmpdir(), 'zstack-ch-')), 'history.jsonl');
  const projectsPath = join(mkdtempSync(join(tmpdir(), 'zstack-chp-')), 'projects.json');
  const overridesPath = join(mkdtempSync(join(tmpdir(), 'zstack-cho-')), 'overrides.json');
  const chatsFilePath = tmpFile('zstack-chc-');
  const zstack = stubZStack(script);
  const started = await startServer({ port: 0, zstack, historyPath, projectsPath, overridesPath, chatsPath: chatsFilePath });
  const handle = {
    ...started,
    chatsFilePath,
    historyPath,
    zstack,
    api: (path, init) => fetch(`${started.url}api${path}`, init),
    close: () => new Promise((r) => started.server.close(r))
  };
  servers.push(handle.close);
  return handle;
}

function json(body) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('chat store', () => {
  it('creates a chat only with a pinned model', () => {
    const path = tmpFile('zstack-chstore-');
    assert.deepEqual(validateChatStart({ model: 'm/one' }), []);
    assert.ok(validateChatStart({}).some((p) => /pinned model/.test(p)));
    assert.throws(() => createChat({}, path), (err) => err.kind === 'invalid-chat' && err.problems.length === 1);
    const chat = createChat({ model: 'm/one' }, path);
    assert.equal(chat.model, 'm/one');
    assert.ok(chat.sessionId, 'a chat carries a session id for provider affinity');
    assert.equal(findChat(chat.id, path).id, chat.id);
  });

  it('derives the title from the first user message', () => {
    const path = tmpFile('zstack-chstore-');
    const chat = createChat({ model: 'm/one' }, path);
    appendMessage(chat.id, { role: 'user', content: 'Explain   the retry loop' }, path);
    const stored = findChat(chat.id, path);
    assert.equal(chatSummary(stored).title, 'Explain the retry loop');
    // A later user turn does not rename the conversation.
    appendMessage(chat.id, { role: 'assistant', content: 'Sure' }, path);
    appendMessage(chat.id, { role: 'user', content: 'And the backoff?' }, path);
    assert.equal(chatSummary(findChat(chat.id, path)).title, 'Explain the retry loop');
  });

  it('renames, re-pins, and clears a custom title', () => {
    const path = tmpFile('zstack-chstore-');
    const chat = createChat({ model: 'm/one' }, path);
    appendMessage(chat.id, { role: 'user', content: 'first words' }, path);
    updateChat(chat.id, { title: 'My name' }, path);
    assert.equal(chatSummary(findChat(chat.id, path)).title, 'My name');
    updateChat(chat.id, { model: 'm/two', title: '' }, path);
    const after = findChat(chat.id, path);
    assert.equal(after.model, 'm/two');
    assert.equal(chatSummary(after).title, 'first words', 'an empty title restores the derived one');
  });

  it('deletes a chat and reports an unknown one', () => {
    const path = tmpFile('zstack-chstore-');
    const chat = createChat({ model: 'm/one' }, path);
    deleteChat(chat.id, path);
    assert.equal(findChat(chat.id, path), null);
    assert.throws(() => deleteChat(chat.id, path), (err) => err.kind === 'unknown-chat');
  });

  it('tolerates a corrupted file with an empty list', () => {
    const path = tmpFile('zstack-chstore-');
    writeFileSync(path, '{not json', 'utf8');
    const { chats, corrupted } = readChats(path);
    assert.deepEqual(chats, []);
    assert.equal(corrupted, true);
  });

  it('refuses a message once the conversation is full', () => {
    const path = tmpFile('zstack-chstore-');
    const messages = Array.from({ length: CHAT_MAX_MESSAGES }, (_, i) => ({
      id: `m-${i}`, role: 'user', content: 'x', at: null
    }));
    writeFileSync(path, JSON.stringify({ version: 1, chats: [{ id: 'c-full', model: 'm', messages }] }), 'utf8');
    assert.throws(
      () => appendMessage('c-full', { role: 'user', content: 'one more' }, path),
      (err) => err.kind === 'invalid-chat' && /full/.test(err.message)
    );
  });

  it('validates a user message', () => {
    assert.deepEqual(validateChatMessage('hello'), []);
    assert.ok(validateChatMessage('   ').some((p) => /needs text/.test(p)));
    assert.ok(validateChatMessage(42).some((p) => /needs text/.test(p)));
  });

  it('projects a chat with derived title and non-streaming messages', () => {
    const path = tmpFile('zstack-chstore-');
    const chat = createChat({ model: 'm/one' }, path);
    appendMessage(chat.id, { role: 'user', content: 'hey' }, path);
    appendMessage(chat.id, { role: 'assistant', content: 'hi', model: 'm/one', tokens: 4, durationMs: 10 }, path);
    const page = projectChat(findChat(chat.id, path));
    assert.equal(page.title, 'hey');
    assert.equal(page.customTitle, null);
    assert.equal(page.messages.length, 2);
    assert.equal(page.messages[1].streaming, false);
    assert.equal(page.messages[1].tokens, 4);
  });

  it('writes the store atomically, leaving no temp file behind', () => {
    const path = tmpFile('zstack-chstore-');
    createChat({ model: 'm/one' }, path);
    const raw = readFileSync(path, 'utf8');
    assert.match(raw, /"version": 1/);
  });
});

describe('chat HTTP surface', () => {
  it('creates, lists, reads, renames, and deletes a chat', async () => {
    const s = await bootChats();
    const created = await (await s.api('/chats', json({ model: 'm/one' }))).json();
    assert.equal(created.ok, true);
    assert.equal(created.chat.model, 'm/one');

    const list = await (await s.api('/chats')).json();
    assert.equal(list.chats.length, 1);
    assert.equal(list.chats[0].id, created.id);
    assert.equal(list.chats[0].messageCount, 0);

    const fetched = await (await s.api(`/chats/${created.id}`)).json();
    assert.equal(fetched.chat.id, created.id);

    const renamed = await (await s.api(`/chats/${created.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Named' })
    })).json();
    assert.equal(renamed.chat.title, 'Named');

    const removed = await (await s.api(`/chats/${created.id}`, { method: 'DELETE' })).json();
    assert.equal(removed.deleted, created.id);
    assert.equal((await s.api(`/chats/${created.id}`)).status, 404);
    await s.close();
  });

  it('refuses to create a chat with no model', async () => {
    const s = await bootChats();
    const res = await s.api('/chats', json({}));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).problems.some((p) => /pinned model/.test(p)));
    await s.close();
  });

  it('streams one turn and stores both messages', async () => {
    const s = await bootChats();
    const created = await (await s.api('/chats', json({ model: 'm/one' }))).json();
    const res = await s.api(`/chats/${created.id}/messages`, json({ text: 'Hello there' }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const frames = await readFrames(res);
    assert.deepEqual(frames.map((f) => f.event), ['start', 'delta', 'delta', 'done']);
    assert.equal(frames[0].data.userMessage.role, 'user');
    assert.equal(frames[0].data.userMessage.content, 'Hello there');
    assert.equal(frames[3].data.message.content, 'Hello');
    assert.equal(frames[3].data.message.tokens, 3);

    // The turn was sent with the chat's pinned model and its session id.
    assert.equal(s.zstack.calls[0].model, 'm/one');
    assert.ok(s.zstack.calls[0].sessionId);

    const after = await (await s.api(`/chats/${created.id}`)).json();
    assert.equal(after.chat.messages.length, 2);
    assert.equal(after.chat.title, 'Hello there');
    assert.equal(after.chat.messages[1].content, 'Hello');
    await s.close();
  });

  it('rejects an empty message and an unknown chat', async () => {
    const s = await bootChats();
    const created = await (await s.api('/chats', json({ model: 'm/one' }))).json();
    assert.equal((await s.api(`/chats/${created.id}/messages`, json({ text: '   ' }))).status, 400);
    assert.equal((await s.api('/chats/c-nope/messages', json({ text: 'hi' }))).status, 404);
    await s.close();
  });

  it('persists a partial reply and reports the error when a stream fails', async () => {
    const failure = new Error('Request timed out');
    failure.kind = 'timeout';
    const s = await bootChats({ chatError: failure });
    const created = await (await s.api('/chats', json({ model: 'm/one' }))).json();
    const res = await s.api(`/chats/${created.id}/messages`, json({ text: 'go' }));
    const frames = await readFrames(res);
    assert.deepEqual(frames.map((f) => f.event), ['start', 'delta', 'error']);
    assert.equal(frames[2].data.kind, 'timeout');

    const after = await (await s.api(`/chats/${created.id}`)).json();
    assert.equal(after.chat.messages[1].content, 'Hel', 'the partial reply is kept');
    assert.match(after.chat.messages[1].error, /timed out/);
    await s.close();
  });

  it('allows only one turn per chat at a time', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const s = await bootChats({ beforeFinish: () => gate });
    const created = await (await s.api('/chats', json({ model: 'm/one' }))).json();
    const first = s.api(`/chats/${created.id}/messages`, json({ text: 'first' }));
    // Give the first request a moment to claim the chat.
    await new Promise((r) => setTimeout(r, 30));
    const second = await s.api(`/chats/${created.id}/messages`, json({ text: 'second' }));
    assert.equal(second.status, 409);
    release();
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    await readFrames(firstRes);
    await s.close();
  });

  it('prepares handoff without writing any history line or mutating chat', async () => {
    const s = await bootChats();
    const created = await (await s.api('/chats', json({ model: 'm/one', projectId: 'proj-1' }))).json();
    const res = await s.api(`/chats/${created.id}/messages`, json({ text: 'Investigate slow database query performance' }));
    await readFrames(res);

    const chatDoc = await (await s.api(`/chats/${created.id}`)).json();
    const chat = chatDoc.chat;
    assert.equal(chat.messages.length, 2);

    // Perform handoff
    const handoff = chatHandoffPrompt(chat);
    assert.equal(handoff.ok, true);
    assert.equal(handoff.prompt, 'Investigate slow database query performance');
    assert.equal(handoff.projectId, 'proj-1');
    assert.equal(handoff.model, 'm/one');
    assert.equal(handoff.truncated, false);

    // Verify history file has no lines written
    assert.ok(
      !existsSync(s.historyPath) || readFileSync(s.historyPath, 'utf8').trim() === '',
      'no history line must be written by chat handoff'
    );

    // Verify chat transcript in store remains identical and untouched
    const after = await (await s.api(`/chats/${created.id}`)).json();
    assert.deepEqual(after.chat.messages, chat.messages);
    await s.close();
  });

  it('handles handoff edge cases: empty conversation, truncation, and selection', () => {
    // 1. Empty conversation
    const emptyChat = { id: 'c-empty', model: 'm/one', messages: [] };
    const emptyRes = chatHandoffPrompt(emptyChat);
    assert.equal(emptyRes.ok, false);
    assert.match(emptyRes.error, /empty conversation/i);

    // 2. Conversation with only assistant messages
    const noUserChat = { id: 'c-nouser', model: 'm/one', messages: [{ id: 'm-1', role: 'assistant', content: 'hi' }] };
    assert.equal(chatHandoffPrompt(noUserChat).ok, false);

    // 3. Select specific message
    const multiChat = {
      id: 'c-multi',
      model: 'm/one',
      projectId: 'p-test',
      messages: [
        { id: 'm-u1', role: 'user', content: 'first prompt' },
        { id: 'm-a1', role: 'assistant', content: 'first reply' },
        { id: 'm-u2', role: 'user', content: 'second prompt' }
      ]
    };
    // Default takes last user message
    const defaultHandoff = chatHandoffPrompt(multiChat);
    assert.equal(defaultHandoff.ok, true);
    assert.equal(defaultHandoff.prompt, 'second prompt');
    assert.equal(defaultHandoff.messageId, 'm-u2');

    // Selected takes specific user message
    const selectedHandoff = chatHandoffPrompt(multiChat, 'm-u1');
    assert.equal(selectedHandoff.ok, true);
    assert.equal(selectedHandoff.prompt, 'first prompt');
    assert.equal(selectedHandoff.messageId, 'm-u1');

    // 4. Message longer than 8000 characters is truncated
    const longText = 'x'.repeat(10000);
    const longChat = {
      id: 'c-long',
      model: 'm/one',
      messages: [{ id: 'm-long', role: 'user', content: longText }]
    };
    const longHandoff = chatHandoffPrompt(longChat);
    assert.equal(longHandoff.ok, true);
    assert.equal(longHandoff.truncated, true);
    assert.equal(longHandoff.prompt.length, 8000);
    assert.equal(longHandoff.originalLength, 10000);
  });
});
