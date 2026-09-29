/**
 * The local UI server: `zstack serve`.
 *
 * Binds loopback only. This process starts agent runs and shells out to the
 * ModelHitch harness with a tool loop, so exposing it on a LAN interface would
 * hand anyone on the network the ability to run commands on this machine. The
 * default is therefore 127.0.0.1, and leaving it takes an explicit flag.
 *
 * Two transports and no dependencies. JSON over `fetch` for everything already
 * known, and Server-Sent Events for a run in progress. SSE rather than
 * WebSockets because the traffic is one-way, it reconnects on its own, and it
 * resumes from a sequence number: a browser that reloads mid-run asks for the
 * events after the last id it saw and gets exactly those. A socket would need
 * hand-written reconnect and backlog logic to reach the same place.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ZStack } from './sdk.mjs';
import { ZSTACK_ROOT } from './harness.mjs';
import { BUDGET_TIERS, BUDGET_SOURCES, LANES } from './budget.mjs';
import { readHistoryTail, readHistory, findHistoryEntry, historyPath, HISTORY_DEFAULT_LIMIT } from './history.mjs';
import { projectStoredRun, projectRunSummary } from './blocks.mjs';
import { RunRegistry, POLICIES } from './runs.mjs';
import {
  readProjects,
  createProject,
  updateProject,
  deleteProject,
  findProject,
  projectsPath
} from './projects.mjs';
import {
  readOverrides,
  patchRunOverride,
  hideRun,
  applyOverride,
  overridesPath
} from './overrides.mjs';

/** Where the browser client lives. */
export const WEB_ROOT = join(ZSTACK_ROOT, 'web');

/** Default port. Clear of the ModelHitch bridge on 3939. */
export const DEFAULT_PORT = 4141;

/** Default bind address. Loopback, because this process runs agents. */
export const DEFAULT_HOST = '127.0.0.1';

/** Largest JSON body accepted, in bytes. */
const MAX_BODY_BYTES = 256 * 1024;

/** How often an idle SSE stream emits a comment to keep the socket alive. */
const SSE_PING_MS = 15000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/** Loopback addresses a caller may bind without an explicit acknowledgement. */
export function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Nothing here is cacheable: every response depends on live state.
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function fail(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

/** Read a JSON request body, refusing anything oversized. */
function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        const err = new Error(`Request body larger than ${MAX_BODY_BYTES} bytes.`);
        err.status = 413;
        // The rest of the body is drained rather than the socket destroyed, so
        // the caller can still be told why it was refused.
        rejectPromise(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', rejectPromise);
    req.on('end', () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolvePromise({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('Request body must be a JSON object.');
          err.status = 400;
          return rejectPromise(err);
        }
        resolvePromise(parsed);
      } catch {
        const err = new Error('Request body is not valid JSON.');
        err.status = 400;
        rejectPromise(err);
      }
    });
  });
}

/**
 * The host name in a `Host` header, without its port or IPv6 brackets.
 */
