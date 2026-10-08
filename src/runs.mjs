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
import { buildProgression } from './harness.mjs';
import { appendHistory, newRunId, checkpointHistory, removeHistoryCheckpoint, recoverHistory, compactSteps, HISTORY_MAX_STEPS } from './history.mjs';
import { continuationBudget, DEFAULT_MAX_TURNS, maxTurnsProblem, resolveMaxTurns, runWithExtensions } from './turns.mjs';
import {
  createLiveRun,
  applyLiveEvent,
  finishLiveRun,
  liveRunToPage,
  titleFromPrompt
} from './blocks.mjs';
import { commitAndPushBranch } from './git.mjs';
import { createPullRequest } from './github.mjs';
import { isKnownLane, normalizeLane, LANES } from './budget.mjs';

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
  // Lane ids come from `LANES`, never a literal list here: a hardcoded copy is
  // how a new lane gets silently rejected with a 400 on one code path while
  // another path accepts it. This also accepts the documented aliases, which
  // the literal list used to turn away (`opencode-go`, `huggingface`).
  if (body.lane !== undefined && !isKnownLane(body.lane)) {
    const valid = Object.keys(LANES).join(', ');
    problems.push(`Unknown lane "${body.lane}". Valid lanes: ${valid}.`);
  }
  if (body.policy !== undefined && !isKnownPolicy(body.policy)) {
    problems.push(`Unknown policy "${body.policy}". Valid policies: ${Object.keys(POLICIES).join(', ')}.`);
  }
  if (body.maxTurns !== undefined) {
    const problem = maxTurnsProblem(body.maxTurns);
    if (problem) problems.push(problem);
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
  if (body.autoPr !== undefined && typeof body.autoPr !== 'boolean') {
    problems.push('autoPr must be a boolean.');
  }
  if (body.pr !== undefined && typeof body.pr !== 'boolean') {
    problems.push('pr must be a boolean.');
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
  const turns = resolveMaxTurns(body.maxTurns);
  return {
    prompt: String(body.prompt ?? '').trim(),
    requester: typeof body.requester === 'string' ? body.requester.trim() || null : null,
    idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() || null : null,
    playbook: body.playbook || undefined,
    role: body.role || undefined,
    model: body.model || undefined,
    // Normalized here so a run records `hf`, not whichever alias the caller
    // used, and the record agrees with what the budget file stores.
    lane: body.lane ? normalizeLane(body.lane) : undefined,
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
    autoPr: body.autoPr === true || body.pr === true,
    // Always explicit, never left to the harness. Its own default is 8 turns,
    // which is too tight to finish real work, and sending a number zstack chose
    // is what lets a run report its budget accurately and be continued when it
    // reaches it.
    maxTurns: turns ?? DEFAULT_MAX_TURNS,
    // The session to continue. A resumed run keeps the original prompt as its
    // record but sends this instruction to the harness, which restores the
    // prior history from it.
    resume: typeof body.resume === 'string' && body.resume.trim() !== ''
      ? body.resume.trim()
      : undefined,
    continuationOf: typeof body.continuationOf === 'string' && body.continuationOf.trim() !== ''
      ? body.continuationOf.trim()
      : undefined,
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
    requester: request.requester ?? null,
    idempotencyKey: request.idempotencyKey ?? null,
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
    // Why a failed run failed, in the harness's own words. Recorded because the
    // live page is pruned from memory on a timer while the record is what a
    // reader returns to: a stored run that can only say "exited with code 1"
    // throws away the explanation that was available when it happened.
    error: live.error ?? result.errorText ?? null,
    errorKind: result.errorKind ?? (live.cancelled ? 'cancelled' : null),
    exitCode: live.cancelled ? null : result.exitCode ?? (result.ok === false ? 1 : 0),
    applied: !!request.apply,
    // Stored so a continuation can re-apply the same policy. Without it a
    // continued run of a write-enabled run would silently fall back to
    // read-only and report the work as declined.
    policy: request.policy ?? null,
    workspace: result.workspaceDir ?? live.workspace,
    // The project this run was started under, when the caller named one. It is
    // stored alongside the workspace so a run stays attached to its project
    // even when the project is later renamed or deleted.
    projectId: request.projectId ?? result.projectId ?? null,
    // Cumulative, not the last segment's: after an extension the final result
    // reports only the turns that segment used, so trusting it would describe a
    // 100-turn run as the 50 turns of its last leg.
    turns: live.turns || result.turns,
    // The budget, whether it ran out, and the session that can continue it.
    // Stored so the question "this stopped early, can I get more?" is
    // answerable from history alone, long after the process that ran it is
    // gone and its in-memory record has been pruned.
    maxTurns: request.maxTurns ?? result.maxTurns ?? null,
    turnLimitReached: live.turnLimitReached === true || result.turnLimitReached === true || undefined,
    // How many times the run was extended, so a record with a budget larger
    // than the one requested explains itself.
    extensions: live.extensions || undefined,
    paused: live.paused === true || undefined,
    sessionId: result.sessionId ?? live.sessionId ?? null,
    continuationOf: request.continuationOf ?? null,
    toolCalls: result.toolCalls ?? live.toolCalls,
    failedTools: result.failedTools ?? live.failed,
    declinedTools: result.declinedTools ?? live.declined,
    changes: result.changes ?? [],
    fileChanges: result.fileChanges ?? live.fileChanges,
    steps: result.steps?.length ? result.steps : (live.historySteps ?? []),
    narrative: result.narrative || narrativeOf(live),
    autoPr: !!request.autoPr,
    prUrl: result.prUrl ?? live.prUrl ?? null
  };
}

/** Collect bounded progression even when the harness never returns a result. */
export function collectHistoryEvent(live, event) {
  if (event.type === 'done' && event.sessionId) live.sessionId = event.sessionId;
  const steps = buildProgression([{ ...event,
    turn: event.turn == null ? event.turn : event.turn + (live.turnOffset || 0) }]).steps;
  if (live.historySteps.length <= HISTORY_MAX_STEPS) {
    live.historySteps.push(...compactSteps(steps.filter((s) => s.kind !== 'start' || live.historySteps.length === 0)));
  }
}

export class RunRegistry {
  constructor(options = {}) {
    this.zstack = options.zstack || new ZStack();
    this.historyPath = options.historyPath;
    recoverHistory(this.historyPath);
    // Name lookup for live pages. Injected rather than imported because the
    // registry does not own the projects file: the server hands it a function
    // of project id to name, or nothing, in which case live pages carry the
    // id and the page endpoint annotates them.
    this.projectNameFor = options.projectNameFor || null;
    // Override lookup for live pages, same ownership story: the server owns
    // the overrides file and hands the registry a function of run id to
    // override, so a live run renamed mid-flight shows its custom title.
    this.overrideFor = options.overrideFor || null;
    this.gitExecFile = options.gitExecFile;
    this.githubFetch = options.githubFetch;
    this.retainMs = options.retainMs ?? RETAIN_FINISHED_MS;
    this.maxRetained = options.maxRetained ?? MAX_RETAINED;
    this.runs = new Map();
    this.order = [];
    this.closed = false;
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

  /**
   * Start a run that continues an earlier one with a bigger turn budget.
   *
   * The earlier run is not modified: it stopped where it stopped, and that is
   * what happened. The continuation is a new run with its own id, a fresh
   * budget, and the previous session's history restored by the harness. It
   * carries the original project, policy, and playbook so it lands in the same
   * place, and records `continuationOf` so the two are linked afterwards.
   *
   * The prompt is the caller's, defaulting to an instruction to carry on. It is
   * not the original prompt: the harness has the original in the session it is
   * restoring, and repeating it would ask the model to start over.
   *
   * @param {object} previous  a live run or an archived history record
   * @param {object} options   `maxTurns` for the new budget, `prompt` to steer it
   */
  continueRun(previous, options = {}) {
    if (!previous) {
      const err = new Error('No run to continue.');
      err.kind = 'unknown-run';
      throw err;
    }
    if (!previous.sessionId) {
      // Rerunning a run that cannot be resumed would silently start the task
      // over under a "continue" label, which is a worse lie than refusing.
      const err = new Error(
        'This run has no saved session, so it cannot be continued. Start a new run instead.'
      );
      err.kind = 'not-resumable';
      throw err;
    }
    const problem = options.maxTurns === undefined ? null : maxTurnsProblem(options.maxTurns);
    if (problem) {
      const err = new Error(problem);
      err.kind = 'invalid-request';
      err.problems = [problem];
      throw err;
    }
    const turns = resolveMaxTurns(options.maxTurns) ?? continuationBudget(previous.maxTurns);

    return this.start({
      prompt: typeof options.prompt === 'string' && options.prompt.trim() !== ''
        ? options.prompt.trim()
        : `Carry on from where the previous run stopped. It used its ${previous.maxTurns || 'whole'} turn budget partway through the task; finish it.`,
      playbook: previous.playbook,
      role: previous.role ?? undefined,
      model: previous.model ?? undefined,
      policy: previous.policy ?? undefined,
      // The project, not the workspace path: the server resolves the directory
      // from the stored project, and passing both is a contradiction it faults.
      projectId: previous.projectId ?? undefined,
      workspaceDir: previous.projectId ? undefined : (previous.workspace ?? undefined),
      maxTurns: turns,
      resume: previous.sessionId,
      continuationOf: previous.id
    });
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
  start(body = {}, admission = {}) {
    if (this.closed) throw new Error('The run registry is shutting down.');
    const problems = validateStartRequest(body);
    if (problems.length > 0) {
      const err = new Error(problems.join(' '));
      err.kind = 'invalid-request';
      err.problems = problems;
      throw err;
    }

    const request = normalizeStartRequest(body);
    const id = admission.id || newRunId();
    // The live object is built with its request attached, because the
    // projection reads the project, policy, and workspace from it. Passing
    // only the prompt left those fields empty on every live page.
    const live = createLiveRun({ id, prompt: request.prompt, ...request });
    live.request = request;
    live.log = [];
    live.historySteps = [];
    live.seq = 0;
    live.subscribers = new Set();
    live.settled = false;
    live.persisted = false;
    live.cancelled = false;
    live.pauseRequested = false;
    live.paused = false;
    live.controller = new AbortController();
    this.runs.set(id, live);
    this.order.push(id);
    this.#prune();

    this.#annotateProject(live);
    this.#checkpoint(live);
    this.#emit(live, { type: 'open', page: liveRunToPage(live) });
    this.#execute(live, request).catch(() => {
      // `#execute` handles its own failures; this only keeps a bug in that
      // handling from surfacing as an unhandled rejection.
    });
    return live;
  }

  /**
   * Run the task, extending the budget while it needs more.
   *
   * A run that reaches its turn budget has not finished, it has run out, and
   * stopping there throws away the model's whole working state mid-task. So the
   * budget grows instead: the harness session is resumed with more turns and
   * the run carries on inside the *same* run — one id, one page, one growing
   * body. The reader chose a size of job, not a place to be interrupted.
   *
   * Extension is bounded. `nextExtension` trims each grant to what is left
   * under the total ceiling, so the loop always terminates: without that, a task
   * the model cannot finish would double forever on a budget nobody agreed to.
   */
  async #execute(live, request) {
    let result = null;
    let outcome = null;
    // Where this leg starts. A run can be executed more than once — a pause ends
    // one leg and a resume begins another — and each leg's harness call numbers
    // its turns, tokens, and clock from zero. The offsets are what make the run
    // report its whole life rather than its latest leg.
    const turnsBefore = live.turns || 0;
    live.turnOffset = turnsBefore;
    live.tokenOffset = live.tokens || 0;
    live.durationOffset = live.durationMs || 0;
    try {
      outcome = await runWithExtensions({
        maxTurns: request.maxTurns,
        resume: request.resume ?? null,
        call: ({ maxTurns, resume }) => this.zstack.agent({
          prompt: request.prompt,
          playbook: request.playbook,
          role: request.role,
          model: request.model,
          lane: request.lane,
          apply: request.apply,
          autoApproveSafe: request.autoApproveSafe,
          maxTurns,
          review: request.review,
          workspaceDir: request.workspaceDir,
          // Resuming restores the harness session's history, so the next turn
          // picks up mid-task instead of starting over from the same prompt.
          resume,
          saveSession: true,
          signal: live.controller.signal,
          onEvent: (event) => {
            const changed = applyLiveEvent(live, event);
            collectHistoryEvent(live, event);
            this.#checkpoint(live);
            if (changed.length > 0) this.#emit(live, { type: 'blocks', items: changed });
            this.#emitStatus(live);
          }
        }),
        // A stop beats everything: the reader asked for it to end.
        shouldStop: () => live.cancelled,
        // A pause is honoured between turns, which is the only place it can be
        // without killing a process mid-call and losing the session.
        shouldPause: () => live.pauseRequested === true,
        onExtend: () => {
          // The next turn numbers itself from 1, so the run's counter, token
          // total, and clock all have to carry forward rather than restart.
          live.turnOffset = live.turns;
          live.tokenOffset = live.tokens || 0;
          live.durationOffset = live.durationMs || 0;
          live.extensions += 1;
          live.turnLimitReached = false;
          if (live.status !== 'running') {
            live.status = 'running';
            live.tone = 'running';
          }
          // No divider is pushed here. The resumed turn emits its own turn
          // event, and the offset above makes it print the right number, so
          // adding one would label every turn twice.
          this.#emitStatus(live);
        }      });
      result = outcome.result;
      live.paused = outcome.paused === true;
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
      cancelled: live.cancelled,
      paused: outcome?.paused === true,
      // The harness's own words for the failure, when it gave any. Without this
      // a run that never reached its first turn — an expired key, a provider
      // that rejected the request — could only be described by its exit code,
      // which is the one thing a reader already knows.
      error: result.errorText ?? null
    });
    if (changed.length > 0) this.#emit(live, { type: 'blocks', items: changed });
    // Recorded before the projection so the page can say whether the run ran
    // out of budget, and offer to continue it from the session it saved.
    live.sessionId = result.sessionId ?? live.sessionId ?? null;
    // The size the reader picked, not the sum of turns taken: with a turn per
    // call the two are the same number, and the record would lose the only
    // thing it knows about what the reader asked for.
    live.maxTurns = request.maxTurns;
    // The loop's tally is per leg, so the turns taken before this leg are added
    // back: a resumed run reports its whole life, not the leg just finished.
    live.turns = Math.max(live.turns, turnsBefore + (outcome?.used ?? 0));
    // Reached only when the loop stopped with the model still working and no
    // budget left to give, which is the honest meaning of the flag: the budget
    // is not the thing that ended this run, the ceiling is.
    live.turnLimitReached = outcome?.ceilingHit === true;
    if (request.autoPr && result.ok && request.apply && !live.cancelled) {
      const hasChanges = (live.fileChanges && live.fileChanges.length > 0) || (result.changes && result.changes.length > 0);
      if (hasChanges) {
        try {
          const prDoc = await this.#createPrForRun(live, request, result);
          if (prDoc?.url) {
            live.prUrl = prDoc.url;
            result.prUrl = prDoc.url;
            const block = {
              kind: 'notice',
              tone: 'ok',
              text: `Pull request opened: ${prDoc.url}`
            };
            live.blocks.push(block);
            this.#emit(live, { type: 'blocks', items: [{ index: live.blocks.length - 1, block }] });
          }
        } catch (err) {
          live.prError = err.message;
          const block = {
            kind: 'notice',
            tone: 'warning',
            text: `Auto-PR could not be created: ${err.message}`
          };
          live.blocks.push(block);
          this.#emit(live, { type: 'blocks', items: [{ index: live.blocks.length - 1, block }] });
        }
      } else {
        const block = {
          kind: 'notice',
          tone: 'neutral',
          text: 'Auto-PR skipped: run made no file changes.'
        };
        live.blocks.push(block);
        this.#emit(live, { type: 'blocks', items: [{ index: live.blocks.length - 1, block }] });
      }
    }
    live.persisted = this.#persist(live, request, result);
    live.settled = true;
    this.#emitStatus(live);
    this.#emit(live, { type: 'end', status: live.status });
  }

  async #createPrForRun(live, request, result) {
    const workspaceDir = result.workspaceDir ?? live.workspace ?? process.cwd();
    const branchSlug = (request.prompt || 'feature')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 24)
      .replace(/^-+|-+$/g, '') || 'feature';
    const branchName = `zstack/${branchSlug}-${live.id.replace(/^r-/, '')}`;
    const message = `zstack: ${titleFromPrompt(request.prompt, 'automated run updates')}`;

    await commitAndPushBranch(workspaceDir, {
      branch: branchName,
      message
    }, {
      execFileImpl: this.gitExecFile
    });

    const prTitle = `zstack: ${titleFromPrompt(request.prompt, 'Feature updates')}`;
    const fileList = (live.fileChanges && live.fileChanges.length > 0)
      ? live.fileChanges.map((f) => `- \`${typeof f === 'string' ? f : f.path}\``).join('\n')
      : (result.changes && result.changes.length > 0)
        ? result.changes.map((f) => `- \`${typeof f === 'string' ? f : f.path || f}\``).join('\n')
        : '- File changes recorded by run';
    const summaryText = narrativeOf(live) || request.prompt;
    const prBody = [
      '## Summary',
      summaryText,
      '',
      '## Changes',
      fileList,
      '',
      '---',
      `*Created automatically by zstack run ${live.id}*`
    ].join('\n');

    return await createPullRequest({
      dir: workspaceDir,
      title: prTitle,
      body: prBody,
      head: branchName,
      execFileImpl: this.gitExecFile,
      fetchImpl: this.githubFetch
    });
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
      // The budget travels with the status because it changes mid-run: the turn
      // count passes the size the reader picked, and a paused run becomes
      // resumable. A client that only learned the budget when the page loaded
      // would show stale numbers in both cases.
      //
      // The size comes from the request, which is the one authority for what
      // the reader asked for. Reading the turns taken instead reported "7 of 7"
      // — the run's own progress presented as its budget.
      turnBudget: {
        maxTurns: live.request?.maxTurns ?? live.maxTurns ?? null,
        used: live.turns,
        extensions: live.extensions,
        limitReached: live.turnLimitReached === true,
        paused: live.paused === true,
        sessionId: live.sessionId,
        // Resuming a pause continues the run this process is holding, so a live
        // paused run is always resumable in place. Carried here and not only on
        // the page projection, because the client takes this payload as the
        // current truth: leaving it out made every status event downgrade the
        // Resume button to the restart fallback.
        inPlace: live.paused === true && typeof live.sessionId === 'string' && live.sessionId !== '',
        canContinue: typeof live.sessionId === 'string' && live.sessionId !== ''
          && (live.paused === true || live.turnLimitReached === true)
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
      const saved = appendHistory(historyRecordFor(request, result, live), this.historyPath);
      if (saved) removeHistoryCheckpoint(live.id, this.historyPath);
      return saved;
    } catch {
      return false;
    }
  }

  #checkpoint(live) {
    return checkpointHistory({ ...historyRecordFor(live.request, {}, live),
      ok: false, durationMs: Date.now() - live.startedAt, exitCode: null, errorKind: 'interrupted',
      error: 'The run stopped before finishing; this is its saved progress.' }, this.historyPath);
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

  /**
   * Ask a run to pause.
   *
   * A request, not an action: nothing is killed, so the turn in flight finishes
   * and the harness saves its session the way it does at any budget boundary.
   * That is the whole reason pause is possible at all — the session is written
   * when the harness loop ends cleanly, so a pause that killed the process
   * would leave nothing to resume from, which is exactly what stop does.
   *
   * A settled run cannot be paused: there is no loop left to interrupt. That is
   * reported rather than silently succeeding, because a control that claims to
   * have paused a finished run is a control that lies.
   */
  pause(id) {
    const run = this.runs.get(id);
    if (!run || run.settled) return false;
    run.pauseRequested = true;
    return true;
  }

  /**
   * Continue a paused run from where it stopped.
   *
   * The same run, not a new one: it keeps its id, its page, and its body, and
   * the work continues underneath what already happened. The harness session is
   * resumed, so the model gets its history back rather than the original prompt.
   *
   * Only a paused run resumes. A finished run has nothing to continue, and a
   * running one is already going.
   */
  resume(id) {
    if (this.closed) throw new Error('The run registry is shutting down.');
    const run = this.runs.get(id);
    if (!run) {
      const err = new Error(`No run with id ${id} is running in this process.`);
      err.kind = 'unknown-run';
      throw err;
    }
    if (!run.paused) {
      const err = new Error(
        run.settled
          ? 'This run is not paused, so there is nothing to resume. A run that finished or was stopped cannot be picked up here.'
          : 'This run is already going.'
      );
      err.kind = 'not-paused';
      throw err;
    }
    if (!run.sessionId) {
      const err = new Error('This run has no saved session, so it cannot be resumed.');
      err.kind = 'not-resumable';
      throw err;
    }
    // A fresh controller: the previous one was aborted or is spent, and
    // reusing it would hand the harness a signal that is already cancelled.
    run.controller = new AbortController();
    run.pauseRequested = false;
    run.paused = false;
    run.doneSeen = false;
    run.endedAt = null;
    run.error = null;
    run.status = 'running';
    run.tone = 'running';
    run.settled = false;
    const request = { ...run.request, resume: run.sessionId };
    // A subscriber that connected while the run was paused gets the amended
    // page rather than the deltas indexed against a body it never saw.
    this.#emit(run, { type: 'open', page: liveRunToPage(run) });
    this.#emitStatus(run);
    this.#execute(run, request).catch(() => {
      // `#execute` handles its own failures.
    });
    return run;
  }

  /** Whether a run is paused and can therefore be resumed. */
  canResume(id) {
    const run = this.runs.get(id);
    return !!(run && run.paused && run.sessionId && run.settled);
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
    this.closed = true;
    for (const run of this.runs.values()) {
      for (const listener of run.subscribers) {
        try {
          listener({ seq: -1, type: 'shutdown' });
        } catch {
          // Nothing left to do for a subscriber that throws on the way out.
        }
      }
      run.subscribers.clear();
      if (!run.settled) {
        // Shutdown may exit before the aborted SDK promise settles.
        run.persisted = this.#persist(run, run.request, {
          ok: false, errorKind: 'interrupted',
          errorText: 'The zstack server shut down before this run finished.'
        });
        run.controller.abort();
      }
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
    autoPr: !!run.request?.autoPr,
    prUrl: run.prUrl ?? null,
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
