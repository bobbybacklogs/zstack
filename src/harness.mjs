/**
 * zstack's client for the ModelHitch harness: the agent loop with tools.
 *
 * zstack owns methodology (playbooks, principles, classification) and model
 * routing (budget tiers, provider lanes). ModelHitch owns execution: the tool
 * loop, approval gates, snapshots, session transcripts, and batching. A zstack
 * task that needs to *do* work therefore runs the harness rather than
 * reimplementing a loop, and reads its NDJSON event stream to render progress.
 *
 * Wire format: `mhh --json-events` writes one JSON object per line to stdout and
 * moves the human transcript to stderr. The schema is versioned
 * (`HARNESS_EVENTS_SCHEMA`); consumers pin it rather than sniffing for fields.
 *
 *   run-start  { schema, at, task, model, provider, sessionId, workspace, playbook, approvals }
 *   text       { at, turn, text }
 *   tool       { at, turn, name, args, outcome, durationMs, truncated, bytes, note?, output? }
 *   approval   { at, tool, decision, risk?, reason? }
 *   turn       { at, turn, tokens, totalTokens }
 *   done       { at, turns, tokens, tools, durationMs, changes?, sessionId? }
 *
 * `tool.output` is the call's own text, present only when the outcome is a
 * failure (`error`, `timeout`, `truncated`) and capped by the harness. It is what
 * turns "subagent error · 4ms" into a sentence a reader can act on.
 *
 * The task is piped on stdin rather than passed as an argument: prompts contain
 * quotes, newlines, and Windows-hostile characters, and argv quoting is where a
 * runner like this breaks first. A non-TTY stdin also makes the harness decline
 * mutating calls instead of blocking on a question, which is what makes the
 * default read-only.
 */

import { spawn, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Event schema this client understands. */
export const HARNESS_EVENTS_SCHEMA = 1;

/**
 * The harness default for `--max-turns` when the caller sets no budget.
 * Mirrored here so a run that stopped at the limit can be identified even when
 * zstack did not pass the flag.
 */
export const HARNESS_DEFAULT_MAX_TURNS = 8;

/** Tool outcomes the harness reports, from `harness/result.ts`. */
export const TOOL_OUTCOMES = ['ok', 'error', 'timeout', 'truncated', 'declined', 'dry-run'];

/** Outcome that means the run changed something on disk. */
const MUTATING_OUTCOMES = new Set(['ok', 'dry-run']);

/**
 * Tools that change files. Used to tell a real write from a read that happened
 * to be approved, so the change summary names files rather than tools.
 */
export const WRITER_TOOL_NAMES = new Set(['write', 'edit', 'multi_edit', 'patch', 'apply_patch', 'create', 'delete', 'move']);

/** Path-like argument names, in the order a reader most wants to see them. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target', 'filename'];

/** The file a tool call touched, when its arguments name one. */
export function mutationPath(args) {
  if (!args || typeof args !== 'object') return null;
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** zstack package root (this file lives in `src/`). */
export const ZSTACK_ROOT = resolve(HERE, '..');

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the harness entry point.
 *
 * Order matters. An explicit override wins; then the sibling checkout, so a
 * working copy of ModelHitch is exercised rather than whatever is installed
 * globally; then PATH. The sibling convention mirrors the one ModelHitch itself
 * uses to find zstack (`zstackRoot()` in `harness/prompt.ts`).
 *
 * @returns {{ command: string, args: string[], shell: boolean, source: string } | null}
 */
export function resolveHarnessEntry(options = {}) {
  const env = options.env ?? process.env;
  const root = options.rootDir ?? ZSTACK_ROOT;

  const override = env.ZSTACK_HARNESS_BIN;
  if (override && override.trim() !== '') {
    const bin = override.trim();
    // A .js/.mjs/.cjs override is a script to run under this node; anything else
    // is treated as an executable on PATH.
    return /\.(?:m|c)?js$/.test(bin)
      ? { command: process.execPath, args: [bin], shell: false, source: 'ZSTACK_HARNESS_BIN' }
      : { command: bin, args: [], shell: process.platform === 'win32', source: 'ZSTACK_HARNESS_BIN' };
  }

  const siblings = [
    join(root, '..', 'ModelHitch', 'dist', 'harness-cli.js'),
    join(root, '..', '..', 'ModelHitch', 'dist', 'harness-cli.js')
  ];
  for (const candidate of siblings) {
    if (isFile(candidate)) {
      return { command: process.execPath, args: [candidate], shell: false, source: 'sibling ModelHitch checkout' };
    }
  }

  const pathEntry = findOnPath('mhh', env) ?? findOnPath('modelhitch-harness', env);
  if (pathEntry) {
    return { command: pathEntry, args: [], shell: process.platform === 'win32', source: 'PATH' };
  }

  return null;
}

function findOnPath(name, env) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.ps1', ''] : [''];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (!isFile(candidate)) continue;
      // A .ps1 is not directly spawnable; prefer the .cmd shim beside it.
      if (candidate.endsWith('.ps1')) continue;
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        // On Windows X_OK is not meaningful; existence is enough.
        if (process.platform !== 'win32') continue;
      }
      return candidate;
    }
  }
  return null;
}

