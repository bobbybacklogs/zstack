/**
 * Runs as pages, harness events as blocks.
 *
 * The UI shows a run the way a document app shows a page: metadata at the top,
 * an ordered body below. That is not decoration here. zstack already stores a
 * run as a stable record plus an ordered progression, so the page is a
 * projection of data that exists, not a new model invented for a screen.
 *
 * The load-bearing part is that one renderer serves two sources. An archived
 * run is projected from its history record; a live run is projected from the
 * harness event stream as it arrives. Both produce the same block shapes, so
 * the page you watch during a run is the page you open tomorrow. If those two
 * paths diverged, "live view" and "history view" would be two features that
 * disagree, which is the failure this module exists to prevent.
 *
 * Every block is a tagged union: `kind` decides which other fields exist. A
 * prose block has no outcome and a tool block has no streaming flag, so a
 * renderer cannot read a field the block cannot carry.
 *
 * Which tools change files, how a tool call is summarized, and which argument
 * names a path are all asked of `harness.mjs` rather than restated here. Those
 * answers belong to the harness, and a second copy would drift the first time
 * it learns a new writer tool.
 */

import { WRITER_TOOL_NAMES, mutationPath, summarizeToolCall } from './harness.mjs';

/** Block kinds this module emits. */
export const BLOCK_KINDS = Object.freeze([
  'callout',
  'prose',
  'tool',
  'approval',
  'divider',
  'notice',
  'summary'
]);

/** Longest derived page title before it is cut. */
const TITLE_MAX = 72;

/** Stored progression is capped by history; this mirrors it for the notice. */
const STEP_CAP = 200;

/**
 * Tone for a harness tool outcome.
 *
 * `dry-run` counts as ok because the call succeeded and simply was not applied.
 * `declined` is its own tone rather than an error: the gate refusing a call is
 * the safety default working, and rendering it red would read as a failure.
 */
const OUTCOME_TONE = Object.freeze({
  ok: 'ok',
  'dry-run': 'ok',
  error: 'error',
  timeout: 'warning',
  truncated: 'warning',
  declined: 'declined'
});

export function outcomeTone(outcome) {
  return OUTCOME_TONE[outcome] || 'neutral';
}

