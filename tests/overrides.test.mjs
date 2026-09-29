import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readOverrides,
  validateRunPatch,
  patchRunOverride,
  hideRun,
  unhideRun,
  getOverride,
  applyOverride,
  overridesPath,
  OVERRIDE_TITLE_MAX
} from '../src/overrides.mjs';

function tmpStore() {
  return join(mkdtempSync(join(tmpdir(), 'zstack-ovr-')), 'run-overrides.json');
}

describe('override validation', () => {
  it('refuses a non-object and an empty patch', () => {
    assert.ok(validateRunPatch(null).some((p) => p.includes('JSON object')));
    assert.ok(validateRunPatch([]).some((p) => p.includes('JSON object')));
    assert.ok(validateRunPatch({}).some((p) => p.includes('Nothing to change')));
  });

  it('reports every problem at once', () => {
    const long = 'x'.repeat(OVERRIDE_TITLE_MAX + 1);
    const problems = validateRunPatch(
      { title: long, projectId: '', hidden: 'yes', bogus: 1 },
      { projects: [] }
    );
    assert.ok(problems.some((p) => p.includes('at most')));
    assert.ok(problems.some((p) => p.includes('projectId')));
    assert.ok(problems.some((p) => p.includes('hidden')));
    assert.ok(problems.some((p) => p.includes('Unknown field')));
    assert.ok(problems.length >= 4);
  });

  it('checks a move target against known projects', () => {
    assert.deepEqual(validateRunPatch({ projectId: 'p-1' }, { projects: ['p-1'] }), []);
    const problems = validateRunPatch({ projectId: 'p-nope' }, { projects: ['p-1'] });
    assert.ok(problems.some((p) => p.includes('No project with id p-nope')));
  });

  it('accepts a function as the project vocabulary', () => {
    const known = { projects: (id) => id === 'p-1' };
    assert.deepEqual(validateRunPatch({ projectId: 'p-1' }, known), []);
    assert.ok(validateRunPatch({ projectId: 'p-2' }, known).length > 0);
  });

  it('allows null as an explicit detach, and a null title as a clear', () => {
    assert.deepEqual(validateRunPatch({ projectId: null }), []);
    assert.deepEqual(validateRunPatch({ title: null }), []);
    assert.deepEqual(validateRunPatch({ title: '' }), []);
  });
});

describe('override storage', () => {
  let store;
  beforeEach(() => {
    store = tmpStore();
  });

  it('starts empty and honours the env override', () => {
    const doc = readOverrides(store);
    assert.deepEqual(doc.overrides, {});
    assert.equal(doc.corrupted, false);
    assert.equal(overridesPath(store), store);
  });

  it('stores a rename and a move', () => {
    const saved = patchRunOverride('r-1', { title: '  New name  ', projectId: 'p-1' }, store);
    assert.equal(saved.title, 'New name');
    assert.equal(saved.projectId, 'p-1');
    assert.ok(typeof saved.updatedAt === 'string');
    assert.equal(getOverride('r-1', store).title, 'New name');
  });

  it('clearing the last field removes the override', () => {
    patchRunOverride('r-1', { title: 'Name' }, store);
    const cleared = patchRunOverride('r-1', { title: '' }, store);
    assert.equal(cleared, null);
    assert.equal(getOverride('r-1', store), null);
  });

  it('hides and unhides without touching the other fields', () => {
    patchRunOverride('r-1', { title: 'Name' }, store);
    hideRun('r-1', store);
    assert.equal(getOverride('r-1', store).hidden, true);
    assert.equal(getOverride('r-1', store).title, 'Name');
    unhideRun('r-1', store);
    assert.equal(getOverride('r-1', store).hidden, undefined);
    assert.equal(getOverride('r-1', store).title, 'Name');
  });

  it('rejects a bad patch without writing anything', () => {
    assert.throws(
      () => patchRunOverride('r-1', { projectId: 'p-nope' }, store, { projects: ['p-1'] }),
      (err) => err.kind === 'invalid-patch'
        && err.problems.some((p) => p.includes('No project with id'))
    );
    assert.equal(getOverride('r-1', store), null);
  });

  it('tolerates a corrupted file', () => {
    writeFileSync(store, '{ not json', 'utf8');
    const doc = readOverrides(store);
    assert.deepEqual(doc.overrides, {});
    assert.equal(doc.corrupted, true);
  });

  it('the file on disk holds only overrides that do something', () => {
    patchRunOverride('r-1', { title: 'Name' }, store);
    const parsed = JSON.parse(readFileSync(store, 'utf8'));
    assert.equal(parsed.overrides['r-1'].title, 'Name');
    patchRunOverride('r-1', { title: '' }, store);
    const after = JSON.parse(readFileSync(store, 'utf8'));
    assert.ok(!('r-1' in after.overrides));
  });
});

describe('applyOverride', () => {
  it('returns the entry untouched when there is no override', () => {
    const entry = { id: 'r-1', projectId: 'p-1' };
    assert.equal(applyOverride(entry, null), entry);
    assert.deepEqual(applyOverride(entry, {}), entry);
  });

  it('never mutates its input', () => {
    const entry = { id: 'r-1', projectId: 'p-1' };
    const out = applyOverride(entry, { title: 'X', projectId: 'p-2', hidden: true });
    assert.equal(entry.projectId, 'p-1');
    assert.ok(!('customTitle' in entry));
    assert.equal(out.customTitle, 'X');
    assert.equal(out.projectId, 'p-2');
    assert.equal(out.hidden, true);
  });

  it('a null projectId detaches the run', () => {
    const out = applyOverride({ id: 'r-1', projectId: 'p-1' }, { projectId: null });
    assert.equal(out.projectId, null);
  });

  it('ignores an empty stored title', () => {
    const out = applyOverride({ id: 'r-1' }, { title: '' });
    assert.ok(!('customTitle' in out));
  });
});
