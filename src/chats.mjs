/**
 * Chats: server-side conversations with a pinned model.
 *
 * A chat is not a run. It has no workspace, no playbook, no tool loop, and no
 * history record; it is a transcript plus the model it is pinned to. It lives on
 * the server so a conversation survives a browser, a reload, or a different
 * machine, and so the reply a turn streams is stored whether or not the reader
 * stayed to watch it.
 *
 * Storage is one JSON file next to history, written atomically (write then
 * rename) because a server killed mid-write must leave the previous file intact.
 * Chats are a human's handful of conversations, not a table with millions of
 * rows, so a database would be machinery without a load. Message bodies are
 * capped because a chat file is read back whole to render a page.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function chatsPath(pathOverride) {
  return (
    pathOverride ||
    process.env.ZSTACK_CHATS_PATH ||
    join(homedir(), '.zstack', 'chats.json')
  );
}

/** A short, stable id for a chat. */
export function newChatId() {
  return `c-${randomBytes(6).toString('hex')}`;
}

/** A short id for one message, so a turn is addressable while it streams. */
export function newMessageId() {
  return `m-${randomBytes(6).toString('hex')}`;
}

/** Characters of one message body that are stored. */
export const CHAT_MAX_MESSAGE_CHARS = 20000;

/** Messages one chat holds. A conversation past this is full, not tidied. */
export const CHAT_MAX_MESSAGES = 1000;

/** Chats the store holds. */
export const CHAT_MAX_CHATS = 500;

/** Longest derived chat title before it is cut. Mirrors the run page's cap. */
const TITLE_MAX = 72;

const VALID_ROLES = new Set(['user', 'assistant']);

function blankStore() {
  return { version: 1, chats: [] };
}

