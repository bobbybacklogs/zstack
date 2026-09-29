/**
 * Every request the client makes, in one place.
 *
 * Thin on purpose: the server owns the shapes and this only turns an HTTP
 * failure into a thrown Error carrying the server's own message, so a mistake
 * surfaces the server's explanation rather than a status code.
 */

async function request(method, path, body) {
  const init = { method, headers: {} };
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
  cancel: (id) => request('POST', `/runs/${encodeURIComponent(id)}/cancel`),
  setBudget: (payload) => request('PUT', '/budget', payload),
  projects: () => request('GET', '/projects'),
  project: (id) => request('GET', `/projects/${encodeURIComponent(id)}/runs`),
  createProject: (payload) => request('POST', '/projects', payload),
  updateProject: (id, payload) => request('PUT', `/projects/${encodeURIComponent(id)}`, payload),
  deleteProject: (id) => request('DELETE', `/projects/${encodeURIComponent(id)}`)
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
