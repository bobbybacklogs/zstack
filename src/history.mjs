import { existsSync, mkdirSync, appendFileSync, openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HISTORY_PREVIEW_CHARS = 200;
export const HISTORY_DEFAULT_LIMIT = 20;

/** Byte length of one read when scanning or tailing the history file. */
const READ_CHUNK_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

let idCounter = 0;

/**
 * A stable, sortable id for one run.
 *
 * A run needs an address before it can be linked to, re-opened, or pointed at
 * by a later `mhh --undo`. Timestamp first keeps ids sortable in the same order
 * the file appends them; the counter separates two runs inside one millisecond
 * and the random suffix separates two processes.
 */
export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const seq = (idCounter++).toString(36).padStart(2, '0');
  return `${stamp}-${seq}${randomBytes(3).toString('hex')}`;
}

/**
 * The address of a stored run.
 *
 * Records written before ids existed have none, and an index into the returned
 * page is not an address: the same record gets a different index as soon as
 * another run is appended. So a legacy record is identified by the hash of its
 * own stored line, which is stable for as long as the record is.
 */
export function recordId(entry, rawLine) {
  if (entry && typeof entry.id === 'string' && entry.id !== '') return entry.id;
  const source = typeof rawLine === 'string' ? rawLine : JSON.stringify(entry ?? null);
  return `l-${createHash('sha1').update(String(source)).digest('hex').slice(0, 12)}`;
}

/**
 * Steps persisted per agentic run.
 *
 * A run can produce hundreds of events, and history is read back in full to
 * render the progression view. Capping keeps one long run from bloating the
 * file, and `stepsTruncated` says so rather than letting a reader mistake a
 * capped list for the whole run.
 */
export const HISTORY_MAX_STEPS = 200;

/**
 * Characters of the model's own words kept per agentic run.
 *
 * `steps` records what a run did and not what it said, so a re-opened run would
 * otherwise show its tool calls and silently lose the prose explaining them.
 * The cap is what keeps one chatty run from dominating the file; the flag says
 * when it bit, so a reader never mistakes a cut transcript for a short one.
 */
export const HISTORY_MAX_NARRATIVE_CHARS = 12000;

/** Path-like argument names, in the order a reader most wants to see them. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target', 'filename'];

/**
 * The file a mutating tool call touched, when its arguments name one.
 *
 * The harness reports a change as the *tool* that made it, so a summary built
 * from that reads "edit (+1/-0)" and never says which file. Recovering the path
 * from the call is what makes the line useful.
 */
export function mutationPath(args) {
  if (!args || typeof args !== 'object') return null;
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * Reduce a run's steps to the compact form stored in history.
 */
export function compactSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((step) => step && typeof step === 'object')
    .slice(0, HISTORY_MAX_STEPS)
    .map((step) => {
      const out = { kind: step.kind ?? 'unknown' };
      if (step.turn != null) out.turn = step.turn;
      if (step.name) out.name = step.name;
      if (step.target) out.target = step.target;
      if (step.outcome) out.outcome = step.outcome;
      if (step.durationMs != null) out.durationMs = step.durationMs;
      // Approvals carry `tool`, and the start step carries `model`; without
      // these the stored step renders as "approval undefined" and
      // "run started: default".
      if (step.tool) out.tool = step.tool;
      if (step.model) out.model = step.model;
      if (step.decision) out.decision = step.decision;
      if (step.risk) out.risk = step.risk;
      if (step.tokens != null) out.tokens = step.tokens;
      if (step.workspace) out.workspace = step.workspace;
      return out;
    });
}

export function historyPath(pathOverride) {
  return (
    pathOverride ||
    process.env.ZSTACK_HISTORY_PATH ||
    join(homedir(), '.zstack', 'history.jsonl')
  );
}

let warnedUnwritable = false;
function warnOnce(message) {
  if (warnedUnwritable) return;
  warnedUnwritable = true;
  console.error(message);
}

/** Reset the warn-once flag (tests only). */
export function resetHistoryWarnings() {
  warnedUnwritable = false;
}