/** Human-readable description of a tool call's target, for the progress view. */
export function summarizeToolCall(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  // Priority order: the field a reader most wants to see for that call.
  const keys = [
    'cmd',
    'command',
    'file_path',
    'filePath',
    'path',
    'pattern',
    'query',
    'url',
    'prompt',
    'task',
    'name'
  ];
  for (const key of keys) {
    const value = a[key];
    if (typeof value === 'string' && value.trim() !== '') return truncate(oneLine(value), 96);
  }
  const keysInArgs = Object.keys(a);
  return keysInArgs.length === 0 ? '' : truncate(keysInArgs.join(', '), 96);
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * `run-start.model` already carries its provider prefix (`opencode-go/deepseek-v4-pro`),
 * so only add the provider when the model is bare.
 */
function qualifiedModel(model, provider) {
  if (!model) return provider || null;
  return String(model).includes('/') ? String(model) : provider ? `${provider}/${model}` : String(model);
}

/**
 * Parse the NDJSON stream a harness run writes to stdout.
 *
 * Exported because it is the piece worth testing without spawning anything: it
 * must tolerate a partial trailing line, blank lines, and garbage without
 * losing the records around them.
 */
export function createEventParser(onEvent) {
  let buffer = '';
  let malformed = 0;
  let seen = 0;

  const handle = (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      malformed++;
      return;
    }
    if (!record || typeof record !== 'object' || typeof record.type !== 'string') {
      malformed++;
      return;
    }
    seen++;
    if (onEvent) onEvent(record);
  };

  return {
    push(chunk) {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer.trim() !== '') handle(buffer);
      buffer = '';
      return { malformed, seen };
    },
    get malformed() {
      return malformed;
    }
  };
}

/**
 * Run one agentic task through the harness.
 *
 * Resolves with the collected events and the terminal `done` record. A non-zero
 * exit resolves with `ok: false` rather than throwing, because a failed run
 * still produced events the caller wants to show.
 */