function titleFromText(text, fallback = 'New chat') {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return fallback;
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1)}…`;
}

function normalizeMessage(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (!VALID_ROLES.has(item.role)) return null;
  if (typeof item.content !== 'string') return null;
  const trimmed = item.content.length > CHAT_MAX_MESSAGE_CHARS
    ? item.content.slice(0, CHAT_MAX_MESSAGE_CHARS)
    : item.content;
  return {
    id: typeof item.id === 'string' && item.id !== '' ? item.id : newMessageId(),
    role: item.role,
    content: trimmed,
    at: typeof item.at === 'string' && item.at !== '' ? item.at : null,
    model: typeof item.model === 'string' && item.model !== '' ? item.model : null,
    tokens: Number.isFinite(item.tokens) ? item.tokens : null,
    durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    error: typeof item.error === 'string' && item.error !== '' ? item.error : null,
    ...(item.content.length > CHAT_MAX_MESSAGE_CHARS ? { truncated: true } : {})
  };
}

function normalizeChat(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.id !== 'string' || item.id === '') return null;
  const messages = Array.isArray(item.messages)
    ? item.messages.map(normalizeMessage).filter(Boolean).slice(-CHAT_MAX_MESSAGES)
    : [];
  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title : null,
    model: typeof item.model === 'string' && item.model !== '' ? item.model : null,
    // A stable per-conversation id, forwarded as the gateway session header so
    // a provider that keys cache affinity on it sees one conversation.
    projectId: typeof item.projectId === 'string' && item.projectId.trim() !== '' ? item.projectId.trim() : null,
    sessionId: typeof item.sessionId === 'string' && item.sessionId !== '' ? item.sessionId : null,
    createdAt: typeof item.createdAt === 'string' && item.createdAt !== '' ? item.createdAt : null,
    updatedAt: typeof item.updatedAt === 'string' && item.updatedAt !== '' ? item.updatedAt : null,
    messages
  };
}

/**
 * Read the store, tolerating a missing or corrupted file.
 *
 * A corrupted file yields an empty store rather than throwing, because the chat
 * list is advisory: losing it must never take down the server that also serves
 * runs. The corruption is reported so the UI can say so.
 */
export function readChats(pathOverride) {
  const file = chatsPath(pathOverride);
  if (!existsSync(file)) return { chats: [], corrupted: false, path: file };
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { chats: [], corrupted: true, path: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { chats: [], corrupted: true, path: file };
  }
  const list = Array.isArray(parsed) ? parsed : parsed.chats;
  if (!Array.isArray(list)) return { chats: [], corrupted: true, path: file };
  const chats = [];
  for (const item of list) {
    const chat = normalizeChat(item);
    if (chat) chats.push(chat);
  }
  return { chats, corrupted: false, path: file };
}

function writeStore(file, chats) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, chats }, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/** The title a chat shows: a custom one, else the first thing asked. */
export function chatTitle(chat) {
  if (chat?.title) return chat.title;
  const firstUser = (chat?.messages || []).find((m) => m.role === 'user');
  return titleFromText(firstUser?.content, 'New chat');
}

/** The card fields for the chat list, without the message bodies. */
export function chatSummary(chat) {
  return {
    id: chat.id,
    title: chatTitle(chat),
    model: chat.model,
    projectId: chat.projectId ?? null,
    messageCount: chat.messages.length,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
  };
}

/** The full chat as the page reads it. */
export function projectChat(chat) {
  return {
    id: chat.id,
    title: chatTitle(chat),
    customTitle: chat.title,
    model: chat.model,
    projectId: chat.projectId ?? null,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messages: chat.messages.map((m) => ({ ...m, streaming: false }))
  };
}

export function findChat(id, pathOverride) {
  if (!id) return null;
  return readChats(pathOverride).chats.find((c) => c.id === id) || null;
}

/** Validate a create request. A chat needs a model to be usable at all. */
export function validateChatStart(input = {}) {
  const problems = [];
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (model === '') problems.push('A chat needs a pinned model.');
  return problems;
}

/**
 * Create a chat pinned to one model. Throws `kind: 'invalid-chat'` with every
 * problem, so the HTTP layer reports them in one response.
 */
export function createChat(input = {}, pathOverride) {
  const { chats } = readChats(pathOverride);
  const problems = validateChatStart(input);
  if (problems.length > 0) {
    const err = new Error(problems.join(' '));
    err.kind = 'invalid-chat';
    err.problems = problems;
    throw err;
  }
  if (chats.length >= CHAT_MAX_CHATS) {
    const err = new Error(`There are already ${CHAT_MAX_CHATS} chats. Delete one before creating another.`);
    err.kind = 'invalid-chat';
    err.problems = [err.message];
    throw err;
  }
  const now = new Date().toISOString();
  const record = {
    id: newChatId(),
    title: null,
    model: input.model.trim(),
    projectId: typeof input.projectId === 'string' && input.projectId.trim() !== '' ? input.projectId.trim() : null,
    sessionId: `chat-${randomBytes(8).toString('hex')}`,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  writeStore(chatsPath(pathOverride), [...chats, record]);
  return record;
}

/** Rename or re-pin a chat. An empty title clears it back to the derived one. */
export function updateChat(id, patch = {}, pathOverride) {
  const { chats } = readChats(pathOverride);
  const current = chats.find((c) => c.id === id);
  if (!current) {
    const err = new Error(`No chat with id ${id}.`);
    err.kind = 'unknown-chat';
    throw err;
  }
  const problems = [];
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string' || patch.model.trim() === '') {
      problems.push('A pinned model must be a non-empty string.');
    }
  }
  if (patch.title !== undefined && patch.title !== null && typeof patch.title !== 'string') {
    problems.push('A title must be a string.');
  }
  if (problems.length > 0) {
    const err = new Error(problems.join(' '));
    err.kind = 'invalid-chat';
    err.problems = problems;
    throw err;
  }
  const record = {
    ...current,
    title: patch.title !== undefined
      ? (typeof patch.title === 'string' && patch.title.trim() !== '' ? patch.title.trim() : null)
      : current.title,
    model: patch.model !== undefined ? patch.model.trim() : current.model,
    projectId: patch.projectId !== undefined
      ? (typeof patch.projectId === 'string' && patch.projectId.trim() !== '' ? patch.projectId.trim() : null)
      : (current.projectId ?? null),
    updatedAt: new Date().toISOString()
  };
  writeStore(
    chatsPath(pathOverride),
    chats.map((c) => (c.id === id ? record : c))
  );
  return record;
}

export function deleteChat(id, pathOverride) {
  const { chats } = readChats(pathOverride);
  const current = chats.find((c) => c.id === id);
  if (!current) {
    const err = new Error(`No chat with id ${id}.`);
    err.kind = 'unknown-chat';
    throw err;
  }
  writeStore(
    chatsPath(pathOverride),
    chats.filter((c) => c.id !== id)
  );
  return current;
}

/** Problems with a user's message text, or none. */
export function validateChatMessage(text) {
  const problems = [];
  const body = typeof text === 'string' ? text.trim() : '';
  if (body === '') problems.push('A message needs text.');
  else if (body.length > CHAT_MAX_MESSAGE_CHARS) {
    problems.push(`A message is at most ${CHAT_MAX_MESSAGE_CHARS} characters.`);
  }
  return problems;
}

/**
 * Append one message and return the updated chat.
 *
 * The first user message becomes the derived title, so a conversation names
 * itself. Always reads fresh state and writes the whole store, so a rename that
 * landed while a reply was streaming is not clobbered by the append.
 */
export function appendMessage(id, message, pathOverride) {
  const { chats } = readChats(pathOverride);
  const current = chats.find((c) => c.id === id);
  if (!current) {
    const err = new Error(`No chat with id ${id}.`);
    err.kind = 'unknown-chat';
    throw err;
  }
  const normalized = normalizeMessage({ at: new Date().toISOString(), ...message });
  if (!normalized) {
    const err = new Error('A message needs a role of user or assistant and string content.');
    err.kind = 'invalid-chat';
    throw err;
  }
  const messages = [...current.messages, normalized];
  if (messages.length > CHAT_MAX_MESSAGES) {
    const err = new Error(`This chat is full at ${CHAT_MAX_MESSAGES} messages. Start a new one.`);
    err.kind = 'invalid-chat';
    throw err;
  }
  const record = {
    ...current,
    // `title` stays null until someone renames the chat; the derived name is
    // computed on read from the first user message, so it is never stored as if
    // it were a choice the reader made.
    updatedAt: new Date().toISOString(),
    messages
  };
  writeStore(
    chatsPath(pathOverride),
    chats.map((c) => (c.id === id ? record : c))
  );
  return record;
}

/**
 * Prepare a chat message for handoff to a run composer without writing to history.
 * Copies text only: mutates neither the chat nor history, preserving the rule
 * that a chat is a plain conversation until the composer is submitted.
 */
export function chatHandoffPrompt(chat, messageId = null) {
  if (!chat || !Array.isArray(chat.messages)) {
    return { ok: false, error: 'Empty conversation: no messages to continue from.' };
  }
  const userMessages = chat.messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    return { ok: false, error: 'Empty conversation: no user messages to continue from.' };
  }
  const target = messageId
    ? userMessages.find((m) => m.id === messageId) || userMessages[userMessages.length - 1]
    : userMessages[userMessages.length - 1];
  if (!target || typeof target.content !== 'string' || target.content.trim() === '') {
    return { ok: false, error: 'Selected message has no text.' };
  }
  const raw = target.content.trim();
  const maxChars = 8000;
  const truncated = raw.length > maxChars;
  const prompt = truncated ? raw.slice(0, maxChars) : raw;
  return {
    ok: true,
    prompt,
    truncated,
    originalLength: raw.length,
    messageId: target.id,
    projectId: chat.projectId ?? null,
    model: chat.model ?? null
  };
}

export { blankStore };