/**
 * Append one JSON line per invocation. Best-effort: an unwritable history
 * warns once to stderr and never fails the underlying task.
 */
export function appendHistory(entry, pathOverride) {
  const record = {
    id: entry.id || newRunId(),
    ts: new Date().toISOString(),
    command: entry.command || 'task',
    playbook: entry.playbook || null,
    role: entry.role || null,
    model: entry.model || null,
    durationMs: entry.durationMs ?? null,
    usage: entry.usage || null,
    contextEstimate: entry.contextEstimate ?? null,
    promptChars: entry.promptChars ?? null,
    promptPreview: String(entry.promptPreview || '').slice(0, HISTORY_PREVIEW_CHARS),
    files: Array.isArray(entry.files) ? entry.files : [],
    ok: entry.ok !== false,
    errorKind: entry.errorKind || null,
    exitCode: entry.exitCode ?? (entry.ok === false ? 1 : 0)
  };

  // Agentic runs carry progression. Absent for single-completion runs, which is
  // why these are added conditionally rather than always present and null.
  // `projectId` travels in the same branch for a different reason: it is a
  // property of agentic runs only, because only the registry starts runs
  // under a project. A `task` record never has one to keep.
  if (entry.agentic || entry.command === 'agent') {
    record.agentic = true;
    record.applied = entry.applied === true;
    record.workspace = entry.workspace || null;
    record.projectId = typeof entry.projectId === 'string' && entry.projectId !== '' ? entry.projectId : null;
    record.turns = entry.turns ?? null;
    record.toolCalls = entry.toolCalls ?? null;
    record.failedTools = entry.failedTools ?? null;
    record.declinedTools = entry.declinedTools ?? null;
    record.changes = Array.isArray(entry.changes) ? entry.changes : [];
    record.fileChanges = Array.isArray(entry.fileChanges)
      ? entry.fileChanges.slice(0, HISTORY_MAX_STEPS).map((c) => ({ path: c.path, tool: c.tool, turn: c.turn ?? null }))
      : [];
    const steps = compactSteps(entry.steps);
    record.steps = steps;
    record.stepsTruncated = Array.isArray(entry.steps) && entry.steps.length > steps.length;
  }

  // Recorded outside the agentic branch as well, so a caller that captured the
  // model's words for any run can keep them.
  if (typeof entry.narrative === 'string' && entry.narrative.trim() !== '') {
    const text = entry.narrative;
    record.narrative = text.length > HISTORY_MAX_NARRATIVE_CHARS
      ? text.slice(0, HISTORY_MAX_NARRATIVE_CHARS)
      : text;
    record.narrativeTruncated = text.length > HISTORY_MAX_NARRATIVE_CHARS;
  }

  try {
    const file = historyPath(pathOverride);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (err) {
    warnOnce(`[history] cannot write run history: ${err?.message || err}`);
    return false;
  }
}

/**
 * Walk a file line by line without holding it in memory.
 *
 * Handles are read as bytes and split on the newline byte, so a multi-byte
 * character straddling a chunk boundary is carried to the next chunk intact
 * rather than decoded into a replacement character.
 */
function streamLines(file, onLine) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      const chunk = buf.subarray(0, read);
      const window = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let start = 0;
      for (let i = 0; i < window.length; i++) {
        if (window[i] === NEWLINE) {
          onLine(window.toString('utf8', start, i));
          start = i + 1;
        }
      }
      // Copy rather than retain a view: keeping a subarray of `buf` alive would
      // pin the whole chunk for the rest of the scan.
      carry = Buffer.from(window.subarray(start));
    }
    if (carry.length > 0) onLine(carry.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

/** Parse one stored line into an entry, or count it as malformed. */
function parseLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function countNewlines(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === NEWLINE) n++;
  return n;
}

/**
 * Read history newest-first. Malformed JSONL lines are skipped and counted.
 *
 * Scans the file once, keeping only the last `limit` records: a reader that
 * holds every record in order to slice the tail grows with the file, and this
 * one is read on every run. `total` and `skipped` still describe the whole
 * file, so a caller can tell a short page from a short history.
 */
