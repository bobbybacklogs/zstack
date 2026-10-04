/**
 * Plain chat: validation for one conversation turn.
 *
 * A chat is the narrowest thing zstack does: the reader pins one model, the
 * browser holds the transcript, and every send is one completion with no tools,
 * no playbook, and no workspace. Nothing here touches history or a project, so
 * this module owns exactly one thing: whether a request is shape-correct.
 *
 * The model is not checked against the live catalogue. The gateway is the
 * authority on what it serves, and a pinned model may legitimately be absent
 * from a stale list while still reachable; validating membership here would
 * turn a working pin into a rejection. An unknown model surfaces the gateway's
 * own error, which names it.
 */

/** Roles a chat message may carry, mirroring the OpenAI wire format. */
export const CHAT_ROLES = Object.freeze(['system', 'user', 'assistant']);

/**
 * Default deadline for one chat turn, in milliseconds.
 *
 * A chat turn is a single completion, and a reasoning model can spend minutes
 * on one. The gateway's own default is 30s, which is right for a routing check
 * and too short for a conversation, so chat is the one caller that asks for
 * more room. An explicit per-call timeout or `MODELHITCH_TIMEOUT` still wins.
 */
export const DEFAULT_CHAT_TIMEOUT_MS = 120000;


/**
 * Most messages one request may carry.
 *
 * The browser caps what it sends well below this; the bound is here so a
 * hand-rolled client cannot post an unbounded transcript that the body-size
 * limit only catches after buffering it.
 */
export const CHAT_MAX_REQUEST_MESSAGES = 200;

/**
 * Problems with a chat request, all of them at once.
 *
 * Returns the same shape as the run validator so the HTTP layer reports a bad
 * chat the way it reports a bad run. `sessionId` is optional: the gateway
 * derives a session from the conversation when the client does not name one,
 * but a client that pins a stable id gets stable cache affinity from providers
 * that key on it (OpenCode Go requires the header on every wire).
 */
export function validateChatRequest(body = {}) {
  const problems = [];
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (model === '') problems.push('A chat needs a model.');

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    problems.push('A chat needs a non-empty messages array.');
  } else if (body.messages.length > CHAT_MAX_REQUEST_MESSAGES) {
    problems.push(`A chat carries at most ${CHAT_MAX_REQUEST_MESSAGES} messages.`);
  } else {
    body.messages.forEach((message, index) => {
      const where = `messages[${index}]`;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        problems.push(`${where} must be an object with a role and content.`);
        return;
      }
      if (!CHAT_ROLES.includes(message.role)) {
        problems.push(`${where}.role must be one of: ${CHAT_ROLES.join(', ')}.`);
      }
      if (typeof message.content !== 'string' || message.content.trim() === '') {
        problems.push(`${where}.content must be a non-empty string.`);
      }
    });
  }

  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
    problems.push('sessionId must be a string.');
  }
  return problems;
}

/** The messages stripped to the wire shape, dropping any client-only fields. */
export function chatWireMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

/**
 * The deadline for one chat turn.
 *
 * Precedence matches the rest of the gateway: an explicit per-call value, then
 * the instance's own timeout, then `MODELHITCH_TIMEOUT`, then the chat default.
 * The last rung is what makes a bare `new ZStack().chat()` usable: the gateway
 * default of 30s truncates a conversation, and only here does a longer default
 * apply.
 */
export function chatTimeoutMs(explicit, instance) {
  const pick = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : null);
  const env = Number(process.env.MODELHITCH_TIMEOUT);
  return pick(explicit) ?? pick(instance) ?? pick(env) ?? DEFAULT_CHAT_TIMEOUT_MS;
}

