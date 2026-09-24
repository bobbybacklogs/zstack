import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendHistory,
  readHistory,
  lastEntry,
  needsRerunConfirm,
  resetHistoryWarnings,
  HISTORY_PREVIEW_CHARS
} from '../src/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'bin', 'zstack.mjs');
const run = promisify(execFile);

function tmpHistory() {
  return join(mkdtempSync(join(tmpdir(), 'zstack-hist-')), 'history.jsonl');
}

describe('task run history', () => {
  it('appends exactly one line per run', () => {
    const file = tmpHistory();
    resetHistoryWarnings();
    assert.equal(appendHistory({ command: 'task', playbook: 'bug-fix', promptPreview: 'fix it', promptChars: 6 }, file), true);
    assert.equal(appendHistory({ command: 'panel', promptPreview: 'review this', promptChars: 11 }, file), true);
    const { entries, skipped, total } = readHistory({ path: file });
    assert.equal(total, 2);
    assert.equal(skipped, 0);
    assert.equal(entries.length, 2);
  });

  it('returns newest entries first honoring --limit', () => {
    const file = tmpHistory();
    for (let i = 0; i < 5; i++) {
      appendHistory({ command: 'task', promptPreview: `prompt ${i}`, promptChars: 8 }, file);
    }
    const { entries, total } = readHistory({ path: file, limit: 2 });
    assert.equal(total, 5);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].promptPreview, 'prompt 4');
    assert.equal(entries[1].promptPreview, 'prompt 3');
  });

  it('skips malformed JSONL lines and counts them', () => {
    const file = tmpHistory();
    appendHistory({ command: 'task', promptPreview: 'good', promptChars: 4 }, file);
    appendFileSync(file, 'not json {{{\n', 'utf8');
    appendFileSync(file, '\n', 'utf8');
    const { entries, skipped, total } = readHistory({ path: file });
    assert.equal(total, 1);
    assert.equal(skipped, 1);
    assert.equal(entries[0].promptPreview, 'good');
  });

  it('truncates previews to 200 chars and guards reruns', () => {
    const file = tmpHistory();
    const long = 'x'.repeat(500);
    appendHistory({ command: 'prompt', promptPreview: long, promptChars: 500 }, file);
    const last = lastEntry(file);
    assert.equal(last.promptPreview.length, HISTORY_PREVIEW_CHARS);
    assert.equal(last.promptChars, 500);
    assert.equal(needsRerunConfirm(last), true);
    assert.equal(needsRerunConfirm({ promptChars: 50 }), false);
  });

  it('records non-zero runs with ok:false and warns on unwritable paths', () => {
    const file = tmpHistory();
    appendHistory({ command: 'task', promptPreview: 'boom', promptChars: 4, ok: false, errorKind: 'timeout', exitCode: 3 }, file);
    const { entries } = readHistory({ path: file });
    assert.equal(entries[0].ok, false);
    assert.equal(entries[0].errorKind, 'timeout');
    assert.equal(entries[0].exitCode, 3);

    resetHistoryWarnings();
    const bad = join(tmpdir(), `nul-\0-byte-${Date.now()}`, 'h.jsonl');
    assert.equal(appendHistory({ command: 'task', promptPreview: 'x' }, bad), false);
    assert.equal(appendHistory({ command: 'task', promptPreview: 'x' }, bad), false);
  });

  it('lists history as JSON via the CLI', async () => {
    const file = tmpHistory();
    const env = { ...process.env, ZSTACK_HISTORY_PATH: file };
    await run(process.execPath, [CLI, 'task', 'feature', 'history cli probe', '--json', '--no-prune', '--context-budget', '1'], { cwd: ROOT, env }).catch(() => {});
    const { stdout } = await run(process.execPath, [CLI, 'history', '--json'], { cwd: ROOT, env });
    const doc = JSON.parse(stdout);
    assert.equal(doc.ok, true);
    assert.ok(doc.total >= 1);
    assert.ok(doc.entries[0].promptPreview.includes('history cli probe'));
  });

  it('requires --yes to rerun a truncated preview', async () => {
    const file = tmpHistory();
    const env = { ...process.env, ZSTACK_HISTORY_PATH: file };
    appendHistory({ command: 'prompt', playbook: 'feature', promptPreview: 'y'.repeat(200), promptChars: 500 }, file);
    try {
      await run(process.execPath, [CLI, 'history', '--last', '--rerun', '--json'], { cwd: ROOT, env });
      assert.fail('must refuse without --yes');
    } catch (err) {
      assert.equal(err.code, 2, `want exit 2, got ${err.code}`);
      assert.match(JSON.parse(err.stdout).error, /incomplete/);
    }
  });
});
