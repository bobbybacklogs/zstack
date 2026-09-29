/**
 * Live runs, and the one path that starts and records them.
 *
 * A run started here and a run started by `zstack` on the command line must be
 * the same thing afterwards. The CLI records history inside `recordRun`, a
 * private helper in `bin/zstack.mjs`, and `z.agent()` does not record on its
 * own. So a UI that called the SDK directly would produce runs that work, look
 * right, and never appear in `zstack history`. Recording therefore lives here,
 * behind the registry, so both entry points write through one implementation.
 *
 * Subscribers are served from a numbered event log rather than a live socket
 * alone. A browser that reloads mid-run, or reconnects after a dropped
 * connection, asks for events after the last sequence number it saw and receives
 * exactly what it missed. A stream that only broadcasts to whoever is connected
 * at the time loses the middle of a run on every refresh.
 */

import { ZStack } from './sdk.mjs';
import { appendHistory, newRunId } from './history.mjs';
import {
  createLiveRun,
  applyLiveEvent,
  finishLiveRun,
  liveRunToPage,
  titleFromPrompt
} from './blocks.mjs';

/** How long a finished run stays queryable in memory after it ends. */
const RETAIN_FINISHED_MS = 10 * 60 * 1000;

/** Bound on retained runs, so a long-lived server does not grow without limit. */
const MAX_RETAINED = 50;

/**
 * Approval policies a caller may ask for, and what each passes to the harness.
 *
 * These are the only policies that can be honoured. The harness decides under a
 * non-TTY stdin, where it declines rather than blocking on a question, so
 * per-call approval is not reachable from here. A policy is therefore a
 * run-level decision, and the UI presents it as one.
 */
export const POLICIES = Object.freeze({
  /**
   * The default. The risk classifier approves only the calls it calls safe, so
   * `ls`, `cat`, and `grep` run while a write or a listening port does not.
   */
  'read-only': { apply: false, autoApproveSafe: true, label: 'Read-only' },
  /** Mutating calls run without asking. */
  apply: { apply: true, autoApproveSafe: false, label: 'Apply' },
  /** Nothing is auto-approved, not even a safe read. */
  strict: { apply: false, autoApproveSafe: false, label: 'Strict' }
});

export function isKnownPolicy(name) {
  return Object.prototype.hasOwnProperty.call(POLICIES, name);
}

/**
 * Validate a start request at the boundary.
 *
 * Returns every problem rather than the first, so the HTTP layer can report
 * them in one response instead of one per attempt.
 *
 * There is no `tier` here on purpose. A budget tier is a stored setting that
 * changes which model every role resolves to, and `z.agent()` reads it from
 * storage; there is no per-run tier to pass. Accepting one would be a control
 * that silently does nothing.
 */
export function validateStartRequest(body = {}) {
  const problems = [];
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt === '') problems.push('A run needs a prompt.');
  if (body.lane !== undefined && !['auto', 'zen', 'go', 'hitch'].includes(body.lane)) {
    problems.push(`Unknown lane "${body.lane}". Valid lanes: auto, zen, go, hitch.`);
  }
  if (body.policy !== undefined && !isKnownPolicy(body.policy)) {
    problems.push(`Unknown policy "${body.policy}". Valid policies: ${Object.keys(POLICIES).join(', ')}.`);
  }
  if (body.maxTurns !== undefined) {
    const n = Number(body.maxTurns);
    if (!Number.isInteger(n) || n <= 0) problems.push('maxTurns must be a positive integer.');
  }
  if (body.apply !== undefined && typeof body.apply !== 'boolean') {
    problems.push('apply must be a boolean.');
  }
  if (body.workspaceDir !== undefined && typeof body.workspaceDir !== 'string') {
    problems.push('workspaceDir must be a string.');
  }
  if (body.projectId !== undefined && (typeof body.projectId !== 'string' || body.projectId.trim() === '')) {
    problems.push('projectId must be a non-empty string.');
  }
  return problems;
}

/**
 * The one start request shape the registry accepts.
 *
 * A boolean `apply` is folded into a policy here so the rest of the module has
 * a single representation. Two ways to say the same thing is how a caller ends
 * up believing it asked for apply while the run stayed read-only.
 */
