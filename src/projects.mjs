/**
 * Projects: named directories that own runs.
 *
 * A run already carries a `workspace` string, which is where it happened, but
 * nothing groups runs by where they belong. A project is that grouping: a name
 * the user picks, a directory it points at, and an id everything else refers
 * to. Runs record a `projectId` alongside their `workspace`, and the UI lists
 * projects as areas that hold their runs, the way an editor sidebar lists the
 * folders you actually work in.
 *
 * Storage is a JSON file next to history, deliberately boring. Projects are
 * created by a human pointing at a folder, not by the hundred, so a database
 * would be machinery without a load. The file is written atomically (write then
 * rename) because a server killed mid-write must leave the previous file intact
 * rather than a half-written one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function projectsPath(pathOverride) {
  return (
    pathOverride ||
    process.env.ZSTACK_PROJECTS_PATH ||
    join(homedir(), '.zstack', 'projects.json')
  );
}

/** A short id for a project. */
export function newProjectId() {
  return `p-${randomBytes(6).toString('hex')}`;
}

function blankStore() {
  return { version: 1, projects: [] };
}

/**
 * Read the store, tolerating a missing or corrupted file.
 *
 * A corrupted file yields an empty store rather than throwing, because the
 * projects list is advisory: losing it must never take down the server that
 * also serves runs. The corruption is reported to the caller so it can say so.
 */
export function readProjects(pathOverride) {
  const file = projectsPath(pathOverride);
  if (!existsSync(file)) return { projects: [], corrupted: false, path: file };
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { projects: [], corrupted: true, path: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { projects: [], corrupted: true, path: file };
  }
  const list = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(list)) return { projects: [], corrupted: true, path: file };
  const projects = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || item.id === '') continue;
    if (typeof item.name !== 'string' || item.name.trim() === '') continue;
    if (typeof item.dir !== 'string' || item.dir === '') continue;
    projects.push({
      id: item.id,
      name: item.name,
      dir: item.dir,
      defaultPlaybook: typeof item.defaultPlaybook === 'string' && item.defaultPlaybook !== ''
        ? item.defaultPlaybook
        : null,
      defaultPolicy: typeof item.defaultPolicy === 'string' && item.defaultPolicy !== ''
        ? item.defaultPolicy
        : null,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    });
  }
  return { projects, corrupted: false, path: file };
}

function writeStore(file, projects) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/**
 * Validate a project name and directory at the boundary.
 *
 * Returns every problem rather than the first, so a form can report them in
 * one response instead of one per attempt.
 *
 * `known` carries the vocabularies the defaults are checked against: playbook
 * ids the server knows and the policy names the registry honours. Passed in
 * rather than imported because this module owns storage, not the registry's
 * policy table or the playbook catalogue.
 */
export function validateProject(input = {}, existing = [], known = {}) {
  const problems = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') problems.push('A project needs a name.');
  else if (name.length > 80) problems.push('A project name is at most 80 characters.');

  const dir = typeof input.dir === 'string' ? input.dir.trim() : '';
  if (dir === '') {
    problems.push('A project needs a directory.');
  } else {
    let resolved;
    try {
      resolved = resolve(dir);
    } catch {
      resolved = null;
    }
    if (!resolved) {
      problems.push(`"${dir}" is not a usable path.`);
    } else {
      try {
        const info = statSync(resolved);
        if (!info.isDirectory()) problems.push(`"${resolved}" is not a directory.`);
      } catch {
        problems.push(`"${resolved}" does not exist or cannot be read.`);
      }
    }
  }

  const clash = existing.find(
    (p) => p.id !== input.id && p.name.toLowerCase() === name.toLowerCase()
  );
  if (clash) problems.push(`A project named "${name}" already exists.`);

  // Defaults are advisory, so unknown values fault rather than silently
  // falling back: a default that does nothing is a control that lies. An
  // empty string clears the default, which is how the dialog reports "no
  // preference" without a separate flag.
  if (input.defaultPlaybook !== undefined && input.defaultPlaybook !== null && input.defaultPlaybook !== '') {
    if (typeof input.defaultPlaybook !== 'string') {
      problems.push('A default playbook must be a playbook id.');
      // An empty catalogue means the server loaded nothing, not that no
      // playbook exists. Checking membership against it would refuse every
      // default, so the check runs only when there is something to check
      // against.
    } else if (Array.isArray(known.playbooks) && known.playbooks.length > 0 && !known.playbooks.includes(input.defaultPlaybook)) {
      problems.push(`Unknown playbook "${input.defaultPlaybook}".`);
    }
  }
  if (input.defaultPolicy !== undefined && input.defaultPolicy !== null && input.defaultPolicy !== '') {
    if (typeof input.defaultPolicy !== 'string') {
      problems.push('A default policy must be a policy name.');
    } else if (Array.isArray(known.policies) && !known.policies.includes(input.defaultPolicy)) {
      problems.push(`Unknown policy "${input.defaultPolicy}". Valid policies: ${known.policies.join(', ')}.`);
    }
  }
  return problems;
}

