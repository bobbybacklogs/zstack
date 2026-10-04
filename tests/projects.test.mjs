import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProject,
  updateProject,
  deleteProject,
  findProject,
  readProjects,
  validateProject,
  projectRecord,
  newProjectId,
  projectsPath
} from '../src/projects.mjs';
import { MAX_MAX_TURNS } from '../src/turns.mjs';

function tmpStore() {
  return join(mkdtempSync(join(tmpdir(), 'zstack-proj-')), 'projects.json');
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'zstack-projdir-'));
}

describe('project validation', () => {
  it('requires a name and a directory', () => {
    const problems = validateProject({}, []);
    assert.ok(problems.some((p) => p.includes('name')));
    assert.ok(problems.some((p) => p.includes('directory')));
  });

  it('reports every problem at once', () => {
    const other = tmpDir();
    const problems = validateProject(
      { name: '', dir: join(tmpdir(), 'zstack-no-such-dir-xyz') },
      [{ id: 'p-1', name: 'Site', dir: other }]
    );
    assert.ok(problems.length >= 2);
  });

  it('refuses a path that is not a directory', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'zstack-projf-')), 'note.txt');
    writeFileSync(file, 'x', 'utf8');
    const problems = validateProject({ name: 'Site', dir: file }, []);
    assert.ok(problems.some((p) => p.includes('not a directory')));
  });

  it('refuses a missing directory', () => {
    const problems = validateProject(
      { name: 'Site', dir: join(tmpdir(), 'zstack-no-such-dir-xyz') },
      []
    );
    assert.ok(problems.some((p) => p.includes('does not exist')));
  });

  it('refuses a duplicate name case-insensitively', () => {
    const dir = tmpDir();
    const problems = validateProject({ name: 'site', dir }, [{ id: 'p-1', name: 'Site', dir }]);
    assert.ok(problems.some((p) => p.includes('already exists')));
  });

  it('allows the same project to keep its own name on update', () => {
    const dir = tmpDir();
    const problems = validateProject(
      { id: 'p-1', name: 'Site', dir },
      [{ id: 'p-1', name: 'Site', dir }]
    );
    assert.deepEqual(problems, []);
  });

  it('caps the name at 80 characters', () => {
    const problems = validateProject({ name: 'x'.repeat(81), dir: tmpDir() }, []);
    assert.ok(problems.some((p) => p.includes('80')));
  });
});

describe('project lifecycle', () => {
  let store;
  beforeEach(() => {
    store = tmpStore();
  });

  it('creates a project with a resolved directory', () => {
    const dir = tmpDir();
    const project = createProject({ name: ' Site ', dir }, store);
    assert.ok(project.id.startsWith('p-'));
    assert.equal(project.name, 'Site');
    assert.equal(project.dir, dir);
    assert.ok(project.createdAt);
    assert.ok(project.updatedAt);
  });

  it('rejects a bad create with every problem', () => {
    try {
      createProject({ name: '', dir: '' }, store);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.kind, 'invalid-project');
      assert.ok(Array.isArray(err.problems) && err.problems.length >= 2);
    }
  });

  it('renames without changing the id', () => {
    const created = createProject({ name: 'Site', dir: tmpDir() }, store);
    const updated = updateProject(created.id, { name: 'Storefront' }, store);
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, 'Storefront');
    assert.equal(updated.createdAt, created.createdAt);
  });

  it('re-points the directory', () => {
    const created = createProject({ name: 'Site', dir: tmpDir() }, store);
    const other = tmpDir();
    const updated = updateProject(created.id, { dir: other }, store);
    assert.equal(updated.dir, other);
  });

  it('reports an unknown id on update and delete', () => {
    assert.throws(() => updateProject('p-nope', { name: 'x' }, store), (err) => err.kind === 'unknown-project');
    assert.throws(() => deleteProject('p-nope', store), (err) => err.kind === 'unknown-project');
  });

  it('deletes a project and returns it', () => {
    const created = createProject({ name: 'Site', dir: tmpDir() }, store);
    const deleted = deleteProject(created.id, store);
    assert.equal(deleted.id, created.id);
    assert.equal(findProject(created.id, store), null);
  });

  it('finds a project by id and misses on unknown', () => {
    const created = createProject({ name: 'Site', dir: tmpDir() }, store);
    assert.equal(findProject(created.id, store).name, 'Site');
    assert.equal(findProject(null, store), null);
    assert.equal(findProject('p-nope', store), null);
  });

  it('reads an empty store from a missing file', () => {
    const doc = readProjects(store);
    assert.deepEqual(doc.projects, []);
    assert.equal(doc.corrupted, false);
  });

  it('tolerates a corrupted file', () => {
    writeFileSync(store, '{not json', 'utf8');
    const doc = readProjects(store);
    assert.deepEqual(doc.projects, []);
    assert.equal(doc.corrupted, true);
  });

  it('tolerates a file with the wrong shape', () => {
    writeFileSync(store, JSON.stringify({ version: 1 }), 'utf8');
    const doc = readProjects(store);
    assert.deepEqual(doc.projects, []);
    assert.equal(doc.corrupted, true);
  });

  it('skips malformed entries but keeps the valid ones', () => {
    const dir = tmpDir();
    writeFileSync(
      store,
      JSON.stringify({ version: 1, projects: [null, { id: '', name: 'x', dir }, { id: 'p-keep', name: 'Keep', dir }] }),
      'utf8'
    );
    const doc = readProjects(store);
    assert.equal(doc.projects.length, 1);
    assert.equal(doc.projects[0].id, 'p-keep');
  });

  it('projectsPath honours the override, then the env var', () => {
    assert.equal(projectsPath('/tmp/x.json'), '/tmp/x.json');
    const prev = process.env.ZSTACK_PROJECTS_PATH;
    process.env.ZSTACK_PROJECTS_PATH = '/tmp/env.json';
    try {
      assert.equal(projectsPath(), '/tmp/env.json');
    } finally {
      if (prev === undefined) delete process.env.ZSTACK_PROJECTS_PATH;
      else process.env.ZSTACK_PROJECTS_PATH = prev;
    }
  });
});