export function normalizeStartRequest(body = {}) {
  const policy = body.policy ?? (body.apply === true ? 'apply' : 'read-only');
  const preset = POLICIES[policy] ?? POLICIES['read-only'];
  const turns = Number(body.maxTurns);
  return {
    prompt: String(body.prompt ?? '').trim(),
    playbook: body.playbook || undefined,
    role: body.role || undefined,
    model: body.model || undefined,
    lane: body.lane || undefined,
    workspaceDir: body.workspaceDir || undefined,
    // Kept verbatim rather than resolved here: the registry does not own the
    // projects file, so it records the id and lets the server resolve the
    // directory before the run starts.
    projectId: typeof body.projectId === 'string' && body.projectId.trim() !== ''
      ? body.projectId.trim()
      : undefined,
    policy,
    apply: preset.apply,
    autoApproveSafe: preset.autoApproveSafe,
    maxTurns: Number.isInteger(turns) && turns > 0 ? turns : undefined,
    review: body.review === true,
    files: Array.isArray(body.files) ? body.files : undefined
  };
}

/** The model's own words, from the blocks already folded into a run. */
export function narrativeOf(live) {
  return live.blocks
    .filter((block) => block.kind === 'prose' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The record written to run history, in the shape the CLI writes.
 *
 * Kept as one function so a UI run and a CLI run are indistinguishable to
 * anything reading `history.jsonl`, including `zstack history --steps`.
 */
export function historyRecordFor(request, result, live) {
  return {
    id: live.id,
    command: 'agent',
    playbook: result.playbook ?? live.playbook,
    role: result.role ?? request.role,
    model: result.model ?? live.model,
    durationMs: result.durationMs ?? (live.endedAt ? live.endedAt - live.startedAt : null),
    usage: result.usage ?? (Number.isFinite(live.tokens) ? { total_tokens: live.tokens } : null),
    contextEstimate: null,
    promptChars: request.prompt.length,
    promptPreview: request.prompt,
    files: request.files || [],
    ok: result.ok !== false && !live.cancelled,
    errorKind: result.errorKind ?? (live.cancelled ? 'cancelled' : null),
    exitCode: live.cancelled ? null : result.exitCode ?? (result.ok === false ? 1 : 0),
    applied: !!request.apply,
    workspace: result.workspaceDir ?? live.workspace,
    // The project this run was started under, when the caller named one. It is
    // stored alongside the workspace so a run stays attached to its project
    // even when the project is later renamed or deleted.
    projectId: request.projectId ?? result.projectId ?? null,
    turns: result.turns ?? live.turns,
    toolCalls: result.toolCalls ?? live.toolCalls,
    failedTools: result.failedTools ?? live.failed,
    declinedTools: result.declinedTools ?? live.declined,
    changes: result.changes ?? [],
    fileChanges: result.fileChanges ?? live.fileChanges,
    steps: result.steps ?? [],
    narrative: result.narrative || narrativeOf(live)
  };
}

export class RunRegistry {
  constructor(options = {}) {
    this.zstack = options.zstack || new ZStack();
    this.historyPath = options.historyPath;
    // Name lookup for live pages. Injected rather than imported because the
    // registry does not own the projects file: the server hands it a function
    // of project id to name, or nothing, in which case live pages carry the
    // id and the page endpoint annotates them.
    this.projectNameFor = options.projectNameFor || null;
    // Override lookup for live pages, same ownership story: the server owns
    // the overrides file and hands the registry a function of run id to
    // override, so a live run renamed mid-flight shows its custom title.
    this.overrideFor = options.overrideFor || null;
    this.retainMs = options.retainMs ?? RETAIN_FINISHED_MS;
    this.maxRetained = options.maxRetained ?? MAX_RETAINED;
    this.runs = new Map();
    this.order = [];
  }

  /** Cards for the runs this process is running or just finished. */
  listLive() {
    return [...this.order]
      .reverse()
      .map((id) => this.runs.get(id))
      .filter(Boolean)
      .map((run) => {
        // A card is a projection, so it gets the same annotations as a page:
        // without this a live run renamed mid-flight keeps its derived title
        // in the list while the page shows the custom one.
        this.#annotateProject(run);
        return liveCard(run);
      });
  }

  get(id) {
    return this.runs.get(id) || null;
  }

  /** The current page for a run, or null when this registry never saw it. */
  getPage(id) {
    const run = this.runs.get(id);
    if (!run) return null;
    // Live state is this registry's to mutate: annotation writes scratch
    // fields onto the run and the projection copies them out, so two
    // projections of the same run cannot disagree.
    this.#annotateProject(run);
    return liveRunToPage(run);
  }

  /**
   * Resolve a run's sidecar state for one projection.
   *
   * Live state is the registry's to reconcile: the request it started with is
   * the base, and the override is a later amendment on top. A move writes a
   * `projectId` into the override, which wins here; a detach writes null,
   * which wins over the request's id rather than falling back to it. A deleted
   * project resolves to no name, and the key stays absent so no stale name
   * survives. The stream's opening page goes through here too, so a subscriber
   * never sees a page the GET endpoint would describe differently.
   *
   * The registry does not own the overrides file — the server does — so both
   * lookups arrive injected. Without an override lookup a renamed live run
   * keeps its derived title until it archives; without a project lookup it
   * keeps its id without a name.
   */
  #annotateProject(run) {
    delete run.projectName;
    delete run.customTitle;
    let projectId = run.projectId ?? run.request?.projectId ?? null;
    if (this.overrideFor && run.id) {
      try {
        const override = this.overrideFor(run.id);
        if (override && typeof override === 'object') {
          if (typeof override.title === 'string' && override.title !== '') {
            run.customTitle = override.title;
          }
          // The override always wins when present, including an explicit
          // null: a move that detached the run must not fall back to the id
          // the request started with.
          if (override.projectId !== undefined) projectId = override.projectId;
        }
      } catch {
        // A lookup that throws must not take down the page it annotates.
      }
    }
    run.projectId = projectId;
    if (this.projectNameFor && projectId) {
      try {
        const name = this.projectNameFor(projectId);
        if (typeof name === 'string' && name !== '') run.projectName = name;
      } catch {
        // Same contract: annotation never faults a page.
      }
    }
  }

  /** Log entries after a sequence number, for a client resuming a stream. */
  replay(id, sinceSeq = 0) {
    const run = this.runs.get(id);
    if (!run) return null;
    return run.log.filter((entry) => entry.seq > sinceSeq);
  }

  subscribe(id, listener) {
    const run = this.runs.get(id);
    if (!run) return null;
    run.subscribers.add(listener);
    return () => run.subscribers.delete(listener);
  }

  /** Publish one log entry and hand it to everyone watching. */
  #emit(run, entry) {
    run.seq += 1;
    const record = { seq: run.seq, at: new Date().toISOString(), ...entry };
    run.log.push(record);
    for (const listener of run.subscribers) {
      try {
        listener(record);
      } catch {
        // A subscriber that throws must not take down the run it is watching.
      }
    }
    return record;
  }

  /**
   * Start a run and return as soon as it has an id.
   *
   * The caller gets the id before the first model call, so the UI can navigate
   * to the page and subscribe while the work is still happening. Failures are
   * folded into the run rather than thrown past this point, because a rejected
   * promise would leave the browser with no page to show.
   */
  start(body = {}) {
    const problems = validateStartRequest(body);
    if (problems.length > 0) {
      const err = new Error(problems.join(' '));
      err.kind = 'invalid-request';
      err.problems = problems;
      throw err;
    }

    const request = normalizeStartRequest(body);
    const id = newRunId();
    // The live object is built with its request attached, because the
    // projection reads the project, policy, and workspace from it. Passing
    // only the prompt left those fields empty on every live page.
    const live = createLiveRun({ id, prompt: request.prompt, ...request });
    live.request = request;
    live.log = [];
    live.seq = 0;
    live.subscribers = new Set();
    live.settled = false;
    live.persisted = false;
    live.cancelled = false;
    live.controller = new AbortController();
    this.runs.set(id, live);
    this.order.push(id);
    this.#prune();

    this.#annotateProject(live);
    this.#emit(live, { type: 'open', page: liveRunToPage(live) });
    this.#execute(live, request).catch(() => {
      // `#execute` handles its own failures; this only keeps a bug in that
      // handling from surfacing as an unhandled rejection.
    });
    return live;
  }

  async #execute(live, request) {
    let result = null;
    try {
      result = await this.zstack.agent({
        prompt: request.prompt,
        playbook: request.playbook,
        role: request.role,
        model: request.model,
        lane: request.lane,
        apply: request.apply,
        autoApproveSafe: request.autoApproveSafe,
        maxTurns: request.maxTurns,
        review: request.review,
        workspaceDir: request.workspaceDir,
        signal: live.controller.signal,
        onEvent: (event) => {
          const changed = applyLiveEvent(live, event);
          if (changed.length > 0) this.#emit(live, { type: 'blocks', items: changed });
          this.#emitStatus(live);
        }
      });
    } catch (err) {
      const changed = finishLiveRun(live, {
        error: err?.message || String(err),
        cancelled: live.cancelled
      });
      if (changed.length > 0) this.#emit(live, { type: 'blocks', items: changed });
      live.persisted = this.#persist(live, request, {
        ok: false,
        exitCode: 1,
        errorKind: err?.kind || 'harness',
        playbook: request.playbook,
        role: request.role
      });
      live.settled = true;
      this.#emitStatus(live);
      this.#emit(live, { type: 'end', status: live.status });
      return;
    }

    const changed = finishLiveRun(live, {
      ok: result.ok,
      exitCode: result.exitCode,
      cancelled: live.cancelled
    });
    if (changed.length > 0) this.#emit(live, { type: 'blocks', items: changed });
    live.persisted = this.#persist(live, request, result);
    live.settled = true;
    this.#emitStatus(live);
    this.#emit(live, { type: 'end', status: live.status });
  }

  #emitStatus(live) {
    this.#emit(live, {
      type: 'status',
      status: live.status,
      tone: live.tone,
      counts: {
        turns: live.turns,
        toolCalls: live.toolCalls,
        failedTools: live.failed,
        declinedTools: live.declined,
        fileChanges: live.fileChanges.length
      },
      endedAt: live.endedAt,
      persisted: live.persisted
    });
  }

  /**
   * Write the run to history, best-effort.
   *
   * Mirrors `recordRun` in the CLI: a run that cannot be recorded still
   * succeeded, so this reports whether it was written rather than failing the
   * run. The UI says so when it was not, because a run missing from history is
   * otherwise a silent loss.
   */
  #persist(live, request, result) {
    try {
      return appendHistory(historyRecordFor(request, result, live), this.historyPath);
    } catch {
      return false;
    }
  }

  /**
   * Ask a run to stop.
   *
   * Signals the harness process rather than dropping the run from memory: the
   * child is killed, the SDK resolves with a non-zero exit, and the run settles
   * through the same path as any other, so it is recorded and its page closes
   * instead of hanging open forever.
   */
  cancel(id) {
    const run = this.runs.get(id);
    if (!run || run.settled) return false;
    run.cancelled = true;
    run.controller.abort();
    return true;
  }

  /** Drop finished runs that have aged out, oldest first. */
  #prune() {
    while (this.order.length > this.maxRetained) {
      const id = this.order[0];
      const run = this.runs.get(id);
      if (run && !run.settled) break;
      this.order.shift();
      this.runs.delete(id);
    }
    const now = Date.now();
    const stale = [];
    for (const [id, run] of this.runs) {
      if (run.settled && run.endedAt && now - run.endedAt > this.retainMs) stale.push(id);
    }
    for (const id of stale) {
      this.runs.delete(id);
      this.order = this.order.filter((x) => x !== id);
    }
  }

  /** Release every subscriber so a shutdown does not hang on open streams. */
  shutdown() {
    for (const run of this.runs.values()) {
      for (const listener of run.subscribers) {
        try {
          listener({ seq: -1, type: 'shutdown' });
        } catch {
          // Nothing left to do for a subscriber that throws on the way out.
        }
      }
      run.subscribers.clear();
      if (!run.settled) run.controller.abort();
    }
  }
}

  /** The list card for a run this process owns. */
function liveCard(run) {
  const customTitle = typeof run.customTitle === 'string' && run.customTitle !== ''
    ? run.customTitle
    : null;
  return {
    id: run.id,
    live: !run.settled,
    title: customTitle ?? titleFromPrompt(run.prompt, 'Agent run'),
    badge: 'agent',
    status: run.status,
    tone: run.tone,
    at: new Date(run.startedAt).toISOString(),
    playbook: run.playbook,
    model: run.model,
    agentic: true,
    applied: !!run.request.apply,
    policy: run.request.policy,
    workspace: run.workspace,
    // Reconciled by the projection step before this card is built, same as
    // the page: reading the request here would report a stale project.
    projectId: run.projectId ?? null,
    turns: run.turns || null,
    toolCalls: run.toolCalls || null,
    fileChangeCount: run.fileChanges.length,
    persisted: run.persisted
  };
}