/** Collapse whitespace and cut to a page-title length. */
export function titleFromPrompt(text, fallback = 'Untitled run') {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return fallback;
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1)}…`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTokens(usage) {
  const total = usage?.total_tokens;
  return Number.isFinite(total) ? total.toLocaleString('en-US') : null;
}

/**
 * Page properties, in the order a reader wants them.
 *
 * Null-valued properties are dropped rather than rendered as a dash: a
 * single-completion run genuinely has no turn count, and showing an empty
 * field for it implies a number is missing instead of inapplicable.
 */
function propsFrom(record) {
  const entries = [
    ['command', 'Command', record.command],
    ['playbook', 'Playbook', record.playbook],
    ['role', 'Role', record.role],
    ['model', 'Model', record.model],
    ['duration', 'Duration', record.durationText],
    ['tokens', 'Tokens', record.tokensText],
    ['turns', 'Turns', record.turns],
    ['turnBudget', 'Turn budget', record.turnBudgetText],
    ['toolCalls', 'Tool calls', record.toolCalls],
    ['failedTools', 'Failed calls', record.failedTools],
    ['declinedTools', 'Declined calls', record.declinedTools],
    ['policy', 'Policy', record.policy],
    ['workspace', 'Workspace', record.workspace],
    ['files', 'Attached files', record.files?.length ? record.files.join(', ') : null],
    ['promptChars', 'Prompt length', record.promptChars ? `${record.promptChars} chars` : null],
    ['prUrl', 'Pull request', record.prUrl]
  ];
  return entries
    .filter(([, , value]) => value !== null && value !== undefined && value !== '')
    .map(([key, label, value]) => ({ key, label, value: String(value) }));
}

/**
 * The turn budget as one line.
 *
 * A run is driven a turn at a time and continues while it still has work, so
 * the size the reader picked is a starting point rather than a limit. Printing
 * "31 of 8" for a run that outgrew its size would be arithmetic the reader has
 * to interpret; naming what happened is the honest version, and the count is
 * still there for anyone who wants it.
 */
export function turnBudgetText(used, maxTurns, limitReached = false, extensions = 0) {
  const chosen = Number(maxTurns);
  if (!Number.isFinite(chosen) || chosen <= 0) return null;
  const spent = Number(used) || 0;
  if (Number(extensions) > 0 || spent > chosen) {
    if (limitReached) return `${spent} turns, stopped at the ceiling`;
    return `${spent} turns, continued past ${chosen}`;
  }
  return `${spent} of ${chosen}${limitReached ? ' (limit reached)' : ''}`;
}

/**
 * The continuation state of a run, or null when there is nothing to say.
 *
 * `canContinue` is the honest answer to "can I get more of this": it needs a
 * saved session to resume, which only exists for runs started after zstack
 * began passing `--save-session`. An old record has a budget and a turn count
 * but no session, so it reports the budget and offers nothing.
 */
function turnBudgetOf(record) {
  const chosen = Number(record?.maxTurns);
  // No size recorded means nothing to report. The plain turn count is already
  // its own property, and a second line repeating it is noise.
  if (!Number.isFinite(chosen) || chosen <= 0) return null;
  const used = Number(record?.turns) || 0;
  const extensions = Number(record?.extensions) || 0;
  const limitReached = record?.turnLimitReached === true;
  const sessionId = record?.sessionId ?? null;
  const hasSession = typeof sessionId === 'string' && sessionId !== '';
  return {
    maxTurns: chosen,
    used,
    extensions,
    limitReached,
    paused: record?.paused === true,
    sessionId,
    // Whether the *same* run can be picked up again. True only where the run is
    // still held in memory: resuming a pause continues the live run, so a
    // restarted server can offer the session but not the same run.
    inPlace: false,
    // A paused run is the case this exists for: it stopped on purpose with its
    // session saved, so resuming is exactly what the reader wants next. A run
    // that hit the ceiling can also be continued, which is a different reason
    // for the same button.
    canContinue: hasSession && (record?.paused === true || limitReached)
  };
}

/**
 * Status and tone for a completed run.
 *
 * `ok: false` is the run's own verdict. A run that finished but changed nothing
 * is still ok, which is why this does not infer failure from an empty diff.
 *
 * A paused run is neither: it did not fail, and calling it ok would say a task
 * that is sitting half-done is finished. It keeps its own status so a list of
 * runs shows at a glance which one is waiting on you.
 */
function statusFrom(entry) {
  if (entry.paused === true) return { status: 'paused', tone: 'paused' };
  if (entry.errorKind === 'cancelled') return { status: 'cancelled', tone: 'neutral' };
  if (entry.ok === false) return { status: 'failed', tone: 'error' };
  return { status: 'ok', tone: 'ok' };
}

/**
 * A history record as a page.
 *
 * Handles both shapes the file contains: an agentic run carrying a progression,
 * and a single-completion run that carries none. The second case is stated
 * rather than left blank, because an empty body reads as missing data when the
 * truth is that `task` makes one call and cannot act.
 */
export function projectStoredRun(entry) {
  const agentic = entry?.agentic === true;
  const { status, tone } = statusFrom(entry || {});
  const blocks = [];

  const prompt = entry?.promptPreview || '';
  const promptCut = Number(entry?.promptChars || 0) > prompt.length;

  blocks.push({
    kind: 'callout',
    tone: status === 'failed' ? 'error' : 'info',
    text: agentic
      ? `${entry?.applied ? 'Applied' : 'Read-only'} agentic run in ${entry?.workspace || 'an unrecorded workspace'}`
      : 'Single-completion run',
    detail: agentic
      ? 'The harness tool loop executed this task.'
      : 'One model call with no tools. A task cannot read, run, or change anything.'
  });

  if (prompt) {
    blocks.push({ kind: 'prose', label: 'Prompt', text: prompt, streaming: false });
    if (promptCut) {
      blocks.push({
        kind: 'notice',
        tone: 'warning',
        text: `The stored prompt is a ${prompt.length}-character preview of ${entry.promptChars} characters.`
      });
    }
  }

  const steps = Array.isArray(entry?.steps) ? entry.steps : [];
  const startStep = steps.find((s) => s && s.kind === 'start') || null;

  // Why the run failed, stated above the progression: a stored run that can only
  // report its exit code leaves the reader with the one fact they already had.
  // Live runs carry the same text as a notice written at the end of the run.
  if (status === 'failed' && typeof entry?.error === 'string' && entry.error.trim() !== '') {
    blocks.push({ kind: 'notice', tone: 'error', text: entry.error });
  }

  if (agentic && steps.length === 0) {
    blocks.push({ kind: 'notice', tone: 'neutral', text: 'No progression was recorded for this run.' });
  } else if (steps.length > 0) {
    blocks.push({ kind: 'divider', label: 'Recorded progression', tokens: null });
  }

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    switch (step.kind) {
      // The `start` step carries the model and workspace, which the properties
      // panel already shows. It is read for those fallbacks above rather than
      // rendered as a callout that restates the header.
      case 'start':
        break;
      case 'turn':
        blocks.push({
          kind: 'divider',
          label: `Turn ${step.turn ?? '?'}`,
          tokens: Number.isFinite(step.tokens) ? step.tokens.toLocaleString('en-US') : null
        });
        break;
      case 'tool':
        blocks.push({
          kind: 'tool',
          turn: step.turn ?? null,
          name: step.name || 'tool',
          target: step.target || null,
          outcome: step.outcome || 'unknown',
          tone: outcomeTone(step.outcome),
          durationMs: step.durationMs ?? null,
          durationText: formatDuration(step.durationMs),
          // Stored only for failures, and only when it fits the run's budget.
          // Gated on the outcome for the same reason as the live path.
          output: step.outcome !== 'ok' && step.outcome !== 'dry-run'
            && typeof step.output === 'string' && step.output.trim() !== ''
            ? step.output
            : null,
          outputTruncated: step.outputTruncated === true
        });
        break;
      case 'approval':
        blocks.push({
          kind: 'approval',
          tool: step.tool || 'tool',
          decision: step.decision || 'unknown',
          risk: step.risk ?? null,
          tone: step.decision === 'approved' ? 'ok' : step.decision === 'declined' ? 'declined' : 'neutral'
        });
        break;
      default:
        break;
    }
  }

  if (entry?.stepsTruncated) {
    blocks.push({
      kind: 'notice',
      tone: 'warning',
      text: `This run produced more than ${STEP_CAP} steps. Only the first ${STEP_CAP} were stored, so the progression below is partial.`
    });
  }

  if (agentic && Array.isArray(entry?.fileChanges) && entry.fileChanges.length > 0) {
    blocks.push({
      kind: 'summary',
      label: `Changed ${entry.fileChanges.length} file${entry.fileChanges.length === 1 ? '' : 's'}`,
      items: entry.fileChanges.map((c) => ({
        name: c.path,
        detail: `${c.tool}${c.turn != null ? ` on turn ${c.turn}` : ''}`
      }))
    });
  } else if (agentic && entry?.applied) {
    blocks.push({
      kind: 'notice',
      tone: 'neutral',
      text: 'This run was allowed to change files but recorded no attributed file change.'
    });
  }

  // What the model said, last, because it is the payload of the run. Live, each
  // turn's prose sits beside that turn's tool calls; the archive stores the
  // narrative as one transcript, so it cannot be placed turn by turn. The
  // divider says which of the two a reader is looking at.
  if (typeof entry?.narrative === 'string' && entry.narrative.trim() !== '') {
    blocks.push({ kind: 'divider', label: 'Model output', tokens: null });
    blocks.push({ kind: 'prose', label: null, text: entry.narrative, streaming: false });
    if (entry.narrativeTruncated) {
      blocks.push({
        kind: 'notice',
        tone: 'warning',
        text: `The stored model output is cut to its first ${entry.narrative.length} characters.`
      });
    }
  }

  const record = {
    command: entry?.command || 'task',
    playbook: entry?.playbook,
    role: entry?.role,
    model: entry?.model || startStep?.model || null,
    durationText: formatDuration(entry?.durationMs),
    tokensText: formatTokens(entry?.usage),
    turns: entry?.turns ?? null,
    turnBudgetText: turnBudgetText(entry?.turns, entry?.maxTurns, entry?.turnLimitReached === true, entry?.extensions),
    toolCalls: entry?.toolCalls ?? null,
    failedTools: entry?.failedTools ?? null,
    declinedTools: entry?.declinedTools ?? null,
    policy: agentic ? (entry?.policy || (entry?.applied ? 'apply' : 'read-only')) : null,
    workspace: entry?.workspace || startStep?.workspace || null,
    projectId: entry?.projectId ?? null,
    files: entry?.files,
    promptChars: entry?.promptChars,
    prUrl: entry?.prUrl || null
  };

  return {
    id: entry?.id || null,
    live: false,
    // A custom title wins over the derived one. The prompt preview stays in
    // the body regardless, so renaming never destroys the record of what was
    // actually asked.
    title: typeof entry?.customTitle === 'string' && entry.customTitle !== ''
      ? entry.customTitle
      : titleFromPrompt(prompt, `${record.command} run`),
    badge: record.command,
    status,
    tone,
    at: entry?.ts || null,
    projectId: record.projectId,
    workspace: record.workspace,
    prUrl: record.prUrl,
    props: propsFrom(record),
    blocks,
    turnBudget: turnBudgetOf(entry),
    continuationOf: entry?.continuationOf ?? null,
    truncated: !!entry?.stepsTruncated,
    counts: {
      turns: entry?.turns ?? null,
      toolCalls: entry?.toolCalls ?? null,
      failedTools: entry?.failedTools ?? null,
      declinedTools: entry?.declinedTools ?? null,
      fileChanges: Array.isArray(entry?.fileChanges) ? entry.fileChanges.length : 0
    }
  };
}

/**
 * The card fields for the run list, without projecting a body nobody reads.
 *
 * The list renders hundreds of these, and building blocks for each one would do
 * the expensive half of the projection for a page the reader has not opened.
 */
export function projectRunSummary(entry) {
  const { status, tone } = statusFrom(entry || {});
  const agentic = entry?.agentic === true;
  const derivedTitle = titleFromPrompt(entry?.promptPreview || '', `${entry?.command || 'task'} run`);
  return {
    id: entry?.id || null,
    // A custom title wins over the derived one, here and on the page, so a
    // renamed run reads the same everywhere it appears.
    title: typeof entry?.customTitle === 'string' && entry.customTitle !== ''
      ? entry.customTitle
      : derivedTitle,
    badge: entry?.command || 'task',
    status,
    tone,
    at: entry?.ts || null,
    playbook: entry?.playbook ?? null,
    model: entry?.model ?? null,
    durationMs: entry?.durationMs ?? null,
    durationText: formatDuration(entry?.durationMs),
    tokensText: formatTokens(entry?.usage),
    agentic,
    applied: entry?.applied === true,
    workspace: entry?.workspace ?? null,
    projectId: entry?.projectId ?? null,
    turns: entry?.turns ?? null,
    toolCalls: entry?.toolCalls ?? null,
    failedTools: entry?.failedTools ?? null,
    declinedTools: entry?.declinedTools ?? null,
    fileChangeCount: Array.isArray(entry?.fileChanges) ? entry.fileChanges.length : 0,
    truncated: !!entry?.stepsTruncated
  };
}

/**
 * State for a run that is being started.
 *
 * Kept separate from the projection so the live path owns its own bookkeeping
 * (which prose block is open, what has been counted) without those fields
 * leaking into the shape a reader sees.
 */
export function createLiveRun(request = {}) {
  return {
    id: request.id || null,
    prompt: request.prompt || '',
    request,
    status: 'starting',
    tone: 'neutral',
    model: null,
    workspace: request.workspaceDir || null,
    projectId: request.projectId ?? null,
    playbook: request.playbook || null,
    blocks: [],
    proseIndex: null,
    proseTurn: null,
    startBlockIndex: null,
    turns: 0,
    // A run that reaches its budget is continued rather than stopped, and each
    // continuation is a fresh harness session whose turn numbers restart at 1.
    // The offsets are what make the page count turns, tokens, and time across
    // the whole run instead of showing turn 3 four separate times.
    turnOffset: 0,
    tokenOffset: 0,
    durationOffset: 0,
    extensions: 0,
    grantedTurns: request.maxTurns ?? null,
    // Pause is a request the run honours between turns, and `paused` is the
    // state it reaches when it does.
    pauseRequested: false,
    paused: false,
    toolCalls: 0,
    failed: 0,
    declined: 0,
    approvals: [],
    fileChanges: [],
    tokens: null,
    durationMs: null,
    sessionId: null,
    doneSeen: false,
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    error: null
  };
}

/** Append a block and return its index. */
function push(run, block) {
  run.blocks.push(block);
  return run.blocks.length - 1;
}

/**
 * Append a block to a live run from outside this module.
 *
 * The registry narrates an extension into the run's own body, and it lives in a
 * different module, so it needs a way in that is not the private `push`.
 */
export function appendLiveBlock(run, block) {
  return push(run, block);
}

/**
 * Fold one harness event into a live run.
 *
 * Mutates `run` and returns the blocks that changed, each with its index, which
 * is what the server forwards over SSE. Sending deltas rather than the whole
 * page keeps a long run from re-sending its entire body on every token.
 *
 * `text` events arrive one stream delta at a time, so consecutive text for the
 * same turn extends the open prose block. Appending a block per delta would
 * give a 4000-block page whose last 3999 blocks are fragments.
 */
export function applyLiveEvent(run, event) {
  const changed = [];
  if (!run || !event || typeof event.type !== 'string') return changed;

  switch (event.type) {
    case 'run-start': {
      run.model = event.model ? (String(event.model).includes('/') ? event.model : `${event.provider || 'model'}/${event.model}`) : null;
      run.workspace = event.workspace ?? run.workspace;
      run.playbook = event.playbook ?? run.playbook;
      run.status = 'running';
      run.tone = 'running';
      // Only the first segment announces itself. An extension resumes the same
      // session, so a second "Running model X" callout would read as a second
      // run starting when the whole point is that it is one run continuing.
      if (run.startBlockIndex === null) {
        const index = push(run, {
          kind: 'callout',
          tone: 'info',
          text: `Running ${run.model || 'the configured model'}`,
          detail: run.workspace ? `in ${run.workspace}` : null
        });
        run.startBlockIndex = index;
        changed.push({ index, block: run.blocks[index] });
      }
      break;
    }
    case 'turn': {
      // Offset by the segments already spent: a resumed session numbers its
      // turns from 1 again, and the run's own count must not restart with it.
      run.turns = Math.max(run.turns, run.turnOffset + (Number(event.turn) || 0));
      // A new turn closes the previous turn's prose. Leaving it open would keep
      // the streaming flag set on a block nothing will ever append to again,
      // which renders as a cursor that blinks forever.
      if (run.proseIndex !== null && run.blocks[run.proseIndex]?.kind === 'prose') {
        run.blocks[run.proseIndex].streaming = false;
        changed.push({ index: run.proseIndex, block: run.blocks[run.proseIndex] });
      }
      run.proseIndex = null;
      run.proseTurn = null;
      // Labelled with the run's own turn number, not the segment's. A resumed
      // session numbers from 1 again, so the raw value printed a second
      // "Turn 1" halfway down the page and read as the run going backwards.
      const turnNumber = run.turnOffset + (Number(event.turn) || 0);
      const index = push(run, {
        kind: 'divider',
        label: `Turn ${event.turn === undefined || event.turn === null ? '?' : turnNumber}`,
        tokens: Number.isFinite(event.tokens) ? event.tokens.toLocaleString('en-US') : null
      });
      changed.push({ index, block: run.blocks[index] });
      break;
    }
    case 'text': {
      const text = typeof event.text === 'string' ? event.text : '';
      if (text === '') break;
      const turn = event.turn ?? 0;
      if (run.proseIndex !== null && run.proseTurn === turn) {
        const block = run.blocks[run.proseIndex];
        block.text += text;
        changed.push({ index: run.proseIndex, block });
      } else {
        const index = push(run, { kind: 'prose', label: null, text, turn, streaming: true });
        run.proseIndex = index;
        run.proseTurn = turn;
        changed.push({ index, block: run.blocks[index] });
      }
      break;
    }
    case 'tool': {
      run.toolCalls++;
      const accepted = event.outcome === 'ok' || event.outcome === 'dry-run';
      if (event.outcome === 'declined') run.declined++;
      else if (!accepted) run.failed++;
      // A writer that succeeded is a real change. A successful *read* names a
      // path too, so the tool decides this, not the presence of a path.
      if (accepted && WRITER_TOOL_NAMES.has(event.name)) {
        const path = mutationPath(event.args);
        if (path) run.fileChanges.push({ path, tool: event.name, turn: event.turn ?? null });
      }
      const index = push(run, {
        kind: 'tool',
        turn: event.turn ?? null,
        name: event.name || 'tool',
        target: summarizeToolCall(event.name, event.args),
        outcome: event.outcome || 'unknown',
        tone: outcomeTone(event.outcome),
        durationMs: event.durationMs ?? null,
        durationText: formatDuration(event.durationMs),
        truncated: !!event.truncated,
        note: event.note ?? null,
        // The call's own text, which the harness sends only for a failure. It is
        // why a failed call can say what went wrong instead of only how long it
        // took to go wrong. Gated on the outcome rather than on the field being
        // present: a successful call's body is the work itself, and a page that
        // took it when offered would put every file a run read on screen.
        output: event.outcome !== 'ok' && event.outcome !== 'dry-run'
          && typeof event.output === 'string' && event.output.trim() !== ''
          ? event.output
          : null
      });
      changed.push({ index, block: run.blocks[index] });
      break;
    }
    case 'approval': {
      run.approvals.push({ tool: event.tool, decision: event.decision, risk: event.risk ?? null });
      const index = push(run, {
        kind: 'approval',
        tool: event.tool || 'tool',
        decision: event.decision || 'unknown',
        risk: event.risk ?? null,
        tone: event.decision === 'approved' ? 'ok' : event.decision === 'declined' ? 'declined' : 'neutral'
      });
      changed.push({ index, block: run.blocks[index] });
      break;
    }
    case 'done': {
      // Same offset rule as a turn event: the segment reports its own turns,
      // tokens, and duration, and the run reports the sum of every segment.
      // Overwriting with the segment's numbers would make a twenty-turn run
      // report the cost of its last turn.
      if (Number.isFinite(event.turns)) {
        run.turns = Math.max(run.turns, run.turnOffset + event.turns);
      }
      if (Number.isFinite(event.tokens)) {
        run.tokens = (run.tokenOffset || 0) + event.tokens;
      }
      if (Number.isFinite(event.durationMs)) {
        run.durationMs = (run.durationOffset || 0) + event.durationMs;
      }
      run.sessionId = event.sessionId ?? null;
      run.doneSeen = true;
      run.endedAt = Date.now();
      break;
    }
    default:
      break;
  }
  return changed;
}

/**
 * Close the run: settle the last prose block, decide the status, and write the
 * closing summary.
 *
 * The summary is written here rather than on the `done` event because only now
 * is the outcome known. A summary block emitted when the model stops cannot say
 * whether the process then exited non-zero, and it would sit above the error
 * notice that explains the failure.
 */
export function finishLiveRun(run, outcome = {}) {
  const changed = [];
  if (!run) return changed;

  if (run.proseIndex !== null && run.blocks[run.proseIndex]?.kind === 'prose') {
    run.blocks[run.proseIndex].streaming = false;
    changed.push({ index: run.proseIndex, block: run.blocks[run.proseIndex] });
    run.proseIndex = null;
  }

  // The opening callout said what was about to happen. Now that it has, the
  // present tense is a lie, so the block is rewritten rather than left saying
  // "Running" on a run that stopped ten minutes ago.
  if (run.startBlockIndex != null && run.blocks[run.startBlockIndex]?.kind === 'callout') {
    const block = run.blocks[run.startBlockIndex];
    block.text = block.text.replace(/^Running\b/, 'Ran');
    changed.push({ index: run.startBlockIndex, block });
  }

  run.endedAt = run.endedAt ?? Date.now();
  if (outcome.paused) {
    // Paused is not stopped and not finished. The work is intact, the session
    // is saved, and the run is waiting for someone to say continue — so it gets
    // its own status rather than borrowing the colour of either ending.
    run.status = 'paused';
    run.tone = 'paused';
  } else if (outcome.cancelled) {
    // Stopping a run is not the run failing. Reporting it as an error would
    // teach the reader to distrust the error colour.
    run.status = 'cancelled';
    run.tone = 'neutral';
  } else if (outcome.error) {
    run.error = String(outcome.error);
    run.status = 'failed';
    run.tone = 'error';
  } else if (outcome.ok === false) {
    run.status = 'failed';
    run.tone = 'error';
    run.exitCode = outcome.exitCode ?? 1;
  } else {
    run.status = 'ok';
    run.tone = 'ok';
  }

  if (run.error && !outcome.cancelled) {
    const index = push(run, { kind: 'notice', tone: 'error', text: run.error });
    changed.push({ index, block: run.blocks[index] });
  } else if (run.status === 'failed') {
    const index = push(run, {
      kind: 'notice',
      tone: 'error',
      text: `The run exited with code ${run.exitCode ?? 1}.`
    });
    changed.push({ index, block: run.blocks[index] });
  } else if (run.status === 'cancelled') {
    const index = push(run, {
      kind: 'notice',
      tone: 'neutral',
      text: 'Stopped on request. The harness process was terminated.'
    });
    changed.push({ index, block: run.blocks[index] });
  } else if (run.status === 'paused') {
    const index = push(run, {
      kind: 'notice',
      tone: 'paused',
      // Says the two things a reader needs to decide what to do next: the work
      // survived, and nothing is being spent while it waits.
      text: `Paused after ${run.turns || 'the current'} turn${run.turns === 1 ? '' : 's'}. The session is saved, so resuming continues from here.`
    });
    changed.push({ index, block: run.blocks[index] });
  }

  const items = [];
  if (run.turns) items.push({ name: 'Turns', detail: String(run.turns) });
  if (run.toolCalls) {
    items.push({
      name: 'Tool calls',
      detail: `${run.toolCalls}${run.failed ? ` (${run.failed} failed)` : ''}${run.declined ? ` (${run.declined} declined)` : ''}`
    });
  }
  if (Number.isFinite(run.tokens)) items.push({ name: 'Tokens', detail: run.tokens.toLocaleString('en-US') });
  const duration = formatDuration(run.durationMs ?? (run.endedAt - run.startedAt));
  if (duration) items.push({ name: 'Duration', detail: duration });
  if (run.fileChanges.length > 0) {
    items.push({ name: 'Changed', detail: `${run.fileChanges.length} file${run.fileChanges.length === 1 ? '' : 's'}` });
  }
  const index = push(run, {
    kind: 'summary',
    label: run.status === 'failed' ? 'Run failed' : run.status === 'cancelled' ? 'Run stopped' : 'Run finished',
    tone: run.tone,
    items
  });
  changed.push({ index, block: run.blocks[index] });
  return changed;
}

/**
 * The live run as a page, in the same shape the archive produces.
 *
 * This is the function that makes the two paths one feature: the client renders
 * whatever `toPage` returns, whether the run ended a minute ago or a month ago.
 */
export function liveRunToPage(run) {
  const record = {
    command: 'agent',
    playbook: run.playbook,
    role: run.request?.role,
    model: run.model,
    durationText: formatDuration(run.endedAt ? run.endedAt - run.startedAt : null),
    tokensText: Number.isFinite(run.tokens) ? run.tokens.toLocaleString('en-US') : null,
    turns: run.turns || null,
    turnBudgetText: turnBudgetText(
      run.turns,
      run.request?.maxTurns,
      run.turnLimitReached === true,
      run.extensions
    ),
    toolCalls: run.toolCalls || null,
    failedTools: run.failed || null,
    declinedTools: run.declined || null,
    policy: run.request?.apply ? 'apply' : run.request?.autoApproveSafe === false ? 'strict' : 'read-only',
    workspace: run.workspace,
    files: run.request?.files,
    promptChars: run.prompt ? run.prompt.length : null,
    prUrl: run.prUrl || null
  };
  // The archived twin carries this as a record field; the live page carries
  // it alongside, so a run started under a project names it while running.
  // The name is set by the registry on projection and omitted here, so a
  // page whose project was deleted carries no stale name: the key's absence
  // is what the renderer reads as "nothing to link to".
  const page = {
    id: run.id,
    live: true,
    // A custom title wins over the derived prompt title, matching the
    // archived projection: a live run renamed mid-flight reads the same as
    // the page it becomes.
    title: typeof run.customTitle === 'string' && run.customTitle !== ''
      ? run.customTitle
      : titleFromPrompt(run.prompt, 'Agent run'),
    badge: 'agent',
    status: run.status,
    tone: run.tone,
    at: new Date(run.startedAt).toISOString(),
    // The archived twin carries this as a record field; the live page carries
    // it alongside. It is the reconciled id — request base, override on top —
    // never the raw request, or a moved live run would report where it started
    // instead of where it now lists.
    projectId: run.projectId ?? null,
    workspace: run.workspace ?? null,
    prUrl: run.prUrl || null,
    props: [
      { key: 'prompt', label: 'Prompt', value: run.prompt },
      ...propsFrom(record)
    ],
    blocks: run.blocks.map((b) => ({ ...b })),
    turnBudget: turnBudgetOf({
      turns: run.turns,
      maxTurns: run.request?.maxTurns,
      turnLimitReached: run.turnLimitReached,
      sessionId: run.sessionId,
      extensions: run.extensions,
      paused: run.paused
    }),
    continuationOf: run.request?.continuationOf ?? null,
    truncated: false,
    counts: {
      turns: run.turns,
      toolCalls: run.toolCalls,
      failedTools: run.failed,
      declinedTools: run.declined,
      fileChanges: run.fileChanges.length
    }
  };
  if (typeof run.projectName === 'string' && run.projectName !== '') {
    page.projectName = run.projectName;
  }
  return page;
}

/**
 * The file a mutating call touched. Asks the harness, which owns the argument
 * names, so a reader and the change summary always agree on what a path is.
 */
export function mutationTarget(args) {
  return mutationPath(args);
}

/** One-line argument summary, taken from the harness so both render identically. */
export function summarizeArgs(args) {
  return summarizeToolCall(null, args);
}

/** Whether a tool call can change a file, which decides if it counts as one. */
export function isWriterTool(name) {
  return WRITER_TOOL_NAMES.has(name);
}

export { formatDuration, formatTokens };
