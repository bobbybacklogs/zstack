/**
 * Run overrides: rename, move, and delete without rewriting history.
 *
 * `history.jsonl` is append-only. A reader trusts that what it read yesterday
 * reads the same tomorrow, and a writer that edits lines in place breaks that
 * trust along with every byte offset, hash id, and tail window built on top.
 * So a rename, a move to another project, or a deletion never touches the
 * history file. It writes a small sidecar record instead, keyed by run id,
 * and every projection applies the sidecar on top of the stored record.
 *
 * Three operations, one shape:
 *
 * - `title` replaces the derived page title. Empty clears it.
 * - `projectId` re-attaches the run to another project (or null to detach).
 * - `hidden` removes the run from lists without deleting its record.
 *
 * A hidden run is still addressable by id: hiding is a list concern, not
 * erasure. The record stays on disk and the page still resolves, which is
 * what keeps "delete" honest about what it does.
 *
 * Storage mirrors `projects.mjs` deliberately: a JSON file next to history,
 * written atomically (write then rename), tolerant of corruption. Two modules
 * with the same storage shape is duplication worth keeping, because merging
 * them would make the projects module own run concerns and this one own
 * project concerns.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function overridesPath(pathOverride) {
  return (
    pathOverride ||
    process.env.ZSTACK_OVERRIDES_PATH ||
    join(homedir(), '.zstack', 'run-overrides.json')
  );
}

/** Longest custom title kept. Mirrors the derived title cap. */
export const OVERRIDE_TITLE_MAX = 120;

function blankStore() {
  return { version: 1, overrides: {} };
}

function writeStore(file, overrides) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, overrides }, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/**
 * Read the store, tolerating a missing or corrupted file.
 *
 * Corruption yields an empty store rather than throwing, for the same reason
 * as projects: overrides are advisory presentation, and losing them must
 * never take down the server that also serves runs.
 */
export function readOverrides(pathOverride) {
  const file = overridesPath(pathOverride);
  if (!existsSync(file)) return { overrides: {}, corrupted: false, path: file };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { overrides: {}, corrupted: true, path: file };
  }
  const raw = parsed && typeof parsed === 'object'
    ? (parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : parsed)
    : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { overrides: {}, corrupted: true, path: file };
  }
  const overrides = {};
  for (const [id, item] of Object.entries(raw)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const clean = cleanOverride(item);
    if (clean) overrides[id] = clean;
  }
  return { overrides, corrupted: false, path: file };
}

/** Normalize one stored override, or null when it carries nothing. */
function cleanOverride(item) {
  const out = {};
  if (typeof item.title === 'string' && item.title.trim() !== '') {
    out.title = item.title.trim().slice(0, OVERRIDE_TITLE_MAX);
  }
  if (item.projectId === null) out.projectId = null;
  else if (typeof item.projectId === 'string' && item.projectId.trim() !== '') {
    out.projectId = item.projectId.trim();
  }
  if (item.hidden === true) out.hidden = true;
  if (typeof item.updatedAt === 'string' && item.updatedAt !== '') out.updatedAt = item.updatedAt;
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Validate a patch at the boundary.
 *
 * Returns every problem rather than the first, so a form can report them in
 * one response. `known` optionally carries `projects` (an array of ids or a
 * function of id to boolean) to check a move target against; without it the
 * target is checked for shape only and resolved later.
 */
export function validateRunPatch(input = {}, known = {}) {
  const problems = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return ['The patch must be a JSON object.'];
  }
  const keys = Object.keys(input);
  if (keys.length === 0) problems.push('Nothing to change.');
  for (const key of keys) {
    if (!['title', 'projectId', 'hidden'].includes(key)) {
      problems.push(`Unknown field "${key}".`);
    }
  }
  if (input.title !== undefined && input.title !== null && typeof input.title !== 'string') {
    problems.push('A title must be a string.');
  } else if (typeof input.title === 'string' && input.title.trim().length > OVERRIDE_TITLE_MAX) {
    problems.push(`A title is at most ${OVERRIDE_TITLE_MAX} characters.`);
  }
  if (input.projectId !== undefined && input.projectId !== null) {
    if (typeof input.projectId !== 'string' || input.projectId.trim() === '') {
      problems.push('projectId must be a project id or null.');
    } else if (known.projects !== undefined) {
      const exists = typeof known.projects === 'function'
        ? known.projects(input.projectId.trim())
        : known.projects.includes(input.projectId.trim());
      if (!exists) problems.push(`No project with id ${input.projectId.trim()}.`);
    }
  }
  if (input.hidden !== undefined && typeof input.hidden !== 'boolean') {
    problems.push('hidden must be a boolean.');
  }
  return problems;
}

