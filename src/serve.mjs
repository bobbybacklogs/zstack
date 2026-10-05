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
import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ZStack } from './sdk.mjs';
import { ZSTACK_ROOT } from './harness.mjs';
import {
  BUDGET_TIERS,
  BUDGET_SOURCES,
  LANES,
  normalizeLane,
  isKnownLane,
  getStoredBudget,
  saveStoredBudget,
  resolveBudgetMapping,
  DEFAULT_BUDGET_FILE
} from './budget.mjs';
import { fetchModelHitchState, GatewayError } from './connector.mjs';
import { readHistoryTail, readHistory, findHistoryEntry, historyPath, newRunId, HISTORY_DEFAULT_LIMIT } from './history.mjs';
import { projectStoredRun, projectRunSummary } from './blocks.mjs';
import { RunRegistry, POLICIES, isKnownPolicy, normalizeStartRequest } from './runs.mjs';
import { idempotencyPath, requestFingerprint, readRunAdmission, reserveRunAdmission, releaseRunAdmission } from './idempotency.mjs';
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
  getOverride,
  overridesPath
} from './overrides.mjs';
import {
  readGitHubStore,
  writeGitHubStore,
  readGitHubToken,
  ghAuthToken,
  fetchGitHubRepos,
  mergeRepos,
  githubPath,
  defaultBaseDir
} from './github.mjs';
import { gitOp, canonicalGitRoot } from './git.mjs';
import { DEFAULT_MAX_TURNS, MAX_MAX_TURNS, TURN_PRESETS, maxTurnsProblem } from './turns.mjs';
import { validateChatRequest, chatWireMessages } from './chat.mjs';
import { validateOptimizeRequest } from './optimize.mjs';
import {
  readChats,
  findChat,
  createChat,
  updateChat,
  deleteChat,
  appendMessage,
  validateChatMessage,
  chatSummary,
  projectChat,
  chatsPath,
  newMessageId,
  CHAT_MAX_MESSAGES
} from './chats.mjs';
import {
  readSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  findSchedule,
  inferScheduleFromText,
  schedulesPath,
  Scheduler
} from './schedules.mjs';
import {
  getWorkfolkStatus,
  fetchWorkfolkRoster,
  dispatchWorkfolkTask,
  getWorkfolkJobStatus,
  pollWorkfolkJob
} from './workfolk.mjs';

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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
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
  const detail = extra.detail ?? (Array.isArray(extra.problems) && extra.problems.length > 0 ? extra.problems[0] : message);
  sendJson(res, status, { ok: false, error: message, detail, ...extra });
}

function getAuthToken(req, url) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.trim() !== '') {
    const trimmed = auth.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
    return trimmed;
  }
  const xToken = req.headers['x-api-token'];
  if (typeof xToken === 'string' && xToken.trim() !== '') {
    return xToken.trim();
  }
  if (url) {
    const qToken = url.searchParams.get('token') || url.searchParams.get('api_token');
    if (typeof qToken === 'string' && qToken.trim() !== '') {
      return qToken.trim();
    }
  }
  return null;
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
  '/api/dashboard': ['GET'],
  '/api/config': ['GET'],
  '/api/budget': ['GET', 'POST', 'PUT'],
  '/api/status': ['GET'],
  '/api/chat': ['POST'],
  '/api/models': ['GET'],
  '/api/chats': ['GET', 'POST'],
  '/api/classify': ['POST'],
  '/api/optimize': ['POST'],
  '/api/github': ['GET'],
  '/api/github/sync': ['POST'],
  '/api/github/repos': ['PUT'],
  '/api/github/git': ['POST'],
  '/api/schedules': ['GET', 'POST'],
  '/api/schedules/infer': ['POST'],
  '/api/workfolk/status': ['GET'],
  '/api/workfolk/workers': ['GET'],
  '/api/workfolk/dispatch': ['POST']
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
 * Attach each cloned repo to a project, creating one where none matches.
 *
 * A project is the grouping runs hang off, so an imported repo becomes one
 * (name = repo name, dir = its local clone). A repo whose clone is not on
 * disk links to nothing: a project must point at a real directory, and a
 * placeholder that faults on first use is a trap. A name that already exists
 * as a project links to it rather than faulting the whole sync.
 */