export function runHarnessTask(options) {
  const {
    prompt,
    model,
    workspaceDir,
    apply = false,
    maxTurns,
    review = false,
    autoApproveSafe = false,
    harnessArgs = [],
    /**
     * Write the run's session to the harness state directory, and continue one.
     *
     * Saving is what makes a turn budget recoverable: a run that stops at its
     * ceiling can be resumed with a bigger one instead of being thrown away and
     * started again from the same prompt. zstack turns this on for its own runs
     * because it is the one starting them on the reader's behalf, and a reader
     * who did not choose the budget should not lose the work to it.
     */
    saveSession = true,
    resume = null,
    onEvent,
    onStderr,
    timeoutMs = 0,
    signal,
    env = process.env,
    entry = resolveHarnessEntry({ env })
  } = options;

  if (!prompt || String(prompt).trim() === '') {
    return Promise.reject(new Error('An agent run needs a prompt.'));
  }
  if (!entry) {
    const err = new Error(
      'The ModelHitch harness was not found. Install it (`npm i -g modelhitch`) or point ZSTACK_HARNESS_BIN at dist/harness-cli.js.'
    );
    err.kind = 'harness-missing';
    return Promise.reject(err);
  }

  const args = [...entry.args, '--json-events', '--plain'];
  if (model) args.push('--model', String(model));
  if (Number.isFinite(maxTurns) && maxTurns > 0) args.push('--max-turns', String(Math.floor(maxTurns)));
  // Resuming restores the stored history, so the prompt is the *next*
  // instruction rather than a repeat of the original one. It goes last because
  // the harness reads a trailing positional as the task.
  if (resume) args.push('--resume', String(resume));
  if (saveSession) args.push('--save-session');
  if (review) args.push('--review');
  // Without this the harness declines every mutating call under a non-TTY stdin,
  // which is the safe default and exactly what a read-only analysis wants.
  if (apply) args.push('--yes');
  // `autoApproveSafe` runs the risk classifier, which `mayAutoApprove` consults
  // *before* the TTY check. A command the classifier calls safe is therefore
  // approved even with no terminal, while caution and dangerous still decline.
  // Read-only analysis needs this: `bash` is always classified mutating, so
  // without it the agent cannot even list a directory.
  if (autoApproveSafe && !apply) args.push('--auto-approve-safe');
  args.push(...harnessArgs);

  const events = [];
  const parser = createEventParser((record) => {
    events.push(record);
    if (onEvent) onEvent(record);
  });
  let stderr = '';

  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(entry.command, args, {
        cwd: workspaceDir || process.cwd(),
        env,
        shell: entry.shell,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      rejectPromise(err);
      return;
    }

    let settled = false;
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) child.kill();
      }, timeoutMs);
    }

    /**
     * Killing the child lets the run settle through the normal path: `close`
     * fires with a non-zero code and the promise resolves with `ok: false`
     * rather than rejecting. A caller that asked to stop still gets the events
     * the run produced before it stopped, which is the point of stopping.
     */
    const onAbort = () => {
      if (!settled) child.kill();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => parser.push(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (onStderr) onStderr(chunk);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      rejectPromise(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const { malformed } = parser.flush();
      const done = events.find((e) => e.type === 'done') ?? null;
      const schema = events.find((e) => e.type === 'run-start')?.schema;
      resolvePromise({
        ok: code === 0 && !signal?.aborted,
        exitCode: code ?? 0,
        aborted: !!signal?.aborted,
        events,
        done,
        stderr,
        malformed,
        schema,
        entry,
        args
      });
    });

    // Piping the task on stdin keeps arbitrary prompts out of argv.
    child.stdin.on('error', () => {
      /* the child may exit before reading stdin */
    });
    child.stdin.end(String(prompt));
  });
}

/**
 * Reduce a run's events into the summary a progress view shows.
 */
export function buildProgression(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const steps = [];
  let turns = 0;
  let toolCount = 0;
  let failed = 0;
  let declined = 0;
  const approvals = [];
  const text = [];
  const fileChanges = [];

  for (const event of list) {
    switch (event.type) {
      case 'run-start':
        steps.push({
          kind: 'start',
          turn: 0,
          model: qualifiedModel(event.model, event.provider),
          workspace: event.workspace ?? null,
          playbook: event.playbook ?? null,
          approvals: event.approvals ?? null
        });
        break;
      case 'turn':
        turns = Math.max(turns, Number(event.turn) || 0);
        steps.push({ kind: 'turn', turn: event.turn, tokens: event.tokens ?? null });
        break;
      case 'tool': {
        toolCount++;
        const ok = MUTATING_OUTCOMES.has(event.outcome) && event.outcome !== 'dry-run';
        if (event.outcome === 'declined') declined++;
        else if (!ok) failed++;
        const target = summarizeToolCall(event.name, event.args);
        // A writer that succeeded is a real file change. The harness reports
        // these as the tool that made them, so recover the path here.
        if (ok && WRITER_TOOL_NAMES.has(event.name)) {
          const path = mutationPath(event.args);
          if (path) fileChanges.push({ path, tool: event.name, turn: event.turn ?? null });
        }
        steps.push({
          kind: 'tool',
          turn: event.turn,
          name: event.name,
          target,
          outcome: event.outcome,
          durationMs: event.durationMs ?? null,
          truncated: !!event.truncated,
          bytes: event.bytes ?? null,
          // A failed call's own text, which is what keeps "subagent error · 4ms"
          // from being the whole story. Carried here rather than only onto the
          // live blocks because the record is what a reader re-opens, and the
          // live page is pruned from memory on a timer.
          ...(typeof event.output === 'string' && event.output !== '' ? { output: event.output } : {})
        });
        break;
      }
      case 'approval':
        approvals.push({ tool: event.tool, decision: event.decision, risk: event.risk ?? null });
        steps.push({ kind: 'approval', turn: null, tool: event.tool, decision: event.decision, risk: event.risk ?? null });
        break;
      case 'text':
        // `text` events arrive one stream delta at a time, so consecutive text
        // for the same turn is concatenated rather than kept as separate parts.
        // Without this the model's answer is shredded into fragments and
        // "the last thing it said" is whatever token happened to come last.
        if (typeof event.text === 'string' && event.text !== '') {
          const turn = event.turn ?? 0;
          const open = text.length > 0 ? text[text.length - 1] : null;
          if (open && open.turn === turn) open.text += event.text;
          else text.push({ turn, text: event.text });
        }
        break;
      default:
        break;
    }
  }

  const done = list.find((e) => e.type === 'done') ?? null;
  const totalTurns = done?.turns ?? turns;
  /**
   * The loop ran out of turns rather than the model choosing to stop.
   *
   * Worth separating from "the model said nothing", because the two need
   * different advice: raise `--max-turns`, versus the model simply had no
   * closing remark. `maxTurns` defaults to the harness default when the caller
   * did not set one.
   */
  const assumedMaxTurns = Number.isFinite(options.maxTurns) && options.maxTurns > 0
    ? Math.floor(options.maxTurns)
    : HARNESS_DEFAULT_MAX_TURNS;
  const textParts = text.filter((part) => part.text.trim() !== '');

  return {
    steps,
    turns: totalTurns,
    toolCount: done?.tools ?? toolCount,
    failed,
    declined,
    approvals,
    changes: Array.isArray(done?.changes) ? done.changes : [],
    /** Files a successful write or edit tool touched, with the tool's name. */
    fileChanges,
    tokens: done?.tokens ?? null,
    durationMs: done?.durationMs ?? null,
    sessionId: done?.sessionId ?? steps.find((s) => s.kind === 'start')?.sessionId ?? null,
    /**
     * Model prose, one entry per turn that produced any, in turn order. Deltas
     * within a turn are already concatenated.
     */
    text: textParts,
    /** True when the loop stopped at the turn budget, not on its own terms. */
    turnLimitReached: totalTurns >= assumedMaxTurns,
    maxTurns: assumedMaxTurns,
    model: options.model ?? steps.find((s) => s.kind === 'start')?.model ?? null
  };
}

