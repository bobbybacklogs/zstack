import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HISTORY_PREVIEW_CHARS = 200;
export const HISTORY_DEFAULT_LIMIT = 20;

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
