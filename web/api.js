/**
 * Every request the client makes, in one place.
 *
 * Thin on purpose: the server owns the shapes and this only turns an HTTP
 * failure into a thrown Error carrying the server's own message, so a mistake
 * surfaces the server's explanation rather than a status code.
 */

async function request(method, path, body, options = {}) {
  const init = { method, headers: {} };
  if (options.signal) init.signal = options.signal;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, init);
  let doc = null;
  try {
    doc = await res.json();
  } catch {
    // A response with no JSON body still needs an error worth reading.
    if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}.`);
    return null;
  }
  if (!res.ok || doc?.ok === false) {
    const err = new Error(doc?.error || `${method} ${path} failed with ${res.status}.`);
    err.status = res.status;
    err.problems = doc?.problems || null;
    throw err;
  }
  return doc;
}

export const api = {
  health: () => request('GET', '/health'),
  config: () => request('GET', '/config'),
  status: () => request('GET', '/status'),
  runs: (limit = 40) => request('GET', `/runs?limit=${limit}`),
  run: (id) => request('GET', `/runs/${encodeURIComponent(id)}`),
  patchRun: (id, payload) => request('PATCH', `/runs/${encodeURIComponent(id)}`, payload),
  deleteRun: (id) => request('DELETE', `/runs/${encodeURIComponent(id)}`),
  start: (payload) => request('POST', '/runs', payload),
  continueRun: (id, payload) => request('POST', `/runs/${encodeURIComponent(id)}/continue`, payload ?? {}),
  cancel: (id) => request('POST', `/runs/${encodeURIComponent(id)}/cancel`),
  pause: (id) => request('POST', `/runs/${encodeURIComponent(id)}/pause`, {}),
  resume: (id) => request('POST', `/runs/${encodeURIComponent(id)}/resume`, {}),
  setBudget: (payload) => request('PUT', '/budget', payload),
  models: () => request('GET', '/models'),
  chat: (payload, options) => request('POST', '/chat', payload, options),
  classifyPrompt: (payload) => request('POST', '/classify', payload),
  optimizePrompt: (payload) => request('POST', '/optimize', payload),
  chats: () => request('GET', '/chats'),
  createChat: (payload) => request('POST', '/chats', payload),
  getChat: (id) => request('GET', `/chats/${encodeURIComponent(id)}`),
  updateChat: (id, payload) => request('PATCH', `/chats/${encodeURIComponent(id)}`, payload),
  deleteChat: (id) => request('DELETE', `/chats/${encodeURIComponent(id)}`),
  projects: () => request('GET', '/projects'),
  project: (id) => request('GET', `/projects/${encodeURIComponent(id)}/runs`),
  dashboard: () => request('GET', '/dashboard'),
  createProject: (payload) => request('POST', '/projects', payload),
  updateProject: (id, payload) => request('PUT', `/projects/${encodeURIComponent(id)}`, payload),
  deleteProject: (id) => request('DELETE', `/projects/${encodeURIComponent(id)}`),
  github: () => request('GET', '/github'),
  syncGithub: () => request('POST', '/github/sync'),
  setRepoPath: (payload) => request('PUT', '/github/repos', payload),
  repoGit: (payload) => request('POST', '/github/git', payload),
  runGit: (id, payload) => request('POST', `/runs/${encodeURIComponent(id)}/git`, payload)
};

/**
 * Follow a run's event stream, resuming from where a previous connection left
 * off.
 *
 * `EventSource` reconnects on its own and sends `Last-Event-ID` when it does,
 * which the server uses to replay only what was missed. That is why the
 * handlers here can assume no gap rather than rebuilding the page on every
 * reconnect.
 */
export function subscribeToRun(id, handlers = {}) {
  const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  const on = (type) => (event) => {
    let data = null;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handlers[type]?.(data);
  };
  for (const type of ['open', 'blocks', 'status', 'end', 'shutdown']) {
    source.addEventListener(type, on(type));
  }
  source.onerror = () => handlers.error?.();
  return () => source.close();
}

/**
 * Send one turn to a chat and read the streamed reply.
 *
 * The response is SSE over a POST, which `EventSource` cannot open (it is
 * GET-only), so the body is read incrementally and frames are dispatched to the
 * handlers as they close. Resolves when the stream ends; a non-2xx response
 * throws an Error carrying the server's own message. An abort rejects with the
 * fetch's AbortError, which the caller treats as a deliberate stop.
 */
export async function streamChatMessage(id, text, handlers = {}) {
  const { signal, onStart, onDelta, onDone, onError } = handlers;
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal
  });
  if (!res.ok || !res.body) {
    let message = `POST /chats/${id}/messages failed with ${res.status}.`;
    try {
      const doc = await res.json();
      if (doc?.error) message = doc.error;
    } catch {
      // keep the status message
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
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
        try {
          data = JSON.parse(dataLine);
        } catch {
          data = null;
        }
      }
      if (event === 'start') onStart?.(data);
      else if (event === 'delta') onDelta?.(data?.text || '');
      else if (event === 'done') onDone?.(data);
      else if (event === 'error') onError?.(data);
    }
  }
}