export function readHistory(options = {}) {
  const limit = options.limit ?? HISTORY_DEFAULT_LIMIT;
  const file = historyPath(options.path);
  if (!existsSync(file)) return { entries: [], skipped: 0, total: 0 };
  const keep = Math.max(0, limit);
  const ring = new Array(keep);
  let seen = 0;
  let total = 0;
  let skipped = 0;
  try {
    streamLines(file, (line) => {
      if (line.trim() === '') return;
      const entry = parseLine(line);
      if (entry === null) {
        skipped++;
        return;
      }
      total++;
      if (keep === 0) return;
      entry.id = recordId(entry, line);
      ring[seen % keep] = entry;
      seen++;
    });
  } catch (err) {
    warnOnce(`[history] cannot read run history: ${err?.message || err}`);
    return { entries: [], skipped: 0, total: 0 };
  }
  const count = Math.min(seen, keep);
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push(ring[(seen - 1 - i) % keep]);
  }
  return { entries, skipped, total };
}

/**
 * The most recent `limit` records, read from the end of the file backwards.
 *
 * Grows a window from the end until it holds enough newlines to yield `limit`
 * whole records, then parses only that. Reports no totals, because producing
 * them would mean reading everything the caller just avoided. This is the path
 * for a UI page that wants the newest runs and not a census of them.
 */
export function readHistoryTail(limit = HISTORY_DEFAULT_LIMIT, pathOverride) {
  const file = historyPath(pathOverride);
  const keep = Math.max(0, limit);
  if (keep === 0 || !existsSync(file)) return [];
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    warnOnce(`[history] cannot read run history: ${err?.message || err}`);
    return [];
  }
  let buf;
  let start = 0;
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    let want = READ_CHUNK_BYTES;
    for (;;) {
      start = Math.max(0, size - want);
      const len = size - start;
      const raw = Buffer.allocUnsafe(len);
      if (len > 0) readSync(fd, raw, 0, len, start);
      buf = raw;
      if (start === 0) break;
      // One newline is spent on the fragment before the window's first record.
      if (countNewlines(buf) >= keep + 1) break;
      want *= 4;
    }
  } catch (err) {
    warnOnce(`[history] cannot read run history: ${err?.message || err}`);
    return [];
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  // A window that starts mid-file starts mid-line; that fragment is not a
  // record. Its bytes may also be a broken character, which is another reason
  // not to parse it.
  if (start > 0) lines.shift();
  const records = lines.filter((l) => l.trim() !== '').slice(-keep);
  records.reverse();
  const entries = [];
  for (const line of records) {
    const entry = parseLine(line);
    if (entry === null) continue;
    entry.id = recordId(entry, line);
    entries.push(entry);
  }
  return entries;
}

export function lastEntry(pathOverride) {
  const { entries } = readHistory({ limit: 1, path: pathOverride });
  return entries[0] || null;
}

/**
 * One record by its address.
 *
 * A full scan, because the file is appended to and a record's position is not
 * recorded anywhere. Streaming keeps the cost to one pass with constant memory,
 * and the list endpoint uses `readHistoryTail` precisely so that opening the UI
 * does not cost a scan. When the same id appears twice the newest wins, which
 * matches a reader's expectation that an address resolves to the latest record.
 */
export function findHistoryEntry(id, pathOverride) {
  if (!id) return null;
  const file = historyPath(pathOverride);
  if (!existsSync(file)) return null;
  let found = null;
  try {
    streamLines(file, (line) => {
      if (line.trim() === '') return;
      const entry = parseLine(line);
      if (entry === null) return;
      if (recordId(entry, line) === id) found = entry;
    });
  } catch {
    return null;
  }
  if (found) found.id = id;
  return found;
}

/**
 * Rerun guard: when the recorded preview was truncated (promptChars exceeds
 * what was stored), re-dispatch requires explicit confirmation.
 */
export function needsRerunConfirm(entry) {
  if (!entry) return false;
  return (entry.promptChars || 0) > HISTORY_PREVIEW_CHARS;
}