describe('project ids and records', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newProjectId()));
    assert.equal(ids.size, 50);
  });

  it('projectRecord resolves the directory and keeps the existing id', () => {
    const dir = tmpDir();
    const record = projectRecord({ name: 'Site', dir }, { id: 'p-keep', createdAt: 'then' });
    assert.equal(record.id, 'p-keep');
    assert.equal(record.dir, dir);
    assert.equal(record.createdAt, 'then');
  });

  it('creates the parent directory on write', () => {
    const nested = join(mkdtempSync(join(tmpdir(), 'zstack-projn-')), 'a', 'b', 'projects.json');
    const project = createProject({ name: 'Site', dir: tmpDir() }, nested);
    assert.equal(findProject(project.id, nested).name, 'Site');
  });
});

describe('project defaults', () => {
  let store;
  beforeEach(() => {
    store = tmpStore();
  });

  const known = { playbooks: ['feature', 'bug-fix'], policies: ['read-only', 'apply', 'strict'] };

  it('stores defaults on create', () => {
    const project = createProject(
      { name: 'Site', dir: tmpDir(), defaultPlaybook: 'feature', defaultPolicy: 'apply', defaultAutoPr: true },
      store,
      known
    );
    assert.equal(project.defaultPlaybook, 'feature');
    assert.equal(project.defaultPolicy, 'apply');
    assert.equal(project.defaultAutoPr, true);
    assert.equal(findProject(project.id, store).defaultPolicy, 'apply');
    assert.equal(findProject(project.id, store).defaultAutoPr, true);
  });

  it('defaults are null when not given', () => {
    const project = createProject({ name: 'Site', dir: tmpDir() }, store, known);
    assert.equal(project.defaultPlaybook, null);
    assert.equal(project.defaultPolicy, null);
    assert.equal(project.defaultAutoPr, null);
  });

  it('refuses a non-boolean defaultAutoPr', () => {
    assert.throws(
      () => createProject({ name: 'Site', dir: tmpDir(), defaultAutoPr: 'yes' }, store, known),
      (err) => err.kind === 'invalid-project' && err.problems.some((p) => p.includes('Default auto-PR must be a boolean.'))
    );
  });

  it('refuses an unknown playbook and an unknown policy, together', () => {
    try {
      createProject(
        { name: 'Site', dir: tmpDir(), defaultPlaybook: 'nope', defaultPolicy: 'yolo' },
        store,
        known
      );
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.kind, 'invalid-project');
      assert.ok(err.problems.some((p) => p.includes('Unknown playbook')));
      assert.ok(err.problems.some((p) => p.includes('Unknown policy')));
    }
  });

  it('skips the membership check when the server knows no playbooks', () => {
    const project = createProject(
      { name: 'Site', dir: tmpDir(), defaultPlaybook: 'feature' },
      store,
      { playbooks: [], policies: ['read-only'] }
    );
    assert.equal(project.defaultPlaybook, 'feature');
  });

  it('updates and clears defaults without touching name or dir', () => {
    const created = createProject(
      { name: 'Site', dir: tmpDir(), defaultPlaybook: 'feature', defaultPolicy: 'apply' },
      store,
      known
    );
    const updated = updateProject(
      created.id,
      { defaultPlaybook: 'bug-fix', defaultPolicy: '' },
      store,
      known
    );
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, 'Site');
    assert.equal(updated.dir, created.dir);
    assert.equal(updated.defaultPlaybook, 'bug-fix');
    assert.equal(updated.defaultPolicy, null);
  });

  it('rejects a bad default on update', () => {
    const created = createProject({ name: 'Site', dir: tmpDir() }, store, known);
    assert.throws(
      () => updateProject(created.id, { defaultPolicy: 'yolo' }, store, known),
      (err) => err.kind === 'invalid-project'
        && err.problems.some((p) => p.includes('Unknown policy'))
    );
  });

  it('reads defaults from an older file that lacks them', () => {
    const dir = tmpDir();
    writeFileSync(
      store,
      JSON.stringify({ version: 1, projects: [{ id: 'p-old', name: 'Old', dir }] }),
      'utf8'
    );
    const doc = readProjects(store);
    assert.equal(doc.projects[0].defaultPlaybook, null);
    assert.equal(doc.projects[0].defaultPolicy, null);
  });

  it('projectRecord keeps existing defaults unless told otherwise', () => {
    const record = projectRecord(
      { name: 'Site', dir: tmpDir() },
      { id: 'p-keep', defaultPlaybook: 'feature', defaultPolicy: 'strict' }
    );
    assert.equal(record.defaultPlaybook, 'feature');
    assert.equal(record.defaultPolicy, 'strict');
  });

  it('stores a default turn budget as a number', () => {
    const project = createProject(
      { name: 'Site', dir: tmpDir(), defaultMaxTurns: 60 },
      store,
      known
    );
    assert.equal(project.defaultMaxTurns, 60);
    // Stored as a number, not the text a form sent, so a run started from this
    // project does not have to resolve it a second time.
    const stored = findProject(project.id, store);
    assert.equal(stored.defaultMaxTurns, 60);
    assert.equal(typeof stored.defaultMaxTurns, 'number');
  });

  it('resolves a preset name on write, so the file holds a budget and not a label', () => {
    const project = createProject(
      { name: 'Site', dir: tmpDir(), defaultMaxTurns: 'deep' },
      store,
      known
    );
    assert.equal(project.defaultMaxTurns, 60);
    // A preset is renamed or retuned eventually; a stored number keeps meaning
    // what the user chose when they chose it.
    assert.equal(readProjects(store).projects[0].defaultMaxTurns, 60);
  });

  it('stores no budget when the form was left blank or the file predates the field', () => {
    const blank = createProject({ name: 'Site', dir: tmpDir(), defaultMaxTurns: '' }, store, known);
    assert.equal(blank.defaultMaxTurns, null);

    // An older file never had the field, and "absent" has to read as "no
    // preference" rather than as a zero the run endpoint would refuse.
    const dir = tmpDir();
    writeFileSync(
      store,
      JSON.stringify({ version: 1, projects: [{ id: 'p-old', name: 'Old', dir }] }),
      'utf8'
    );
    assert.equal(readProjects(store).projects[0].defaultMaxTurns, null);
  });

  it('refuses a turn budget that starting a run would reject', () => {
    try {
      createProject({ name: 'Site', dir: tmpDir(), defaultMaxTurns: 'lots' }, store, known);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.kind, 'invalid-project');
      // The message has to name the field: a form posting several defaults at
      // once would otherwise report a fault the reader cannot place.
      assert.ok(err.problems.some((p) => /default turn budget/i.test(p)));
      assert.ok(err.problems.some((p) => p.includes('positive integer')));
    }

    // The ceiling is the run endpoint's, so a stored default is never a value
    // that starting a run from this project would refuse.
    assert.throws(
      () => createProject({ name: 'Site', dir: tmpDir(), defaultMaxTurns: MAX_MAX_TURNS + 1 }, store, known),
      (err) => err.kind === 'invalid-project'
        && err.problems.some((p) => p.includes(`at most ${MAX_MAX_TURNS}`))
    );
    assert.equal(createProject({ name: 'Site', dir: tmpDir(), defaultMaxTurns: MAX_MAX_TURNS }, store, known).defaultMaxTurns, MAX_MAX_TURNS);
  });

  it('sets and clears the turn budget on update', () => {
    const created = createProject({ name: 'Site', dir: tmpDir(), defaultMaxTurns: 60 }, store, known);

    const raised = updateProject(created.id, { defaultMaxTurns: 'marathon' }, store, known);
    assert.equal(raised.defaultMaxTurns, 200);
    assert.equal(raised.name, 'Site', 'changing the budget must not touch the name');

    // Clearing is how the dialog says "no preference". An empty string and an
    // explicit null both have to work, or a JSON client is a special case.
    assert.equal(updateProject(created.id, { defaultMaxTurns: '' }, store, known).defaultMaxTurns, null);
    assert.equal(updateProject(created.id, { defaultMaxTurns: null }, store, known).defaultMaxTurns, null);

    // An update that never mentions the budget leaves the stored one alone,
    // because a rename must not silently reset a setting the user chose.
    updateProject(created.id, { defaultMaxTurns: 120 }, store, known);
    assert.equal(
      updateProject(created.id, { name: 'Storefront' }, store, known).defaultMaxTurns,
      120
    );
  });

  it('rejects a bad turn budget on update and keeps the stored one', () => {
    const created = createProject({ name: 'Site', dir: tmpDir(), defaultMaxTurns: 60 }, store, known);
    assert.throws(
      () => updateProject(created.id, { defaultMaxTurns: 'lots' }, store, known),
      (err) => err.kind === 'invalid-project'
        && err.problems.some((p) => /default turn budget/i.test(p))
    );
    assert.equal(findProject(created.id, store).defaultMaxTurns, 60, 'a refused update must change nothing');
  });
});