/** Empty-ish values do not survive: a default is either a value or absent. */
function cleanDefault(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The canonical shape of one stored project. */
export function projectRecord(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || newProjectId(),
    name: input.name.trim(),
    dir: resolve(input.dir.trim()),
    defaultPlaybook: input.defaultPlaybook !== undefined
      ? cleanDefault(input.defaultPlaybook)
      : (existing.defaultPlaybook ?? null),
    defaultPolicy: input.defaultPolicy !== undefined
      ? cleanDefault(input.defaultPolicy)
      : (existing.defaultPolicy ?? null),
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

/**
 * Create a project. Throws with `kind: 'invalid-project'` and `problems` when
 * the input is bad, so the HTTP layer can report every fault at once.
 */
export function createProject(input = {}, pathOverride, known = {}) {
  const { projects } = readProjects(pathOverride);
  const problems = validateProject(input, projects, known);
  if (problems.length > 0) {
    const err = new Error(problems.join(' '));
    err.kind = 'invalid-project';
    err.problems = problems;
    throw err;
  }
  const record = projectRecord(input);
  writeStore(projectsPath(pathOverride), [...projects, record]);
  return record;
}

/**
 * Rename, re-point, or re-default a project. The id never changes, because
 * runs refer to it: renaming a project must not orphan everything it owns.
 */
export function updateProject(id, input = {}, pathOverride, known = {}) {
  const { projects } = readProjects(pathOverride);
  const current = projects.find((p) => p.id === id);
  if (!current) {
    const err = new Error(`No project with id ${id}.`);
    err.kind = 'unknown-project';
    throw err;
  }
  const merged = {
    id,
    name: input.name !== undefined ? input.name : current.name,
    dir: input.dir !== undefined ? input.dir : current.dir,
    defaultPlaybook: input.defaultPlaybook !== undefined ? input.defaultPlaybook : current.defaultPlaybook,
    defaultPolicy: input.defaultPolicy !== undefined ? input.defaultPolicy : current.defaultPolicy
  };
  const problems = validateProject(merged, projects, known);
  if (problems.length > 0) {
    const err = new Error(problems.join(' '));
    err.kind = 'invalid-project';
    err.problems = problems;
    throw err;
  }
  const record = projectRecord(merged, current);
  writeStore(
    projectsPath(pathOverride),
    projects.map((p) => (p.id === id ? record : p))
  );
  return record;
}

/**
 * Delete a project. The runs it owned stay in history with their `projectId`,
 * so deleting a project never deletes work. They simply list under no project
 * until they are re-attached elsewhere.
 */
export function deleteProject(id, pathOverride) {
  const { projects } = readProjects(pathOverride);
  const current = projects.find((p) => p.id === id);
  if (!current) {
    const err = new Error(`No project with id ${id}.`);
    err.kind = 'unknown-project';
    throw err;
  }
  writeStore(
    projectsPath(pathOverride),
    projects.filter((p) => p.id !== id)
  );
  return current;
}

export function findProject(id, pathOverride) {
  if (!id) return null;
  const { projects } = readProjects(pathOverride);
  return projects.find((p) => p.id === id) || null;
}

export { blankStore };