/** Final assistant text for a run: the last thing the model said. */
export function finalText(progression) {
  const parts = (progression?.text ?? []).map((t) => String(t.text ?? '').trim()).filter(Boolean);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/**
 * The harness's own explanation of a failed run, or null when it gave none.
 *
 * A run can fail before it produces a single event — an expired key, a lane
 * that is not reachable, a model that rejects the request — and the harness
 * reports exactly that on stderr, where the human transcript lives. zstack used
 * to drop it, so the page could only say the process exited non-zero: the one
 * fact the reader needs was the one thing not carried across.
 *
 * The stderr transcript is human prose, so this picks the numbered failure line
 * (`✖ ...`) the harness writes for the reason, falls back to the first
 * `Error:`/`Exit` line, and returns null when the transcript says nothing worth
 * showing. Returning null is deliberate: a caller that has no reason must keep
 * its existing generic message rather than put a transcript in the UI.
 */
export function failureReasonFromStderr(stderr) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    // The transcript is decorated: the renderer indents with a gutter marker and
    // the harness prefixes its own notes with `[harness]`. Both are stripped so
    // the line is judged on what it says, not on how it was drawn.
    .map((line) => line.replace(/^[▌|]\s*/, '').replace(/^\[harness\]\s*/, '').trim())
    .filter((line) => line.startsWith('✖') || line.startsWith('Error:') || line.startsWith('Exit '));
  if (lines.length === 0) return null;
  return lines[0].replace(/^✖\s*/, '').slice(0, 600);
}

/**
 * Why a run has no closing message, or null when it has one.
 *
 * An empty `content` is ambiguous on its own: the model may have run out of
 * turns mid-work, or simply finished without a summary. The two need different
 * advice, so this is the single place that decides which it was.
 */
export function explainEmptyContent(result) {
  if (result?.content && String(result.content).trim() !== '') return null;
  if (result?.turnLimitReached) {
    // Continuing beats re-running: the session is saved, so the work resumes
    // instead of starting over from the same prompt.
    return `The run stopped at its ${result.maxTurns}-turn limit before the model wrote a closing message. Continue it with \`zstack --continue\`, or raise --max-turns for a fresh run.`;
  }
  if (result?.declinedTools > 0) {
    return `The model produced no closing message, and ${result.declinedTools} call${result.declinedTools === 1 ? ' was' : 's were'} declined. Re-run with --apply if the work needed to write.`;
  }
  return 'The model produced no closing message. The steps above are what it did.';
}

/**
 * One progress line for an event, or null when the event does not warrant one.
 * Kept separate from rendering so the CLI and the SDK agree on the wording.
 */
