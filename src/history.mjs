import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HISTORY_PREVIEW_CHARS = 200;
export const HISTORY_DEFAULT_LIMIT = 20;

/**
 * Steps persisted per agentic run.
 *
 * A run can produce hundreds of events, and history is read back in full to
 * render the progression view. Capping keeps one long run from bloating the
 * file, and `stepsTruncated` says so rather than letting a reader mistake a
 * capped list for the whole run.
 */
export const HISTORY_MAX_STEPS = 200;

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
  if (entry.agentic || entry.command === 'agent') {
    record.agentic = true;
    record.applied = entry.applied === true;
    record.workspace = entry.workspace || null;
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
 * Read history newest-first. Malformed JSONL lines are skipped and counted.
 */
export function readHistory(options = {}) {
  const limit = options.limit ?? HISTORY_DEFAULT_LIMIT;
  const file = historyPath(options.path);
  if (!existsSync(file)) return { entries: [], skipped: 0, total: 0 };
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0);
  } catch (err) {
    warnOnce(`[history] cannot read run history: ${err?.message || err}`);
    return { entries: [], skipped: 0, total: 0 };
  }
  const entries = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  entries.reverse(); // newest first
  const total = entries.length;
  return { entries: entries.slice(0, Math.max(0, limit)), skipped, total };
}

export function lastEntry(pathOverride) {
  const { entries } = readHistory({ limit: 1, path: pathOverride });
  return entries[0] || null;
}

/**
 * Rerun guard: when the recorded preview was truncated (promptChars exceeds
 * what was stored), re-dispatch requires explicit confirmation.
 */
export function needsRerunConfirm(entry) {
  if (!entry) return false;
  return (entry.promptChars || 0) > HISTORY_PREVIEW_CHARS;
}