function hostWithoutPort(host) {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(1, end);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Refuse a request addressed to a host this server does not answer for.
 *
 * This is the defence against DNS rebinding. A page on another site can point a
 * name it controls at 127.0.0.1 and then talk to this port, and because the
 * browser considers that name same-origin, the `Origin` check below never
 * fires. The `Host` header still carries the attacker's name, so rejecting
 * unknown hosts stops the attack before it reaches a route. This process starts
 * agent runs, so it is worth the check.
 */
function hostAllowed(req, boundHost) {
  const host = req.headers.host;
  if (!host) return false;
  const bare = hostWithoutPort(host);
  return bare === boundHost || isLoopback(bare);
}

/**
 * Refuse a state-changing request that did not come from this server's own page.
 *
 * A browser sends `Origin` on any cross-origin POST, so a page elsewhere cannot
 * quietly drive this one. A request with no `Origin` at all is a command-line
 * client, which is the operator, and is allowed through.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Methods each fixed path answers.
 *
 * Checked before routing so a known path with the wrong method is a 405 that
 * names the method, rather than a 404 that sends the caller looking for a typo.
 */
const FIXED_ROUTES = Object.freeze({
  '/api/health': ['GET'],
  '/api/runs': ['GET', 'POST'],
  '/api/projects': ['GET', 'POST'],
  '/api/config': ['GET'],
  '/api/budget': ['PUT'],
  '/api/status': ['GET']
});

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * The vocabularies a project's defaults are validated against.
 *
 * Playbook ids come from the catalogue, which can be empty when nothing is
 * installed; validation tolerates that by skipping the membership check, so a
 * project can still name a playbook the server has not loaded. Policies come
 * from the registry's own table, which is never empty.
 */
function knownProjectVocabulary(zstack) {
  let playbooks = [];
  try {
    playbooks = (zstack.listPlaybooks() || []).map((p) => p.id);
  } catch {
    playbooks = [];
  }
  return { playbooks, policies: Object.keys(POLICIES) };
}

/**
 * Annotate a run card or page with its project name, when it has a project
 * that still exists.
 *
 * Cards already carry `projectName`; pages did not, because the page endpoints
 * project one record rather than merging a list. A deleted project's runs keep
 * their `projectId` but resolve to no name, and the page says so by omission
 * rather than by pointing at a page that no longer exists.
 */
function withProjectName(cardOrPage, projectsById) {
  if (!cardOrPage || !cardOrPage.projectId) return cardOrPage;
  const name = projectsById.get(cardOrPage.projectId)?.name ?? null;
  if (!name) return cardOrPage;
  return { ...cardOrPage, projectName: name };
}

/**
 * Resolve a URL path to a file inside the web root, or null.
 *
 * Every static request is a URL that becomes a filesystem read, so this is the
 * one place that must not be optimistic. The decoded path is rejected on NUL,
 * on a backslash (a separator on Windows that URL parsing does not normalize),
 * and on any `..` segment. The resolved result is then checked to be inside the
 * root, which catches the encodings the segment check misses.
 */
export function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded === '/' ? '/index.html' : decoded;
  const segments = relative.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return null;
  const full = resolve(join(WEB_ROOT, ...segments));
  const root = resolve(WEB_ROOT);
  // The authoritative check. Segment inspection alone loses to an encoding that
  // decodes to a separator after the fact.
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

async function serveStatic(res, urlPath) {
  const full = resolveStaticPath(urlPath);
  if (!full) {
    fail(res, 400, 'Unsafe static path.');
    return;
  }
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    fail(res, 404, `No such file: ${normalize(urlPath)}`);
    return;
  }
  try {
    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      // The client is a local first-party asset; caching it would hide edits.
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch (err) {
    fail(res, 500, `Cannot read ${normalize(urlPath)}: ${err.message}`);
  }
}

/**
 * Stream a run's events.
 *
 * The backlog is replayed before the socket goes live, in one pass, so a client
 * resuming with a sequence number cannot miss an event that arrived between its
 * request and its subscription. Anything emitted after the replay is written by
 * the subscriber.
 */
function streamRun(req, res, registry, id) {
  const run = registry.get(id);
  if (!run) {
    fail(res, 404, `No run with id ${id}.`);
    return;
  }
  const header = req.headers['last-event-id'];
  const url = new URL(req.url, 'http://localhost');
  const since = positiveInt(url.searchParams.get('since') ?? header, 0);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // A proxy that buffers would hold back exactly the events this exists for.
    'x-accel-buffering': 'no'
  });

  const write = (entry) => {
    if (res.writableEnded) return;
    res.write(`id: ${entry.seq}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`);
  };

  const backlog = registry.replay(id, since) || [];
  let terminal = false;
  for (const entry of backlog) {
    write(entry);
    if (entry.type === 'end') terminal = true;
  }

  if (terminal || run.settled) {
    res.end();
    return;
  }

  const unsubscribe = registry.subscribe(id, (entry) => {
    write(entry);
    if (entry.type === 'end' || entry.type === 'shutdown') finish();
  });

  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, SSE_PING_MS);

  function finish() {
    clearInterval(ping);
    if (unsubscribe) unsubscribe();
    if (!res.writableEnded) res.end();
  }

  req.on('close', finish);
}

/**
 * Build the request handler.
 *
 * Exported separately from the listener so tests can drive it over a real
 * socket on an ephemeral port without reaching into the binding logic.
 */