export function formatEventLine(event) {
  switch (event?.type) {
    case 'run-start': {
      const model = qualifiedModel(event.model, event.provider) ?? 'default';
      return `[>] Agent run: ${model} in ${event.workspace ?? process.cwd()}`;
    }
    case 'turn':
      return `[${event.turn}] turn ${event.turn}${event.tokens ? ` (${event.tokens} tokens)` : ''}`;
    case 'tool': {
      const target = summarizeToolCall(event.name, event.args);
      const detail = [event.outcome ?? 'ok', event.durationMs != null ? `${event.durationMs}ms` : null]
        .filter(Boolean)
        .join(', ');
      const mark = event.outcome === 'ok' || event.outcome === 'dry-run' ? '·' : '!';
      return `    ${mark} ${event.name}${target ? ` ${target}` : ''}  [${detail}]`;
    }
    case 'approval':
      return `    ! approval ${event.tool}: ${event.decision}${event.risk ? ` (${event.risk})` : ''}`;
    case 'text': {
      const body = String(event.text ?? '').trim();
      if (body === '') return null;
      // The model's own words between tool calls, indented so they read as
      // narration rather than as another tool line.
      return body
        .split('\n')
        .map((line) => `    │ ${line}`)
        .join('\n');
    }
    case 'done': {
      const parts = [`${event.turns} turns`, `${event.tools} tools`, `${event.durationMs}ms`];
      if (Array.isArray(event.changes) && event.changes.length > 0) {
        const added = event.changes.reduce((n, c) => n + (c.added || 0), 0);
        const removed = event.changes.reduce((n, c) => n + (c.removed || 0), 0);
        parts.push(`${event.changes.length} files changed (+${added}/-${removed})`);
      }
      return `[✓] ${parts.join(' | ')}`;
    }
    default:
      return null;
  }
}

/**
 * True when the resolved entry names something runnable.
 *
 * A directory satisfies `existsSync` but cannot be spawned, so this checks for a
 * file. On Windows a PATH entry is a `.cmd` shim, which is a file too.
 */
export function harnessEntryExists(entry) {
  if (!entry) return false;
  if (entry.command === process.execPath) return entry.args.length > 0 && isFile(entry.args[0]);
  return isFile(entry.command);
}

/**
 * Observe what an apply run actually left behind, from git.
 *
 * Tool attribution only covers calls made through the harness's own writer
 * tools. A model that writes with `node -e fs.appendFileSync(...)`, a shell
 * redirect, or a formatter changes the tree with no attributable call, and
 * reporting "no changes" there would be a false negative. Git is the artifact
 * that does not care how the bytes were written.
 *
 * Returns null when the workspace is not a git repository or git is unavailable.
 */
export function observeGitStatus(workspaceDir, options = {}) {
  const dir = workspaceDir || process.cwd();
  try {
    if (!existsSync(join(dir, '.git'))) return null;
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: options.timeoutMs ?? 10_000,
      windowsHide: true
    });
    const entries = String(out)
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const status = line.slice(0, 2).trim();
        // Renames render as "R  old -> new"; the new path is the useful one.
        const raw = line.slice(3).trim();
        const path = raw.includes(' -> ') ? raw.split(' -> ')[1] : raw;
        return { status, path };
      });
    return { entries, count: entries.length };
  } catch {
    return null;
  }
}

/**
 * A progress renderer that coalesces the model's streamed text into blocks.
 *
 * `text` events arrive one stream delta at a time, so printing each on its own
 * line renders a sentence as one word per line. Consecutive text for the same
 * turn is therefore buffered and flushed as a unit, immediately before whatever
 * interrupts it: a tool call, a new turn, or the end of the run.
 */
export function createProgressRenderer(options = {}) {
  const write = options.write ?? ((line) => console.log(line));
  const format = options.format ?? formatEventLine;

  let textTurn = null;
  let textBuffer = '';

  const flushText = () => {
    const body = textBuffer.trim();
    const turn = textTurn;
    textBuffer = '';
    textTurn = null;
    if (body === '') return;
    // Reuse the single-event formatter so the indent matches tool lines.
    const rendered = format({ type: 'text', turn, text: body });
    if (rendered) write(rendered);
  };

  return {
    push(event) {
      if (!event) return;
      if (event.type === 'text') {
        if (textTurn !== null && event.turn !== textTurn) flushText();
        textTurn = event.turn ?? textTurn;
        textBuffer += String(event.text ?? '');
        return;
      }
      flushText();
      const line = format(event);
      if (line) write(line);
    },
    flush() {
      flushText();
    }
  };
}