function linkRepoProjects(repos, projectsFile, zstack) {
  const known = knownProjectVocabulary(zstack);
  const { projects } = readProjects(projectsFile);
  let created = 0;
  const linked = repos.map((repo) => {
    if (!repo.cloned) return { ...repo, projectId: null };
    const dir = resolve(repo.localPath);
    const match = projects.find(
      (p) => resolve(p.dir) === dir || p.name.toLowerCase() === repo.name.toLowerCase()
    );
    if (match) return { ...repo, projectId: match.id };
    try {
      const project = createProject({ name: repo.name, dir }, projectsFile, known);
      projects.push(project);
      created += 1;
      return { ...repo, projectId: project.id };
    } catch {
      // A clash the sync cannot resolve (a name collision with a different
      // directory): the repo stays pickable, it just groups no runs.
      return { ...repo, projectId: null };
    }
  });
  return { repos: linked, created };
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
  if (full !== root && !full.startsWith(root + sep)) {
    if (segments[0] === 'assets') {
      const assetsRoot = resolve(join(ZSTACK_ROOT, 'assets'));
      const assetFull = resolve(join(assetsRoot, ...segments.slice(1)));
      if (assetFull === assetsRoot || assetFull.startsWith(assetsRoot + sep)) {
        return assetFull;
      }
    }
    return null;
  }
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
  for (const entry of backlog) write(entry);

  // Terminal only when the run is settled now, not because the transcript
  // contains an `end`. A resumed run's log holds the end of the leg it paused
  // at, so treating that as terminal closed the stream before the resumed turns
  // arrived: the page froze on "paused" while the run was working.
  if (run.settled) {
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
  const budgetFile = options.budgetPath || options.zstack?.budgetPath || undefined;
  const zstack = options.zstack || new ZStack({ budgetPath: budgetFile });
  if (budgetFile && zstack && !zstack.budgetPath) {
    zstack.budgetPath = budgetFile;
  }
  const historyFile = options.historyPath;
  const admissionsDirectory = idempotencyPath(options.idempotencyPath, historyFile);
  const pendingAdmissions = new Map();
  const projectsFile = options.projectsPath;
  const overridesFile = options.overridesPath;
  const chatsFile = options.chatsPath;
  const githubFile = options.githubPath;
  // Injectable so the sync endpoints are testable without the network.
  const githubFetch = options.githubFetch || fetch;
  const ghExecFile = options.ghExecFile;
  const fetchState = options.fetchModelHitchState
    || (typeof zstack?.fetchModelHitchState === 'function'
      ? zstack.fetchModelHitchState.bind(zstack)
      : (baseUrl, opts) => fetchModelHitchState(baseUrl, opts));
  let budgetMutationLock = Promise.resolve();
  // Chats with a turn in flight. One writer per conversation keeps two replies
  // from interleaving into the same transcript out of order.
  const busyChats = new Set();
  const registry = options.registry || new RunRegistry({
    zstack,
    historyPath: historyFile,
    // Live pages name their project without a re-read on every event: the
    // lookup runs once per page projection, and a rename lands everywhere.
    projectNameFor: (id) => findProject(id, projectsFile)?.name ?? null,
    // Live pages and cards show a custom title without a re-read, same story:
    // the server owns the overrides file and hands the registry a lookup.
    overrideFor: (id) => readOverrides(overridesFile).overrides[id] || null,
    gitExecFile: options.gitExecFile,
    githubFetch: options.githubFetch
  });
  const gitOptions = { execFileImpl: options.gitExecFile };
  // Run admission reserves synchronously, before root resolution can yield.
  // Unresolved admissions conservatively block mutations in every repository.
  // Once a mutation owns a root, admissions to that root cannot activate a run.
  const workspaceMutations = new Map();
  let resolvingRunAdmissions = 0;
  const admitRun = async (workspace, activate) => {
    resolvingRunAdmissions++;
    try {
      let root;
      try { root = await canonicalGitRoot(workspace || process.cwd(), gitOptions); }
      catch { /* Non-Git workspaces still use the registry's normal validation. */ }
      if (root && workspaceMutations.has(root)) {
        throw Object.assign(new Error('A Git mutation is in flight in this repository. Wait before starting or resuming a run.'), { kind: 'git-workspace-busy' });
      }
      if (root) {
        for (const card of registry.listLive()) {
          if (!card.live) continue;
          const activeRun = registry.get(card.id);
          if (!activeRun || activeRun.settled) continue;
          const activeWs = activeRun.workspace || activeRun.request?.workspaceDir;
          if (!activeWs) continue;
          let activeRoot;
          try { activeRoot = await canonicalGitRoot(activeWs, gitOptions); } catch { continue; }
          if (activeRoot === root) {
            throw Object.assign(
              new Error(`A run is already active in repository "${root}".`),
              { kind: 'git-repo-busy', detail: `A run (${activeRun.id}) is already active in repository "${root}".` }
            );
          }
        }
      } else if (workspace) {
        for (const card of registry.listLive()) {
          if (!card.live) continue;
          const activeRun = registry.get(card.id);
          if (!activeRun || activeRun.settled) continue;
          const activeWs = activeRun.workspace || activeRun.request?.workspaceDir;
          if (activeWs && resolve(activeWs) === resolve(workspace)) {
            throw Object.assign(
              new Error(`A run is already active in workspace "${resolve(workspace)}".`),
              { kind: 'git-repo-busy', detail: `A run (${activeRun.id}) is already active in workspace "${resolve(workspace)}".` }
            );
          }
        }
      }
      // No await between checking the reservation and activating the registry.
      return activate();
    } finally { resolvingRunAdmissions--; }
  };
  const schedulesFile = options.schedulesPath;
  const scheduler = options.scheduler || new Scheduler({
    schedulesPath: schedulesFile,
    admitRun,
    registry,
    findProject: (id, p) => findProject(id, p || projectsFile),
    projectsPath: projectsFile,
    tickIntervalMs: options.schedulerTickIntervalMs || 30000
  });
  const startedAt = Date.now();
  const boundHost = options.host || DEFAULT_HOST;
  const apiToken = options.apiToken ?? options.token ?? process.env.ZSTACK_API_TOKEN ?? null;

  // Every projection of a stored run passes through here: the history record
  // with its sidecar override applied, so a renamed, moved, or hidden run
  // reads the same from the list, the page, and the project page.
  const withOverride = (entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const override = readOverrides(overridesFile).overrides[entry.id] || null;
    return applyOverride(entry, override);
  };

  /**
   * Annotate a projected page with status, turn counts, tool calls, outcomes,
   * file changes, and project ID so it satisfies both the UI and external API callers.
   */
  const annotateRunPage = (page, liveRun, entry) => {
    if (!page) return page;
    page.requester = liveRun?.request?.requester ?? entry?.requester ?? null;
    page.idempotencyKey = liveRun?.request?.idempotencyKey ?? entry?.idempotencyKey ?? null;
    if (page.turns === undefined) {
      page.turns = page.counts?.turns ?? liveRun?.turns ?? entry?.turns ?? 0;
    }
    if (page.toolCalls === undefined) {
      page.toolCalls = page.counts?.toolCalls ?? liveRun?.toolCalls ?? entry?.toolCalls ?? 0;
    }
    if (page.fileChanges === undefined) {
      page.fileChanges = liveRun?.fileChanges ?? entry?.fileChanges ?? [];
    }
    if (page.outcomes === undefined) {
      const toolBlocks = (page.blocks || []).filter((b) => b && b.kind === 'tool');
      page.outcomes = toolBlocks.map((b) => ({
        name: b.name,
        target: b.target ?? null,
        outcome: b.outcome ?? 'unknown',
        tone: b.tone ?? null
      }));
    }
    return page;
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
    if (livePage) {
      const page = withProjectName(livePage, projectsById);
      if (page.turnBudget) page.turnBudget.inPlace = registry.canResume(id);
      annotateRunPage(page, registry.get(id), null);
      return page;
    }
    let entry = null;
    try {
      entry = findHistoryEntry(id, historyFile);
    } catch {
      return null;
    }
    if (!entry) return null;
    const page = withProjectName(archivedPageFor(entry, id), projectsById);
    annotateRunPage(page, null, entry);
    return page;
  };

  /**
   * An archived record as a page, with its resume claims checked against what
   * this process can actually do.
   *
   * Resuming pause happens in memory: the registry holds the run, and a restart
   * takes that away while leaving a history record that still says "paused,
   * session saved". Left alone the page would offer a Resume button whose
   * endpoint answers 404 — a control that lies. So a paused run is only
   * resumable in place when this process is the one holding it, and otherwise
   * the page says so and offers the continuation that does work from history.
   */
  const archivedPageFor = (entry, id) => {
    const page = projectStoredRun(withOverride(entry));
    if (page.turnBudget && page.turnBudget.paused) {
      const inPlace = registry.canResume(id);
      page.turnBudget.inPlace = inPlace;
      page.turnBudget.staleAfterRestart = !inPlace;
    } else if (page.turnBudget) {
      page.turnBudget.inPlace = false;
    }
    return page;
  };

  /**
   * What the registry needs to continue a run, from either place a run lives.
   *
   * A retained live run is preferred, matching the page endpoint. Falling back
   * to history is what makes continuation work after a restart: the session id
   * was written to the record when the run finished, so a run that hit its
   * limit yesterday can still be picked up today.
   */
  const continuationSourceFor = (id) => {
    const live = registry.get(id);
    if (live) {
      return {
        id: live.id,
        sessionId: live.sessionId ?? null,
        maxTurns: live.maxTurns ?? live.request?.maxTurns ?? null,
        playbook: live.playbook,
        role: live.request?.role,
        model: live.model,
        policy: live.request?.policy,
        projectId: live.projectId ?? live.request?.projectId ?? null,
        workspace: live.workspace,
        turnLimitReached: live.turnLimitReached === true
      };
    }
    const entry = findHistoryEntry(id, historyFile);
    if (!entry) return null;
    const override = getOverride(id, overridesFile);
    return {
      id,
      sessionId: entry.sessionId ?? null,
      maxTurns: entry.maxTurns ?? null,
      playbook: entry.playbook,
      role: entry.role,
      // A completion run records its model on the start step rather than the
      // record, so the continuation has something to resume on either way.
      model: entry.model ?? null,
      // Older records predate the stored policy; `applied` is the one bit they
      // do carry, and continuing a write-enabled run as read-only would report
      // the follow-up work as declined for no visible reason.
      policy: entry.policy ?? (entry.applied === true ? 'apply' : null),
      // The override wins, so continuing a run that was moved carries the move.
      projectId: override && 'projectId' in override ? override.projectId : (entry.projectId ?? null),
      workspace: entry.workspace ?? null,
      turnLimitReached: entry.turnLimitReached === true
    };
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';

    if (!hostAllowed(req, boundHost)) {
      fail(res, 403, `This server does not answer for host ${req.headers.host || '(none)'}.`);
      return;
    }

    if (apiToken) {
      const clientToken = getAuthToken(req, url);
      if (!clientToken || clientToken !== apiToken) {
        fail(res, 401, 'Unauthorized', { detail: 'Missing or invalid API token.' });
        return;
      }
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
      //
      // Deduped by id because a run can now be recorded more than once: pausing
      // writes a record, and resuming and finishing writes another for the same
      // run. History is append-only so the newest wins, and without this the
      // list would show the same run twice — once paused and once finished.
      const seenIds = new Set();
      const archived = readHistoryTail(limit, historyFile)
        .map(withOverride)
        .filter((entry) => entry && !entry.hidden)
        .filter((entry) => {
          const id = entry.id;
          if (seenIds.has(id)) return false;
          seenIds.add(id);
          return true;
        })
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

    // --- dashboard --------------------------------------------------------
    // One read for the main view: status counts, per-project activity, and
    // the newest runs. The client could assemble this from /api/runs plus
    // one request per project, but that is N+1 requests on every navigation
    // to the page the operator sees most. The window is bounded (newest 200
    // records scanned, newest 8 runs returned), so the cost is one pass with
    // constant memory — the same shape as the project page's scan.
    if (path === '/api/dashboard' && method === 'GET') {
      const projects = readProjects(projectsFile).projects;
      const projectsById = new Map(projects.map((p) => [p.id, p]));
      const hiddenIds = new Set(Object.entries(readOverrides(overridesFile).overrides)
        .filter(([, item]) => item && item.hidden === true)
        .map(([id]) => id));
      const scannedSeen = new Set();
      const scanned = readHistory({ limit: 200, path: historyFile }).entries
        .map(withOverride)
        .filter((entry) => entry && !entry.hidden)
        // Same dedupe as the list: a paused run is recorded again when it
        // resumes, and counting both would report one run as two.
        .filter((entry) => {
          if (scannedSeen.has(entry.id)) return false;
          scannedSeen.add(entry.id);
          return true;
        });
      const scannedIds = new Set(scanned.map((e) => e.id));
      const live = registry.listLive()
        .filter((r) => !scannedIds.has(r.id) && !hiddenIds.has(r.id));

      let running = 0;
      let failed24h = 0;
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const perProject = new Map();
      const cards = [];
      for (const card of [...live, ...scanned.map(projectRunSummary)]) {
        const annotated = withProjectName(card, projectsById);
        if (annotated.live || annotated.status === 'running' || annotated.status === 'starting') {
          running++;
        }
        const at = annotated.at ? Date.parse(annotated.at) : NaN;
        if (!Number.isNaN(at) && at >= since) {
          if (annotated.status === 'failed') failed24h++;
        }
        if (cards.length < 8) cards.push(annotated);
        const pid = annotated.projectId || null;
        if (!perProject.has(pid)) {
          perProject.set(pid, {
            projectId: pid,
            projectName: pid ? projectsById.get(pid)?.name ?? null : null,
            runs: 0,
            lastAt: null
          });
        }
        const bucket = perProject.get(pid);
        bucket.runs++;
        if (annotated.at && (!bucket.lastAt || annotated.at > bucket.lastAt)) {
          bucket.lastAt = annotated.at;
        }
      }
      // A project with no runs in the window still gets a row: the dashboard
      // answers "what is active" and "what exists", and a quiet project is
      // an answer to the first, not an absence from the second.
      for (const p of projects) {
        if (!perProject.has(p.id)) {
          perProject.set(p.id, { projectId: p.id, projectName: p.name, runs: 0, lastAt: null });
        }
      }
      sendJson(res, 200, {
        ok: true,
        running,
        failed24h,
        windowRuns: scanned.length + live.length,
        projects: [...perProject.values()].sort((a, b) =>
          String(b.lastAt || '').localeCompare(String(a.lastAt || ''))
        ),
        recent: cards
          .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
          .slice(0, 8)
      });
      return;
    }

    // --- start a run ------------------------------------------------------
    if (path === '/api/runs' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message, { detail: err.message });
        return;
      }

      const problems = [];

      for (const field of ['requester', 'idempotencyKey']) {
        if (body?.[field] !== undefined && (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 256)) {
          problems.push(`${field} must be a non-empty string of at most 256 characters.`);
        }
      }

      // Prompt check: empty or whitespace-only is 400
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) {
        problems.push('A run needs a prompt.');
      }

      // Playbook check: reject unknown/unloaded with 400 naming offending value
      if (body.playbook !== undefined && body.playbook !== null && body.playbook !== '') {
        let loadedPlaybooks = [];
        try {
          loadedPlaybooks = (zstack.listPlaybooks?.() || []).map((p) => p.id);
        } catch {
          loadedPlaybooks = [];
        }
        if (!loadedPlaybooks.includes(body.playbook)) {
          problems.push(`Unknown playbook "${body.playbook}".`);
        }
      }

      // Lane check: reject unknown with 400 naming offending value
      if (body.lane !== undefined && body.lane !== null && body.lane !== '') {
        const knownLanes = Object.keys(LANES);
        if (!knownLanes.includes(body.lane)) {
          problems.push(`Unknown lane "${body.lane}". Valid lanes: ${knownLanes.join(', ')}.`);
        }
      }

      // Policy check & default: default policy to 'read-only'
      const policy = body.policy !== undefined && body.policy !== null && body.policy !== ''
        ? body.policy
        : 'read-only';
      if (!isKnownPolicy(policy)) {
        problems.push(`Unknown policy "${policy}". Valid policies: ${Object.keys(POLICIES).join(', ')}.`);
      }

      // MaxTurns check
      if (body.maxTurns !== undefined) {
        const prob = maxTurnsProblem(body.maxTurns);
        if (prob) problems.push(prob);
      }

      if (problems.length > 0) {
        fail(res, 400, problems[0], {
          problems,
          detail: problems.join(' ')
        });
        return;
      }

      // Project & workspace resolution
      const rawProjectId = body.project ?? body.projectId;
      const requestedWorkspace = body.workspace ?? body.workspaceDir;
      let resolvedWorkspace;
      let targetProjectId = undefined;

      if (rawProjectId !== undefined && rawProjectId !== null && rawProjectId !== '') {
        if (typeof rawProjectId !== 'string' || rawProjectId.trim() === '') {
          fail(res, 400, 'Invalid project id.', { detail: 'Project must be a non-empty string.', problems: ['Project must be a non-empty string.'] });
          return;
        }
        const trimmedId = rawProjectId.trim();
        const project = findProject(trimmedId, projectsFile);
        if (!project) {
          fail(res, 404, `No project with id ${trimmedId}.`, {
            detail: `No project with id "${trimmedId}".`,
            problems: [`No project with id ${trimmedId}.`]
          });
          return;
        }
        targetProjectId = project.id;

        // Check project directory exists on disk
        try {
          const st = statSync(resolve(project.dir));
          if (!st.isDirectory()) throw new Error('Not a directory');
        } catch {
          fail(res, 400, `Project "${project.name}" directory no longer exists.`, {
            detail: `Directory for project "${project.name}" (${project.dir}) no longer exists.`,
            problems: [`Project "${project.name}" directory no longer exists.`]
          });
          return;
        }

        // Refuse workspace alongside named project / outside named project
        if (requestedWorkspace !== undefined && requestedWorkspace !== null && requestedWorkspace !== '') {
          if (typeof requestedWorkspace !== 'string') {
            fail(res, 400, 'Workspace must be a string.', { detail: 'Workspace must be a string.', problems: ['Workspace must be a string.'] });
            return;
          }
          const targetDir = resolve(requestedWorkspace.trim());
          const projectDir = resolve(project.dir);
          if (targetDir !== projectDir && !targetDir.startsWith(projectDir + sep)) {
            fail(res, 400, `Workspace is outside project "${project.name}". Pass a project or a workspaceDir, not both.`, {
              detail: `Requested workspace "${requestedWorkspace}" is outside project "${project.name}" directory (${project.dir}).`,
              problems: [`Workspace is outside project "${project.name}". Pass a project or a workspaceDir, not both.`]
            });
            return;
          }
          fail(res, 400, 'Pass a project or a workspaceDir, not both.', {
            detail: 'Pass a project or a workspaceDir, not both.',
            problems: ['Pass a project or a workspaceDir, not both.']
          });
          return;
        }

        // Always resolve workspace from stored project
        resolvedWorkspace = project.dir;
      } else {
        if (requestedWorkspace !== undefined && requestedWorkspace !== null && requestedWorkspace !== '') {
          if (typeof requestedWorkspace !== 'string') {
            fail(res, 400, 'Workspace must be a string.', { detail: 'Workspace must be a string.', problems: ['Workspace must be a string.'] });
            return;
          }
          resolvedWorkspace = resolve(requestedWorkspace.trim());
        }
      }

      const request = {
        prompt,
        policy,
        playbook: body.playbook || undefined,
        lane: body.lane || undefined,
        maxTurns: body.maxTurns !== undefined ? body.maxTurns : undefined,
        projectId: targetProjectId,
        workspaceDir: resolvedWorkspace,
        requester: body.requester?.trim(),
        idempotencyKey: body.idempotencyKey?.trim(),
        autoPr: body.autoPr === true || body.pr === true
      };

      try {
        const key = request.idempotencyKey;
        const fingerprint = requestFingerprint({ ...normalizeStartRequest(request), workspaceDir: request.workspaceDir || process.cwd() });
        const replay = async (record) => {
          if (record.fingerprint !== fingerprint) {
            fail(res, 409, 'This idempotencyKey was already used for a different run request.');
            return;
          }
          const page = await pageForRun(record.id, new Map(readProjects(projectsFile).projects.map((p) => [p.id, p])));
          if (!page) {
            fail(res, 409, 'The previously accepted run is no longer available. Refusing to repeat execution.', { id: record.id });
            return;
          }
          sendJson(res, 200, { ok: true, id: record.id, replayed: true, page });
        };
        if (key && pendingAdmissions.has(key)) await pendingAdmissions.get(key);
        const previous = key ? readRunAdmission(key, admissionsDirectory) : null;
        if (previous) { await replay(previous); return; }
        let releasePending;
        if (key) pendingAdmissions.set(key, new Promise((resolvePending) => { releasePending = resolvePending; }));
        let outcome;
        try {
          outcome = await admitRun(request.workspaceDir, () => {
            const existing = key ? readRunAdmission(key, admissionsDirectory) : null;
            if (existing) return { previous: existing };
            const id = newRunId();
            if (key && !reserveRunAdmission(key, { id, fingerprint, requester: request.requester ?? null }, admissionsDirectory)) {
              return { previous: readRunAdmission(key, admissionsDirectory) };
            }
            try { return { run: registry.start(request, { id }) }; }
            catch (error) { if (key) releaseRunAdmission(key, admissionsDirectory); throw error; }
          });
        } finally {
          if (key) { pendingAdmissions.delete(key); releasePending(); }
        }
        if (outcome.previous) { await replay(outcome.previous); return; }
        const run = outcome.run;
        const page = registry.getPage(run.id);
        annotateRunPage(page, run, null);
        sendJson(res, 201, { ok: true, id: run.id, page });
      } catch (err) {
        const status = (err.kind === 'git-workspace-busy' || err.kind === 'git-repo-busy' || err.kind === 'git-active-run')
          ? 409
          : err.kind === 'invalid-request'
            ? 400
            : 500;
        fail(res, status, err.message, {
          detail: err.detail || err.message,
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

    // --- github ------------------------------------------------------------
    if (path === '/api/github' && method === 'GET') {
      const store = readGitHubStore(githubFile);
      sendJson(res, 200, {
        ok: true,
        // Whether a token exists — from the environment, a .env file, or an
        // authenticated gh CLI — never the token itself.
        configured: readGitHubToken() !== null || (await ghAuthToken({ execFileImpl: ghExecFile })) !== null,
        login: store.login,
        syncedAt: store.syncedAt,
        baseDir: store.baseDir,
        repos: store.repos,
        corrupted: store.corrupted || undefined,
        path: store.path
      });
      return;
    }

    if (path === '/api/github/sync' && method === 'POST') {
      // A PAT from the environment or .env first; an authenticated gh CLI
      // answers for a machine that never set either.
      const token = readGitHubToken() || (await ghAuthToken({ execFileImpl: ghExecFile }));
      if (!token) {
        fail(res, 400, 'No GitHub token. Set GITHUB_TOKEN in .env or the environment, or log in with the gh CLI, then sync again.', {
          problems: ['No GitHub token. Set GITHUB_TOKEN in .env or the environment, or log in with the gh CLI, then sync again.']
        });
        return;
      }
      let fetched;
      try {
        fetched = await fetchGitHubRepos({ token, fetchImpl: githubFetch });
      } catch (err) {
        fail(res, 502, err.message, { problems: [err.message] });
        return;
      }
      // The merge runs before the project linking so the paths the linking
      // sees are the merged ones: an edited localPath survives the re-sync
      // and its project points where the reader chose.
      const store = readGitHubStore(githubFile);
      const merged = mergeRepos(store.repos, fetched.repos, store.baseDir);
      const { repos, created } = linkRepoProjects(merged, projectsFile, zstack);
      const doc = {
        login: fetched.login || store.login,
        syncedAt: new Date().toISOString(),
        baseDir: store.baseDir || defaultBaseDir(),
        repos
      };
      writeGitHubStore(githubFile, doc);
      sendJson(res, 200, { ok: true, ...doc, projectsCreated: created });
      return;
    }

    if (path === '/api/github/repos' && method === 'PUT') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      const problems = [];
      if (typeof body?.fullName !== 'string' || body.fullName.trim() === '') {
        problems.push('A repo needs its full name (owner/name).');
      }
      if (typeof body?.localPath !== 'string' || body.localPath.trim() === '') {
        problems.push('A repo needs a local path.');
      } else {
        try {
          if (!statSync(resolve(body.localPath.trim())).isDirectory()) {
            problems.push(`"${body.localPath.trim()}" is not a directory.`);
          }
        } catch {
          problems.push(`"${body.localPath.trim()}" does not exist or cannot be read.`);
        }
      }
      if (problems.length > 0) {
        fail(res, 400, problems.join(' '), { problems });
        return;
      }
      const store = readGitHubStore(githubFile);
      const repo = store.repos.find((r) => r.fullName === body.fullName.trim());
      if (!repo) {
        fail(res, 404, `No synced repo named "${body.fullName.trim()}". Sync first.`);
        return;
      }
      const updated = {
        ...repo,
        localPath: resolve(body.localPath.trim()),
        cloned: true
      };
      // The picked path decides the project dir, exactly as the sync does.
      const { repos: linked } = linkRepoProjects(
        store.repos.map((r) => (r.fullName === repo.fullName ? updated : r)),
        projectsFile,
        zstack
      );
      const next = {
        login: store.login,
        syncedAt: store.syncedAt,
        baseDir: store.baseDir,
        repos: linked
      };
      writeGitHubStore(githubFile, next);
      sendJson(res, 200, {
        ok: true,
        repo: linked.find((r) => r.fullName === repo.fullName)
      });
      return;
    }

    // --- github git work ---------------------------------------------------
    /**
     * One git operation on one repo's local clone, or on the workspace a run
     * executed in. The directory always comes from the server's own records
     * (the synced repo or the run page), never from the client, so a request
     * cannot point the server at an arbitrary directory.
     */
    const runGitOp = async (dir, body) => {
      let reservedRoot;
      const reservation = Symbol('git mutation');
      try {
        return { ok: true, ...(await gitOp(dir, body, {
          ...gitOptions,
          beforeMutation: async (root) => {
            if (resolvingRunAdmissions) throw Object.assign(new Error('A run is being admitted. Retry the Git mutation after admission finishes.'), { kind: 'git-active-run' });
            workspaceMutations.set(root, reservation);
            reservedRoot = root;
            for (const card of registry.listLive()) {
              if (!card.live) continue;
              const run = registry.get(card.id);
              const workspace = run?.workspace || run?.request?.workspaceDir || process.cwd();
              let activeRoot;
              try { activeRoot = await canonicalGitRoot(workspace, gitOptions); } catch { continue; }
              if (activeRoot === root) throw Object.assign(new Error('Git mutations are refused while a run is active in this repository. Stop or finish the run first.'), { kind: 'git-active-run' });
            }
          }
        })) };
      } catch (err) {
        const status =
          err.kind === 'git-invalid' ? 400
          : err.kind === 'git-unavailable' ? 502
          : err.kind === 'git-timeout' ? 504
          : 409;
        fail(res, status, err.message, {
          problems: [err.message, ...(err.output ? [err.output] : [])]
        });
        return null;
      } finally {
        if (reservedRoot && workspaceMutations.get(reservedRoot) === reservation) workspaceMutations.delete(reservedRoot);
      }
    };

    if (path === '/api/github/git' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      const store = readGitHubStore(githubFile);
      const repo = store.repos.find((r) => r.fullName === String(body?.fullName || '').trim());
      if (!repo) {
        fail(res, 404, `No synced repo named "${String(body?.fullName || '')}". Sync first.`);
        return;
      }
      if (!repo.cloned) {
        fail(res, 400, `"${repo.fullName}" is not cloned locally, so there is no working tree to work in.`, {
          problems: [`"${repo.fullName}" is not cloned locally, so there is no working tree to work in.`]
        });
        return;
      }
      const doc = await runGitOp(repo.localPath, body);
      if (doc) sendJson(res, 200, { ...doc, fullName: repo.fullName });
      return;
    }

    const runGitMatch = path.match(/^\/api\/runs\/([^/]+)\/git$/);
    if (runGitMatch) {
      let id;
      try { id = decodeURIComponent(runGitMatch[1]); }
      catch { fail(res, 400, 'Run id contains invalid percent encoding.'); return; }
      if (method !== 'POST') {
        fail(res, 405, `${method} is not allowed for ${path}. Allowed: POST.`);
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      const projectsById = new Map(
        readProjects(projectsFile).projects.map((p) => [p.id, p])
      );
      const page = await pageForRun(id, projectsById);
      if (!page) {
        fail(res, 404, `No run with id ${id}.`);
        return;
      }
      if (!page.workspace) {
        fail(res, 400, 'This run recorded no workspace directory, so there is nothing to work in.');
        return;
      }
      const doc = await runGitOp(page.workspace, body);
      if (doc) sendJson(res, 200, { ...doc, runId: id });
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
        fail(res, 404, `No run with id ${id}.`, { detail: `No run with id ${id}.` });
        return;
      }
      sendJson(res, 200, { ok: true, page, ...page });
      return;
    }

    // --- continue a run ---------------------------------------------------
    // The answer to "it stopped early, now what". A run that spent its turn
    // budget is resumed from the session it saved, with a bigger budget, as a
    // new run: the original stays exactly as it happened.
    const continueMatch = path.match(/^\/api\/runs\/([^/]+)\/continue$/);
    if (continueMatch) {
      if (method !== 'POST') {
        fail(res, 405, `${method} is not allowed for ${path}.`);
        return;
      }
      const id = decodeURIComponent(continueMatch[1]);
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      const previous = continuationSourceFor(id);
      if (!previous) {
        fail(res, 404, `No run with id ${id}.`);
        return;
      }
      try {
        // continueRun uses the default cwd for project-backed continuations;
        // otherwise it forwards the recorded workspace to start().
        const workspace = previous.projectId ? process.cwd() : previous.workspace;
        const live = await admitRun(workspace, () => registry.continueRun(previous, body));
        sendJson(res, 202, {
          ok: true,
          id: live.id,
          continuedFrom: id,
          page: registry.getPage(live.id)
        });
      } catch (err) {
        // 409 for a run that exists but cannot be resumed: it is not a missing
        // resource and not a bad request, and the reader needs to know the
        // difference between "no such run" and "that one cannot continue".
        const status = err.kind === 'unknown-run'
          ? 404
          : err.kind === 'not-resumable' || err.kind === 'git-workspace-busy'
            ? 409
            : 400;
        fail(res, status, err.message, err.problems ? { problems: err.problems } : {});
      }
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

    // --- pause a run ------------------------------------------------------
    // A pause is a request the run honours at its next turn boundary, not an
    // action taken here. Nothing is killed, so the harness finishes the turn it
    // is in and saves its session — which is the only reason resuming is
    // possible at all.
    const pauseMatch = path.match(/^\/api\/runs\/([^/]+)\/pause$/);
    if (pauseMatch) {
      if (method !== 'POST') {
        fail(res, 405, `${method} is not allowed for ${path}.`);
        return;
      }
      const id = decodeURIComponent(pauseMatch[1]);
      const requested = registry.pause(id);
      if (!requested) {
        // 409 rather than 404: the run exists, it just has no loop left to
        // interrupt. A control that claimed to pause a finished run would lie.
        fail(res, 409, `No run with id ${id} is running in this process, so there is nothing to pause.`);
        return;
      }
      const page = registry.getPage(id);
      sendJson(res, 202, { ok: true, pausing: id, page });
      return;
    }

    // --- resume a paused run ----------------------------------------------
    const resumeMatch = path.match(/^\/api\/runs\/([^/]+)\/resume$/);
    if (resumeMatch) {
      if (method !== 'POST') {
        fail(res, 405, `${method} is not allowed for ${path}.`);
        return;
      }
      const id = decodeURIComponent(resumeMatch[1]);
      try {
        const run = registry.get(id);
        const live = await admitRun(run?.workspace || run?.request?.workspaceDir, () => registry.resume(id));
        sendJson(res, 202, { ok: true, id: live.id, page: registry.getPage(live.id) });
      } catch (err) {
        // 404 for a run this process never saw; 409 for one that exists in a
        // state that cannot be resumed, which is a different answer and the
        // reader needs to be able to tell them apart. 400 for the rest.
        const status = err.kind === 'unknown-run'
          ? 404
          : err.kind === 'not-resumable' || err.kind === 'not-paused' || err.kind === 'git-workspace-busy'
            ? 409
            : 400;
        fail(res, status, err.message);
      }
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
        // The turn budgets the composer offers and the run endpoint accepts.
        // Served rather than hard-coded in the client so the two cannot drift
        // apart: a preset the UI shows is one the server will honour.
        turnPresets: TURN_PRESETS.map((p) => ({ ...p })),
        defaultMaxTurns: DEFAULT_MAX_TURNS,
        maxMaxTurns: MAX_MAX_TURNS,
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
      if (method === 'GET') {
        let state;
        try {
          state = await fetchState(zstack.baseUrl, { timeoutMs: zstack.timeoutMs });
        } catch (err) {
          const kind = err?.kind || 'unreachable';
          const status = kind === 'timeout'
            ? 504
            : (kind === 'unreachable' || kind === 'http' || kind === 'parse' ? 502 : 500);
          fail(res, status, err?.message || 'Cannot reach ModelHitch', {
            kind,
            detail: err?.detail || err?.message || 'Cannot reach ModelHitch'
          });
          return;
        }

        const stored = getStoredBudget(budgetFile);
        const mapping = resolveBudgetMapping({
          tier: stored.tier,
          source: stored.source,
          lane: stored.lane,
          state
        });

        sendJson(res, 200, {
          ok: true,
          budget: stored,
          tier: stored.tier,
          source: stored.source,
          lane: stored.lane,
          models: mapping.models ?? {},
          laneApplied: mapping.laneApplied !== false,
          panel: mapping.panelList ?? [],
          mode: mapping.mode,
          effectiveFor: 'subsequently started runs',
          note: mapping.laneApplied === false
            ? 'The stored models come from your ModelHitch config, so the lane was recorded but not applied.'
            : null
        });
        return;
      }

      if (method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          fail(res, err.status || 400, err.message);
          return;
        }

        const allowedKeys = new Set(['tier', 'source', 'lane', 'confirm']);
        const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
        if (unknownKeys.length > 0) {
          fail(res, 400, `Unknown field(s): ${unknownKeys.join(', ')}. Allowed fields: tier, source, lane, confirm.`, {
            detail: `Unknown field(s): ${unknownKeys.join(', ')}. Allowed fields: tier, source, lane, confirm.`
          });
          return;
        }

        if (body.confirm !== undefined && typeof body.confirm !== 'boolean') {
          fail(res, 400, 'Invalid confirm: must be a boolean.', {
            detail: 'Field "confirm" must be a boolean.'
          });
          return;
        }

        if (body.tier !== undefined) {
          if (typeof body.tier !== 'string' || !body.tier.trim() || !BUDGET_TIERS[body.tier.trim().toLowerCase()]) {
            const validTiers = Object.keys(BUDGET_TIERS).join(', ');
            fail(res, 400, `Unknown budget tier: "${body.tier}". Allowed tiers: ${validTiers}.`, {
              detail: `Unknown budget tier: "${body.tier}". Allowed tiers: ${validTiers}.`
            });
            return;
          }
        }

        if (body.source !== undefined) {
          if (typeof body.source !== 'string' || !body.source.trim() || !['catalog', 'config'].includes(body.source.trim().toLowerCase())) {
            fail(res, 400, `Unknown budget source: "${body.source}". Allowed sources: catalog, config.`, {
              detail: `Unknown budget source: "${body.source}". Allowed sources: catalog, config.`
            });
            return;
          }
        }

        if (body.lane !== undefined) {
          if (typeof body.lane !== 'string' || !body.lane.trim() || !isKnownLane(body.lane)) {
            fail(res, 400, `Unknown provider lane: "${body.lane}". Allowed lanes: auto, zen, go, hitch.`, {
              detail: `Unknown provider lane: "${body.lane}". Allowed lanes: auto, zen, go, hitch.`
            });
            return;
          }
        }

        const stored = getStoredBudget(budgetFile);
        const nextTier = body.tier ? body.tier.trim().toLowerCase() : stored.tier;
        const nextSource = body.source ? body.source.trim().toLowerCase() : (stored.source || 'catalog');
        const nextLane = body.lane !== undefined ? normalizeLane(body.lane) : (stored.lane || 'auto');

        let state;
        try {
          state = await fetchState(zstack.baseUrl, { timeoutMs: zstack.timeoutMs });
        } catch (err) {
          const kind = err?.kind || 'unreachable';
          const status = kind === 'timeout'
            ? 504
            : (kind === 'unreachable' || kind === 'http' || kind === 'parse' ? 502 : 500);
          fail(res, status, err?.message || 'Cannot reach ModelHitch', {
            kind,
            detail: err?.detail || err?.message || 'Cannot reach ModelHitch'
          });
          return;
        }

        const mapping = resolveBudgetMapping({
          tier: nextTier,
          source: nextSource,
          lane: nextLane,
          state
        });

        const isConfirmed = body.confirm === true;
        let savedBudget = null;

        if (isConfirmed) {
          const prevLock = budgetMutationLock;
          let releaseLock;
          budgetMutationLock = new Promise((resolveLock) => {
            releaseLock = resolveLock;
          });
          try {
            await prevLock;
            savedBudget = saveStoredBudget({
              tier: nextTier,
              source: nextSource,
              lane: nextLane
            }, budgetFile);
          } finally {
            releaseLock();
          }
        }

        sendJson(res, 200, {
          ok: true,
          applied: isConfirmed,
          preview: !isConfirmed,
          budget: isConfirmed ? savedBudget : { tier: nextTier, source: nextSource, lane: nextLane },
          tier: nextTier,
          source: nextSource,
          lane: nextLane,
          models: mapping.models ?? {},
          laneApplied: mapping.laneApplied !== false,
          panel: mapping.panelList ?? [],
          mode: mapping.mode,
          effectiveFor: isConfirmed ? 'subsequently started runs' : 'subsequently started runs (once confirmed)',
          note: mapping.laneApplied === false
            ? 'The stored models come from your ModelHitch config, so the lane was recorded but not applied.'
            : null
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

    // --- chat models ------------------------------------------------------
    // The catalogue the pin picker offers. A down bridge is a state the page
    // must render, not an error: it answers 200 with `connected: false` so the
    // picker can say why it is empty instead of the page failing to load.
    if (path === '/api/models') {
      try {
        const listing = typeof zstack.models === 'function' ? await zstack.models() : null;
        if (!listing || listing.connected === false) {
          sendJson(res, 200, {
            ok: true,
            connected: false,
            error: listing?.error || 'This server has no model catalogue.',
            models: []
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          connected: true,
          activeProviders: listing.activeProviders || [],
          models: listing.models || []
        });
      } catch (err) {
        sendJson(res, 200, { ok: true, connected: false, error: err?.message || String(err), models: [] });
      }
      return;
    }

    // --- one chat turn ----------------------------------------------------
    // The narrowest endpoint here: one completion against a pinned model, with
    // no tools, workspace, playbook, or record. It exists because the browser
    // cannot POST the gateway directly (cross-origin), so this proxies one
    // turn. A reader who disconnects aborts the upstream call rather than
    // leaving a model generating for a page nobody is looking at.
    if (path === '/api/chat' && method === 'POST') {
      if (typeof zstack.chat !== 'function') {
        fail(res, 503, 'This server has no chat capability.');
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      const problems = validateChatRequest(body);
      if (problems.length > 0) {
        fail(res, 400, problems.join(' '), { problems });
        return;
      }
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const reply = await zstack.chat({
          model: String(body.model).trim(),
          messages: body.messages,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          signal: controller.signal
        });
        sendJson(res, 200, {
          ok: true,
          content: reply.content,
          model: reply.model,
          usage: reply.usage,
          durationMs: reply.durationMs
        });
      } catch (err) {
        // The socket is already closing when this fires, so there is nobody to
        // tell; returning quietly is the honest answer, not an error response.
        if (controller.signal.aborted) return;
        const kind = err?.kind || null;
        const status = kind === 'timeout'
          ? 504
          : kind === 'unreachable' || kind === 'http' || kind === 'parse'
            ? 502
            : 500;
        fail(res, status, err?.message || String(err), kind ? { kind } : {});
      }
      return;
    }

    // --- classify a prompt -----------------------------------------------
    // Matches a prompt against playbooks using keyword scoring and semantic
    // routing if ambiguous. If the bridge is unreachable, falls back to keyword
    // scoring with a warning.
    if (path === '/api/classify' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      const raw = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!raw) {
        fail(res, 400, 'A prompt is required to classify.');
        return;
      }
      const detailed = typeof zstack.classifyPromptDetailed === 'function'
        ? zstack.classifyPromptDetailed(raw)
        : (typeof zstack.classifyPrompt === 'function' ? zstack.classifyPrompt(raw) : { type: 'feature', principles: [], role: 'feature, refactoring' });
      let playbook = detailed.type;
      let principles = detailed.principles || [];
      let role = detailed.role || null;
      let semanticScore = null;
      let warning = null;

      if (detailed.ambiguous) {
        try {
          const { classifyPromptSemantic, ROUTER_MIN_SCORE } = await import('./router.mjs');
          const sem = await classifyPromptSemantic(raw, { baseUrl: zstack.baseUrl, rootDir: zstack.rootDir });
          if (sem && sem.score >= ROUTER_MIN_SCORE) {
            semanticScore = sem.score;
            const { PLAYBOOK_TRIGGERS } = await import('./sdk.mjs');
            const rule = PLAYBOOK_TRIGGERS.find((r) => r.type === sem.type);
            if (rule) {
              playbook = rule.type;
              role = rule.role;
              principles = rule.principles;
            }
          }
        } catch {
          warning = 'The bridge is unreachable; fell back to keyword scoring for playbook.';
        }
      }
      sendJson(res, 200, {
        ok: true,
        playbook,
        role,
        principles,
        ambiguous: detailed.ambiguous,
        confidence: detailed.confidence,
        candidates: detailed.candidates,
        semanticScore,
        warning
      });
      return;
    }

    // --- optimize a prompt ------------------------------------------------
    // One model call that rewrites a raw request into a task prompt. Nothing
    // runs and nothing is stored: the text goes back to the composer to review.
    if (path === '/api/optimize' && method === 'POST') {
      if (typeof zstack.optimizePrompt !== 'function') {
        fail(res, 503, 'This server cannot optimize prompts.');
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      const problems = validateOptimizeRequest(body);
      if (problems.length > 0) {
        fail(res, 400, problems.join(' '), { problems });
        return;
      }
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const result = await zstack.optimizePrompt({
          prompt: String(body.prompt).trim(),
          playbook: typeof body.playbook === 'string' && body.playbook !== '' ? body.playbook : undefined,
          lane: typeof body.lane === 'string' && body.lane !== '' ? body.lane : undefined,
          signal: controller.signal
        });
        sendJson(res, 200, {
          ok: true,
          prompt: result.prompt,
          original: result.original ?? String(body.prompt).trim(),
          model: result.model,
          playbook: result.playbook ?? null,
          principles: result.principles ?? [],
          durationMs: result.durationMs ?? null
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        const kind = err?.kind || null;
        if (kind === 'unreachable' && typeof zstack.classifyPromptDetailed === 'function') {
          const detailed = zstack.classifyPromptDetailed(String(body.prompt).trim());
          sendJson(res, 200, {
            ok: true,
            prompt: String(body.prompt).trim(),
            original: String(body.prompt).trim(),
            model: null,
            playbook: detailed.type,
            principles: detailed.principles,
            warning: 'The bridge is unreachable; prompt optimization skipped and playbook matched by keyword scoring.',
            unreachable: true
          });
          return;
        }
        const status = kind === 'timeout'
          ? 504
          : kind === 'unreachable' || kind === 'http' || kind === 'parse'
            ? 502
            : 500;
        fail(res, status, err?.message || String(err), kind ? { kind } : {});
      }
      return;
    }

    // --- chats ------------------------------------------------------------
    // A chat is a persisted conversation, not a run: no workspace, no playbook,
    // no tool loop, no history record. It lives on the server so it survives a
    // browser, and so the reply a turn streams is stored even if the reader
    // navigates away before it finishes.
    if (path === '/api/chats' && method === 'GET') {
      const { chats, corrupted, path: file } = readChats(chatsFile);
      const summaries = chats
        .map(chatSummary)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      sendJson(res, 200, {
        ok: true,
        chats: summaries,
        path: file,
        corrupted: corrupted || undefined
      });
      return;
    }

    if (path === '/api/chats' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      try {
        const record = createChat(body, chatsFile);
        sendJson(res, 201, { ok: true, id: record.id, chat: projectChat(record) });
      } catch (err) {
        fail(res, err.kind === 'invalid-chat' ? 400 : 500, err.message, { problems: err.problems });
      }
      return;
    }

    // --- one chat turn, streamed ------------------------------------------
    // The reply is written back to the chat as it settles, so persistence and
    // the live stream are the same event rather than two that can disagree.
    // Only one turn per chat is allowed at a time; its deltas are SSE frames.
    const chatMessageMatch = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (chatMessageMatch) {
      if (method !== 'POST') {
        fail(res, 405, `${method} is not allowed for ${path}.`);
        return;
      }
      const id = decodeURIComponent(chatMessageMatch[1]);
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      const problems = validateChatMessage(body.text);
      if (problems.length > 0) {
        fail(res, 400, problems.join(' '), { problems });
        return;
      }
      const chat = findChat(id, chatsFile);
      if (!chat) {
        fail(res, 404, `No chat with id ${id}.`);
        return;
      }
      if (!chat.model) {
        fail(res, 400, 'Pin a model before sending a message.', {
          problems: ['Pin a model before sending a message.']
        });
        return;
      }
      if (busyChats.has(id)) {
        fail(res, 409, 'This chat already has a turn in flight. Wait for it to finish.');
        return;
      }
      // The turn writes two messages. Refuse before starting when there is not
      // room for both, or the reply would be lost after the model spent tokens.
      if (chat.messages.length + 2 > CHAT_MAX_MESSAGES) {
        fail(res, 400, `This chat is full at ${CHAT_MAX_MESSAGES} messages. Start a new one.`, {
          problems: [`This chat is full at ${CHAT_MAX_MESSAGES} messages.`]
        });
        return;
      }
      let stored;
      try {
        stored = appendMessage(id, { id: newMessageId(), role: 'user', content: String(body.text).trim() }, chatsFile);
      } catch (err) {
        fail(res, err.kind === 'invalid-chat' ? 400 : 500, err.message, { problems: err.problems });
        return;
      }
      busyChats.add(id);
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      const frame = (event, data) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const userMessage = stored.messages[stored.messages.length - 1];
      const assistantId = newMessageId();
      // The transcript sent to the model drops any empty body, which a stopped
      // turn can leave behind: an empty assistant turn is not a message.
      const history = chatWireMessages(stored.messages.filter((m) => m.content.trim() !== ''));
      frame('start', {
        chatId: id,
        model: chat.model,
        userMessage,
        assistant: { id: assistantId, role: 'assistant', at: new Date().toISOString() }
      });
      let content = '';
      try {
        const result = await zstack.chat({
          model: chat.model,
          messages: history,
          sessionId: chat.sessionId,
          signal: controller.signal,
          onDelta: (text) => {
            content += text;
            frame('delta', { text });
          }
        });
        const saved = appendMessage(id, {
          id: assistantId,
          role: 'assistant',
          content: result.content || content,
          model: result.model,
          tokens: result.usage?.total_tokens,
          durationMs: result.durationMs
        }, chatsFile);
        frame('done', { message: saved.messages[saved.messages.length - 1] });
      } catch (err) {
        // The reply is persisted even when it failed, with whatever streamed
        // before the failure, so a reload shows what actually happened. A
        // reader who already disconnected gets no frame; there is nobody there.
        try {
          appendMessage(id, {
            id: assistantId,
            role: 'assistant',
            content,
            error: err?.message || String(err)
          }, chatsFile);
        } catch {
          // A full chat at the last boundary loses the partial reply; the live
          // reader is still told why it stopped.
        }
        if (!controller.signal.aborted) {
          frame('error', { error: err?.message || String(err), kind: err?.kind || null });
        }
      } finally {
        busyChats.delete(id);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // --- one chat ---------------------------------------------------------
    const chatMatch = path.match(/^\/api\/chats\/([^/]+)$/);
    if (chatMatch) {
      const id = decodeURIComponent(chatMatch[1]);
      if (method === 'GET') {
        const chat = findChat(id, chatsFile);
        if (!chat) {
          fail(res, 404, `No chat with id ${id}.`);
          return;
        }
        sendJson(res, 200, { ok: true, chat: projectChat(chat) });
        return;
      }
      if (method === 'PATCH') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          fail(res, err.status || 400, err.message);
          return;
        }
        try {
          const record = updateChat(id, body, chatsFile);
          sendJson(res, 200, { ok: true, chat: projectChat(record) });
        } catch (err) {
          if (err.kind === 'unknown-chat') fail(res, 404, err.message);
          else fail(res, err.kind === 'invalid-chat' ? 400 : 500, err.message, { problems: err.problems });
        }
        return;
      }
      if (method === 'DELETE') {
        if (busyChats.has(id)) {
          fail(res, 409, 'This chat has a turn in flight. Stop it before deleting.');
          return;
        }
        try {
          deleteChat(id, chatsFile);
          sendJson(res, 200, { ok: true, deleted: id });
        } catch (err) {
          fail(res, err.kind === 'unknown-chat' ? 404 : 500, err.message);
        }
        return;
      }
      fail(res, 405, `${method} is not allowed for ${path}. Allowed: GET, PATCH, DELETE.`);
      return;
    }

    // --- schedules list and create -----------------------------------------
    if (path === '/api/schedules') {
      if (method === 'GET') {
        const { schedules } = readSchedules(schedulesFile);
        sendJson(res, 200, { ok: true, schedules });
        return;
      }
      if (method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          fail(res, err.status || 400, err.message);
          return;
        }
        try {
          if (body.projectId || body.project) {
            const pid = (body.projectId || body.project).trim();
            const proj = findProject(pid, projectsFile);
            if (!proj) {
              fail(res, 404, `No project with id "${pid}".`, { problems: [`No project with id "${pid}".`] });
              return;
            }
          }
          const schedule = createSchedule(body, schedulesFile);
          sendJson(res, 201, { ok: true, schedule });
        } catch (err) {
          fail(res, 400, err.message, { problems: err.problems || [err.message] });
        }
        return;
      }
    }

    // --- infer schedule from prompt ----------------------------------------
    if (path === '/api/schedules/infer' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      if (!body.prompt || typeof body.prompt !== 'string') {
        fail(res, 400, 'Prompt must be a non-empty string.');
        return;
      }
      const inferred = inferScheduleFromText(body.prompt);
      sendJson(res, 200, { ok: true, inferred });
      return;
    }

    // --- trigger single schedule immediately ------------------------------
    const scheduleRunMatch = path.match(/^\/api\/schedules\/([^/]+)\/run$/);
    if (scheduleRunMatch) {
      if (method !== 'POST') {
        fail(res, 405, `${method} is not allowed for ${path}. Allowed: POST.`);
        return;
      }
      const id = decodeURIComponent(scheduleRunMatch[1]);
      const sched = findSchedule(id, schedulesFile);
      if (!sched) {
        fail(res, 404, `No schedule with id "${id}".`);
        return;
      }
      const outcome = await scheduler.triggerSchedule(sched);
      if (outcome.ok) {
        sendJson(res, 200, { ok: true, ...outcome });
      } else {
        const status = outcome.status === 'skipped-busy' ? 409 : 500;
        fail(res, status, outcome.error || 'Failed to trigger schedule.', outcome);
      }
      return;
    }

    // --- single schedule: get, patch, delete -------------------------------
    const scheduleMatch = path.match(/^\/api\/schedules\/([^/]+)$/);
    if (scheduleMatch) {
      const id = decodeURIComponent(scheduleMatch[1]);
      if (method === 'GET') {
        const sched = findSchedule(id, schedulesFile);
        if (!sched) {
          fail(res, 404, `No schedule with id "${id}".`);
          return;
        }
        sendJson(res, 200, { ok: true, schedule: sched });
        return;
      }
      if (method === 'PATCH') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          fail(res, err.status || 400, err.message);
          return;
        }
        try {
          if (body.projectId || body.project) {
            const pid = (body.projectId || body.project).trim();
            const proj = findProject(pid, projectsFile);
            if (!proj) {
              fail(res, 404, `No project with id "${pid}".`, { problems: [`No project with id "${pid}".`] });
              return;
            }
          }
          const updated = updateSchedule(id, body, schedulesFile);
          if (!updated) {
            fail(res, 404, `No schedule with id "${id}".`);
            return;
          }
          sendJson(res, 200, { ok: true, schedule: updated });
        } catch (err) {
          fail(res, 400, err.message, { problems: err.problems || [err.message] });
        }
        return;
      }
      if (method === 'DELETE') {
        const deleted = deleteSchedule(id, schedulesFile);
        if (!deleted) {
          fail(res, 404, `No schedule with id "${id}".`);
          return;
        }
        sendJson(res, 200, { ok: true, deleted: id });
        return;
      }
      fail(res, 405, `${method} is not allowed for ${path}. Allowed: GET, PATCH, DELETE.`);
      return;
    }

    // --- workfolk status ----------------------------------------------------
    if (path === '/api/workfolk/status' && method === 'GET') {
      const status = await getWorkfolkStatus();
      sendJson(res, 200, { ok: true, ...status });
      return;
    }

    // --- workfolk workers roster -------------------------------------------
    if (path === '/api/workfolk/workers' && method === 'GET') {
      const includeRetired = url.searchParams.get('includeRetired') === 'true';
      try {
        const workers = await fetchWorkfolkRoster({ includeRetired });
        sendJson(res, 200, { ok: true, workers });
      } catch (err) {
        fail(res, 502, err.message, { detail: 'Could not fetch workers from Workfolk gateway.' });
      }
      return;
    }

    // --- workfolk task dispatch --------------------------------------------
    if (path === '/api/workfolk/dispatch' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        fail(res, err.status || 400, err.message);
        return;
      }
      const tag = body.worker_tag || body.tag || body.worker;
      const task = body.task;
      if (!tag || typeof tag !== 'string' || !tag.trim()) {
        fail(res, 400, 'worker_tag is required.');
        return;
      }
      if (!task || typeof task !== 'string' || !task.trim()) {
        fail(res, 400, 'task is required.');
        return;
      }
      try {
        const dispatchResult = await dispatchWorkfolkTask(tag, task);
        if (body.wait === true) {
          const timeoutMs = Number(body.timeoutMs) || 60000;
          const intervalMs = body.intervalMs ? Number(body.intervalMs) : undefined;
          const finished = await pollWorkfolkJob(dispatchResult.job_id, { timeoutMs, intervalMs });
          sendJson(res, 200, { ok: true, ...finished });
          return;
        }
        sendJson(res, 202, { ok: true, ...dispatchResult });
      } catch (err) {
        const status = err.status || (err.message.includes('token') ? 401 : 502);
        fail(res, status, err.message);
      }
      return;
    }

    // --- workfolk job status -----------------------------------------------
    const workfolkJobMatch = path.match(/^\/api\/workfolk\/jobs\/([^/]+)$/);
    if (workfolkJobMatch) {
      if (method !== 'GET') {
        fail(res, 405, `${method} is not allowed for ${path}. Allowed: GET.`);
        return;
      }
      const jobId = decodeURIComponent(workfolkJobMatch[1]);
      try {
        const job = await getWorkfolkJobStatus(jobId);
        sendJson(res, 200, { ok: true, ...job });
      } catch (err) {
        const status = err.status || 502;
        fail(res, status, err.message);
      }
      return;
    }

    fail(res, 404, `No such endpoint: ${method} ${path}`);
  };

  return { handler, registry, zstack, scheduler, historyPath: historyFile, projectsPath: projectsFile, overridesPath: overridesFile, chatsPath: chatsFile, schedulesPath: schedulesFile, githubPath: githubFile };
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
  if (options.enableScheduler !== false) {
    app.scheduler.start();
  }
  const server = createServer((req, res) => {
    app.handler(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      fail(res, 500, err?.message || String(err));
    });
  });

  server.on('close', () => {
    app.scheduler.stop();
    app.registry.shutdown();
  });

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