export function createApp(options = {}) {
  const zstack = options.zstack || new ZStack();
  const historyFile = options.historyPath;
  const projectsFile = options.projectsPath;
  const overridesFile = options.overridesPath;
  const registry = options.registry || new RunRegistry({
    zstack,
    historyPath: historyFile,
    // Live pages name their project without a re-read on every event: the
    // lookup runs once per page projection, and a rename lands everywhere.
    projectNameFor: (id) => findProject(id, projectsFile)?.name ?? null,
    // Live pages and cards show a custom title without a re-read, same story:
    // the server owns the overrides file and hands the registry a lookup.
    overrideFor: (id) => readOverrides(overridesFile).overrides[id] || null
  });
  const startedAt = Date.now();
  const boundHost = options.host || DEFAULT_HOST;

  // Every projection of a stored run passes through here: the history record
  // with its sidecar override applied, so a renamed, moved, or hidden run
  // reads the same from the list, the page, and the project page.
  const withOverride = (entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const override = readOverrides(overridesFile).overrides[entry.id] || null;
    return applyOverride(entry, override);
  };

  /**
   * Whether an id names a run anywhere: retained live in this process or
   * archived in history. PATCH and DELETE check this before touching the
   * overrides file, so a patch for a run nobody knows answers 404 instead of
   * creating an orphan override that then needs a second request to discover.
   */
  const runExists = (id) => {
    if (registry.get(id)) return true;
    try {
      return findHistoryEntry(id, historyFile) !== null;
    } catch {
      return false;
    }
  };

  /**
   * The page for one run, or null when the id names nothing.
   *
   * Shared by the GET and the PATCH endpoints so a rename response carries
   * the same page a re-read would: the client updates from the response
   * rather than fetching twice. A retained live run wins over its archived
   * record, mirroring the single-run endpoint's long standing preference.
   *
   * `livePageFor` lives here rather than beside the route because the helper
   * is defined after it: both close over the same registry, and the helper
   * below is the one place that knows a live page is a projection, not the
   * run, so annotating it cannot mutate registry state.
   */
  const pageForRun = async (id, projectsById) => {
    const livePage = registry.getPage(id);
    if (livePage) return withProjectName(livePage, projectsById);
    let entry = null;
    try {
      entry = findHistoryEntry(id, historyFile);
    } catch {
      return null;
    }
    if (!entry) return null;
    return withProjectName(projectStoredRun(withOverride(entry)), projectsById);
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';

    if (!hostAllowed(req, boundHost)) {
      fail(res, 403, `This server does not answer for host ${req.headers.host || '(none)'}.`);
      return;
    }

    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        fail(res, 405, `${method} is not allowed for ${path}.`);
        return;
      }
      if (path === '/') {
        await serveStatic(res, '/index.html');
        return;
      }
      await serveStatic(res, path);
      return;
    }

    // Every endpoint under /api/ other than the read-only ones changes state,
    // so the origin check runs once here rather than per route.
    if (method !== 'GET' && !sameOrigin(req)) {
      fail(res, 403, 'Cross-origin request refused.');
      return;
    }

    const allowed = FIXED_ROUTES[path];
    if (allowed && !allowed.includes(method)) {
      fail(res, 405, `${method} is not allowed for ${path}. Allowed: ${allowed.join(', ')}.`);
      return;
    }

    // --- health -----------------------------------------------------------
    if (path === '/api/health') {
      let bridge = { ok: false, error: 'not checked' };
      try {
        const status = await zstack.status();
        bridge = status.ok
          ? { ok: true, baseUrl: status.baseUrl, providers: status.activeProviders, mode: status.mode }
          : { ok: false, baseUrl: status.baseUrl, error: status.error };
      } catch (err) {
        bridge = { ok: false, error: err?.message || String(err) };
      }
      sendJson(res, 200, {
        ok: true,
        version: '0.1.0',
        uptimeMs: Date.now() - startedAt,
        bridge,
        history: { path: historyPath(historyFile) },
        policies: Object.entries(POLICIES).map(([id, p]) => ({ id, label: p.label, apply: p.apply }))
      });
      return;
    }

    // --- runs list --------------------------------------------------------
    if (path === '/api/runs' && method === 'GET') {
      const limit = positiveInt(url.searchParams.get('limit'), HISTORY_DEFAULT_LIMIT);
      // The tail read, not a full scan: this is the endpoint the UI hits on
      // every navigation, and history has no index to scan cheaply.
      const archived = readHistoryTail(limit, historyFile)
        .map(withOverride)
        .filter((entry) => entry && !entry.hidden)
        .map(projectRunSummary);
      const archivedIds = new Set(archived.map((e) => e.id));
      // A live run is not in history until it finishes, so without this the run
      // you just started would be invisible in the list until it completed.
      // A hidden run never lists live either: the delete endpoint hides the
      // run while this process still retains it, and the list must agree with
      // the archived view rather than resurrect it until the retain window
      // passes.
      const hiddenIds = new Set(Object.entries(readOverrides(overridesFile).overrides)
        .filter(([, item]) => item && item.hidden === true)
        .map(([id]) => id));
      const live = registry.listLive()
        .filter((r) => !archivedIds.has(r.id) && !hiddenIds.has(r.id));
      const projectsById = new Map(
        readProjects(projectsFile).projects.map((p) => [p.id, p])
      );
      const merged = [...live, ...archived]
        .map((card) => withProjectName(card, projectsById))
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .slice(0, limit);
      sendJson(res, 200, {
        ok: true,
        runs: merged,
        // No total: producing one would mean reading the whole file, which is
        // the cost this endpoint exists to avoid. `hasMore` drives the UI's
        // load-more affordance instead of a count it does not have.
        hasMore: archived.length >= limit,
        liveCount: live.filter((r) => r.live).length
      });
      return;
    }

    // --- start a run ------------------------------------------------------
    if (path === '/api/runs' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      try {
        // A project names a directory at creation time, and the request must
        // not bypass that: the directory the run executes in comes from the
        // stored project, never from a client-supplied path. An explicit
        // workspaceDir alongside a projectId is a contradiction, so it faults.
        const request = { ...body };
        if (request.projectId) {
          const project = findProject(String(request.projectId).trim(), projectsFile);
          if (!project) {
            fail(res, 400, `No project with id ${request.projectId}.`, {
              problems: [`No project with id ${request.projectId}.`]
            });
            return;
          }
          if (request.workspaceDir) {
            fail(res, 400, 'Pass a project or a workspaceDir, not both.', {
              problems: ['Pass a project or a workspaceDir, not both.']
            });
            return;
          }
          request.workspaceDir = project.dir;
        }
        const run = registry.start(request);
        sendJson(res, 202, { ok: true, id: run.id, page: registry.getPage(run.id) });
      } catch (err) {
        fail(res, err.kind === 'invalid-request' ? 400 : 500, err.message, {
          problems: err.problems
        });
      }
      return;
    }

    // --- projects ---------------------------------------------------------
    if (path === '/api/projects' && method === 'GET') {
      const { projects, corrupted } = readProjects(projectsFile);
      sendJson(res, 200, {
        ok: true,
        projects,
        path: projectsPath(projectsFile),
        corrupted: corrupted || undefined
      });
      return;
    }

    if (path === '/api/projects' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      try {
        const project = createProject(body, projectsFile, knownProjectVocabulary(zstack));
        sendJson(res, 201, { ok: true, project });
      } catch (err) {
        fail(res, err.kind === 'invalid-project' ? 400 : 500, err.message, {
          problems: err.problems
        });
      }
      return;
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/runs)?$/);
    if (projectMatch) {
      const id = decodeURIComponent(projectMatch[1]);
      if (projectMatch[2] === '/runs') {
        // The runs owned by one project, newest first.
        if (method !== 'GET') {
          fail(res, 405, `${method} is not allowed for ${path}.`);
          return;
        }
        const project = findProject(id, projectsFile);
        if (!project) {
          fail(res, 404, `No project with id ${id}.`);
          return;
        }
        const limit = positiveInt(url.searchParams.get('limit'), HISTORY_DEFAULT_LIMIT);
        const projectsById = new Map(
          readProjects(projectsFile).projects.map((p) => [p.id, p])
        );
        // A project's runs can sit anywhere in the file, so this is a scan,
        // not a tail read: the tail would silently drop older runs that still
        // belong here. `readHistory` streams with constant memory, so the cost
        // is one pass, not the whole file in memory.
        const archived = readHistory({ limit: Math.max(limit * 5, 200), path: historyFile })
          .entries
          .map(withOverride)
          .filter((entry) => entry && !entry.hidden)
          .map(projectRunSummary)
          .filter((card) => card.projectId === id)
          .slice(0, limit)
          .map((card) => withProjectName(card, projectsById));
        // A finished run this process still retains is already in history, so
        // without the filter it would appear twice: once live, once archived.
        // This mirrors the merge the main list performs, including the hidden
        // filter: a deleted run stays out of its project page while retained.
        const archivedIds = new Set(archived.map((card) => card.id));
        const hiddenIds = new Set(Object.entries(readOverrides(overridesFile).overrides)
          .filter(([, item]) => item && item.hidden === true)
          .map(([id]) => id));
        const live = registry.listLive()
          .filter((r) => r.projectId === id && !archivedIds.has(r.id) && !hiddenIds.has(r.id))
          .map((card) => withProjectName(card, projectsById));
        sendJson(res, 200, {
          ok: true,
          project,
          runs: [...live, ...archived]
            .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
            .slice(0, limit),
          hasMore: archived.length >= limit,
          liveCount: live.filter((r) => r.live).length
        });
        return;
      }
      if (method === 'PUT') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          fail(res, err.status || 400, err.message);
          return;
        }
        try {
          const project = updateProject(id, body, projectsFile, knownProjectVocabulary(zstack));
          sendJson(res, 200, { ok: true, project });
        } catch (err) {
          if (err.kind === 'unknown-project') fail(res, 404, err.message);
          else fail(res, err.kind === 'invalid-project' ? 400 : 500, err.message, { problems: err.problems });
        }
        return;
      }
      if (method === 'DELETE') {
        try {
          const project = deleteProject(id, projectsFile);
          sendJson(res, 200, { ok: true, deleted: project.id });
        } catch (err) {
          fail(res, err.kind === 'unknown-project' ? 404 : 500, err.message);
        }
        return;
      }
      fail(res, 405, `${method} is not allowed for ${path}. Allowed: GET, PUT, DELETE.`);
      return;
    }

    // --- one run ----------------------------------------------------------
    const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const projectsById = new Map(
        readProjects(projectsFile).projects.map((p) => [p.id, p])
      );
      if (method === 'PATCH') {
        // Rename or move. The override is keyed by run id, so the history
        // record it amends is never rewritten; the page and the list resolve
        // the same override and read identically. The id is checked first, so
        // a patch for a run nobody knows does not create an override for it.
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          fail(res, err.status || 400, err.message);
          return;
        }
        const known = {
          projects: (candidate) => projectsById.has(String(candidate).trim())
        };
        let override;
        try {
          override = patchRunOverride(id, body, overridesFile, known, { mustExist: () => runExists(id) });
        } catch (err) {
          if (err.kind === 'unknown-run') fail(res, 404, err.message);
          else fail(res, err.kind === 'invalid-patch' ? 400 : 500, err.message, {
            problems: err.problems
          });
          return;
        }
        const page = await pageForRun(id, projectsById);
        if (!page) {
          fail(res, 404, `No run with id ${id}.`);
          return;
        }
        sendJson(res, 200, { ok: true, id, override, page });
        return;
      }
      if (method === 'DELETE') {
        // Hide, not erase: the record stays in history and the page still
        // resolves by id, so "delete" removes the run from every list without
        // rewriting the file everyone else reads.
        if (!runExists(id)) {
          fail(res, 404, `No run with id ${id}.`);
          return;
        }
        hideRun(id, overridesFile);
        sendJson(res, 200, { ok: true, deleted: id });
        return;
      }
      if (method !== 'GET') {
        fail(res, 405, `${method} is not allowed for ${path}. Allowed: GET, PATCH, DELETE.`);
        return;
      }
      const page = await pageForRun(id, projectsById);
      if (!page) {
        fail(res, 404, `No run with id ${id}.`);
        return;
      }
      sendJson(res, 200, { ok: true, page });
      return;
    }

    // --- cancel a run -----------------------------------------------------
    const cancelMatch = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch) {
      if (method !== 'POST') {
        fail(res, 405, `${method} is not allowed for ${path}.`);
        return;
      }
      const id = decodeURIComponent(cancelMatch[1]);
      const run = registry.get(id);
      if (!run) {
        fail(res, 404, `No run with id ${id} is running in this process.`);
        return;
      }
      const cancelled = registry.cancel(id);
      sendJson(res, 200, { ok: true, cancelled, id });
      return;
    }

    // --- run event stream -------------------------------------------------
    const streamMatch = path.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (streamMatch) {
      if (method !== 'GET') {
        fail(res, 405, `${method} is not allowed for ${path}.`);
        return;
      }
      streamRun(req, res, registry, decodeURIComponent(streamMatch[1]));
      return;
    }

    // --- configuration ----------------------------------------------------
    if (path === '/api/config') {
      let playbooks = [];
      let principles = [];
      try {
        playbooks = zstack.listPlaybooks();
      } catch {
        playbooks = [];
      }
      try {
        principles = zstack.listPrinciples();
      } catch {
        principles = [];
      }
      const stored = zstack.getBudget();
      sendJson(res, 200, {
        ok: true,
        lanes: Object.entries(LANES).map(([id, lane]) => ({
          id,
          name: lane.name ?? id,
          prefix: lane.prefix ?? null,
          description: lane.description ?? null
        })),
        tiers: Object.keys(BUDGET_TIERS),
        sources: Object.keys(BUDGET_SOURCES),
        budget: stored,
        playbooks: playbooks.map((p) => ({ id: p.id, title: p.title, trigger: p.trigger ?? null })),
        principles: principles.map((p) => ({ id: p.id, title: p.title, applyWhen: p.applyWhen ?? null }))
      });
      return;
    }

    // --- budget -----------------------------------------------------------
    if (path === '/api/budget') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      try {
        const mapping = await zstack.setBudget(body.tier, body.source ?? null, body.lane ?? null);
        sendJson(res, 200, {
          ok: true,
          budget: zstack.getBudget(),
          models: mapping.models ?? {},
          laneApplied: mapping.laneApplied !== false,
          panel: mapping.panelList ?? [],
          note: mapping.laneApplied === false
            ? 'The stored models come from your ModelHitch config, so the lane was recorded but not applied.'
            : null
        });
      } catch (err) {
        fail(res, 400, err.message);
      }
      return;
    }

    // --- bridge status ----------------------------------------------------
    if (path === '/api/status') {
      try {
        const status = await zstack.status();
        if (!status.ok) {
          // An unreachable bridge is a state the UI must show, not a 500.
          sendJson(res, 200, { ok: true, connected: false, error: status.error, baseUrl: status.baseUrl });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          connected: true,
          baseUrl: status.baseUrl,
          message: status.message,
          activeProviders: status.activeProviders,
          mode: status.mode,
          lane: status.lane,
          laneInfo: status.laneInfo,
          mapping: status.mapping,
          panelModels: status.panelModels,
          budget: status.budget,
          laneApplied: status.budgetDetail?.laneApplied !== false
        });
      } catch (err) {
        sendJson(res, 200, { ok: true, connected: false, error: err?.message || String(err) });
      }
      return;
    }

    fail(res, 404, `No such endpoint: ${method} ${path}`);
  };

  return { handler, registry, zstack, historyPath: historyFile, projectsPath: projectsFile, overridesPath: overridesFile };
}

/**
 * Bind the server.
 *
 * Binds the requested host and reports `EADDRINUSE` rather than trying the next
 * port. A UI listening somewhere other than where you were told is worse than a
 * refusal, and the caller has the port number to change.
 */
export function startServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const app = createApp(options);
  const server = createServer((req, res) => {
    app.handler(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      fail(res, 500, err?.message || String(err));
    });
  });

  server.on('close', () => app.registry.shutdown());

  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const wrapped = new Error(`Port ${port} is already in use on ${host}. Pass --port to choose another.`);
        wrapped.code = 'EADDRINUSE';
        wrapped.exitCode = 2;
        rejectPromise(wrapped);
        return;
      }
      rejectPromise(err);
    });
    server.listen(port, host, () => {
      const address = server.address();
      resolvePromise({
        server,
        app,
        registry: app.registry,
        host,
        port: address.port,
        url: `http://${host === '::' ? '[::1]' : host}:${address.port}/`
      });
    });
  });
}
