/**
 * Every request the client makes, in one place.
 *
 * Thin on purpose: the server owns the shapes and this only turns an HTTP
 * failure into a thrown Error carrying the server's own message, so a mistake
 * surfaces the server's explanation rather than a status code.
 *
 * The one piece of local state is the credential. A server started with
 * `--require-auth` refuses every `api` call that presents nothing, and the
 * browser cannot send an `Authorization` header on the navigation request that
 * loads this page — so the key is pasted once on the Keys page (or arrives as
 * `?token=`) and is kept here for the fetches that follow. It never leaves this
 * origin except as the header the server asked for.
 */

const TOKEN_KEY = 'zstack:api-token';

/** The credential this browser presents, or '' when it presents none. */
export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

/** Remember, or forget, the credential. An empty value clears it. */
export function setStoredToken(token) {
  try {
    if (typeof token === 'string' && token.trim() !== '') {
      localStorage.setItem(TOKEN_KEY, token.trim());
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // A browser that refuses storage still works: the token simply does not
    // outlive the page.
  }
}

function authHeaders() {
  const token = getStoredToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request(method, path, body, options = {}) {
  const init = { method, headers: { ...authHeaders() }, credentials: 'omit' };
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
  keys: () => request('GET', '/keys'),
  key: (id) => request('GET', `/keys/${encodeURIComponent(id)}`),
  createKey: (payload) => request('POST', '/keys', payload),
  updateKey: (id, payload) => request('PATCH', `/keys/${encodeURIComponent(id)}`, payload),
  deleteKey: (id) => request('DELETE', `/keys/${encodeURIComponent(id)}`),
  rotateKey: (id, payload) => request('POST', `/keys/${encodeURIComponent(id)}/rotate`, payload ?? {}),
  dashboard: () => request('GET', '/dashboard'),
  createProject: (payload) => request('POST', '/projects', payload),
  updateProject: (id, payload) => request('PUT', `/projects/${encodeURIComponent(id)}`, payload),
  deleteProject: (id) => request('DELETE', `/projects/${encodeURIComponent(id)}`),
  github: () => request('GET', '/github'),
  syncGithub: () => request('POST', '/github/sync'),
  setRepoPath: (payload) => request('PUT', '/github/repos', payload),
  repoGit: (payload) => request('POST', '/github/git', payload),
  runGit: (id, payload) => request('POST', `/runs/${encodeURIComponent(id)}/git`, payload),
  schedules: () => request('GET', '/schedules'),
  createSchedule: (payload) => request('POST', '/schedules', payload),
  inferSchedule: (payload) => request('POST', '/schedules/infer', payload),
  runSchedule: (id) => request('POST', `/schedules/${encodeURIComponent(id)}/run`, {}),
  getSchedule: (id) => request('GET', `/schedules/${encodeURIComponent(id)}`),
  updateSchedule: (id, payload) => request('PATCH', `/schedules/${encodeURIComponent(id)}`, payload),
  deleteSchedule: (id) => request('DELETE', `/schedules/${encodeURIComponent(id)}`),
  workfolkStatus: () => request('GET', '/workfolk/status'),
  workfolkWorkers: (includeRetired = false) => request('GET', `/workfolk/workers${includeRetired ? '?includeRetired=true' : ''}`),
  workfolkDispatch: (payload) => request('POST', '/workfolk/dispatch', payload),
  workfolkJob: (id) => request('GET', `/workfolk/jobs/${encodeURIComponent(id)}`)
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
  // EventSource sets no headers, so the credential rides the query string the
  // server also accepts. Same origin, and the server never echoes it back.
  const token = getStoredToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events${query}`);
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
    headers: { 'content-type': 'application/json', ...authHeaders() },
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