/**
 * Apply a patch to one run's override. Throws with `kind: 'invalid-patch'`
 * and `problems` when the input is bad, or `kind: 'unknown-run'` when the
 * caller requires the run to exist and it does not.
 *
 * Writing a patch that changes nothing removes the override instead of
 * storing an empty one, so the file holds only overrides that do something.
 * Clearing the last field of an override deletes the override.
 */
export function patchRunOverride(id, input = {}, pathOverride, known = {}) {
  const problems = validateRunPatch(input, known);
  if (problems.length > 0) {
    const err = new Error(problems.join(' '));
    err.kind = 'invalid-patch';
    err.problems = problems;
    throw err;
  }
  // The existence check runs after validation, so a malformed patch for a
  // missing run still reports what is wrong with the patch rather than
  // masking it behind a 404.
  if (typeof known.mustExist === 'function' && !known.mustExist(id)) {
    const err = new Error(`No run with id ${id}.`);
    err.kind = 'unknown-run';
    throw err;
  }
  const { overrides } = readOverrides(pathOverride);
  const current = overrides[id] || {};
  const next = { ...current };
  if (input.title !== undefined) {
    const flat = typeof input.title === 'string' ? input.title.trim() : '';
    if (flat === '') delete next.title;
    else next.title = flat.slice(0, OVERRIDE_TITLE_MAX);
  }
  if (input.projectId !== undefined) {
    if (input.projectId === null) next.projectId = null;
    else next.projectId = input.projectId.trim();
  }
  if (input.hidden !== undefined) {
    if (input.hidden) next.hidden = true;
    else delete next.hidden;
  }
  const now = new Date().toISOString();
  if (Object.keys(next).filter((k) => k !== 'updatedAt').length === 0) {
    delete overrides[id];
  } else {
    next.updatedAt = now;
    overrides[id] = next;
  }
  writeStore(overridesPath(pathOverride), overrides);
  return overrides[id] || null;
}

/** Hide a run from lists. The record stays; the page still resolves. */
export function hideRun(id, pathOverride) {
  return patchRunOverride(id, { hidden: true }, pathOverride);
}

/** Un-hide a run. */
export function unhideRun(id, pathOverride) {
  return patchRunOverride(id, { hidden: false }, pathOverride);
}

/** The override for one run, or null. */
export function getOverride(id, pathOverride) {
  if (!id) return null;
  return readOverrides(pathOverride).overrides[id] || null;
}

/**
 * A stored record with its override applied.
 *
 * Returns the record unchanged when there is no override, and never mutates
 * its input: callers pass entries they do not own. A null projectId detaches
 * the run; otherwise the override's project wins. A custom title is exposed
 * as `customTitle` alongside, so the projection can prefer it while still
 * knowing the derived one.
 */
export function applyOverride(entry, override) {
  if (!entry || typeof entry !== 'object') return entry;
  if (!override || typeof override !== 'object') return entry;
  const out = { ...entry };
  if (typeof override.title === 'string' && override.title !== '') {
    out.customTitle = override.title;
  }
  if (override.projectId !== undefined) {
    out.projectId = override.projectId;
  }
  if (override.hidden === true) out.hidden = true;
  return out;
}

export { blankStore };
