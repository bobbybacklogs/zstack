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

describe('agentic run history', () => {
  it('persists progression, not just the invocation', () => {
    const file = tmpHistory();
    appendHistory({
      command: 'agent',
      playbook: 'feature',
      role: 'feature, refactoring',
      model: 'opencode-go/deepseek-v4-pro',
      durationMs: 1200,
      usage: { total_tokens: 400 },
      promptChars: 12,
      promptPreview: 'do a thing',
      ok: true,
      applied: true,
      workspace: 'C:/proj',
      turns: 3,
      toolCalls: 5,
      failedTools: 1,
      declinedTools: 2,
      changes: [{ name: 'edit', added: 4, removed: 1 }],
      fileChanges: [{ path: 'src/app.ts', tool: 'edit', turn: 2 }],
      steps: [
        { kind: 'start', turn: 0, model: 'opencode-go/deepseek-v4-pro', workspace: 'C:/proj' },
        { kind: 'turn', turn: 1, tokens: 100 },
        { kind: 'tool', turn: 1, name: 'bash', target: 'ls -la', outcome: 'ok', durationMs: 5 },
        { kind: 'approval', tool: 'bash', decision: 'approved', risk: 'safe' },
        { kind: 'tool', turn: 2, name: 'edit', target: 'src/app.ts', outcome: 'ok', durationMs: 7 }
      ]
    }, file);

    const { entries } = readHistory({ path: file });
    assert.equal(entries.length, 1);
    const entry = entries[0];

    assert.equal(entry.agentic, true);
    assert.equal(entry.applied, true);
    assert.equal(entry.workspace, 'C:/proj');
    assert.equal(entry.turns, 3);
    assert.equal(entry.toolCalls, 5);
    assert.equal(entry.declinedTools, 2);
    assert.deepEqual(entry.fileChanges, [{ path: 'src/app.ts', tool: 'edit', turn: 2 }]);
    assert.equal(entry.stepsTruncated, false);
    assert.equal(entry.steps.length, 5);

    // The approval's tool name and the start step's model must survive, or the
    // stored steps render as "approval undefined" and "run started: default".
    const approval = entry.steps.find((s) => s.kind === 'approval');
    assert.equal(approval.tool, 'bash');
    assert.equal(approval.decision, 'approved');
    const start = entry.steps.find((s) => s.kind === 'start');
    assert.equal(start.model, 'opencode-go/deepseek-v4-pro');
  });

  it('caps stored steps and says so', () => {
    const file = tmpHistory();
    const steps = Array.from({ length: 250 }, (_, i) => ({
      kind: 'tool',
      turn: 1,
      name: 'bash',
      target: `cmd-${i}`,
      outcome: 'ok'
    }));
    appendHistory({ command: 'agent', promptPreview: 'many steps', ok: true, steps }, file);

    const { entries } = readHistory({ path: file });
    assert.equal(entries[0].steps.length, 200);
    assert.equal(entries[0].stepsTruncated, true);
    assert.equal(entries[0].steps[0].target, 'cmd-0');
    assert.equal(entries[0].steps[199].target, 'cmd-199');
  });

  it('leaves a single-completion run unmarked as agentic', () => {
    const file = tmpHistory();
    appendHistory({ command: 'task', playbook: 'feature', promptPreview: 'plain', ok: true }, file);
    const { entries } = readHistory({ path: file });

    assert.equal(entries[0].agentic, undefined);
    assert.equal(entries[0].steps, undefined);
    assert.equal(entries[0].fileChanges, undefined);
  });

  it('renders steps through the CLI view', async () => {
    const file = tmpHistory();
    const env = { ...process.env, ZSTACK_HISTORY_PATH: file };
    appendHistory({
      command: 'agent',
      playbook: 'feature',
      model: 'opencode-go/deepseek-v4-pro',
      promptChars: 9,
      promptPreview: 'step view',
      ok: true,
      applied: true,
      workspace: 'C:/proj',
      turns: 2,
      toolCalls: 1,
      fileChanges: [{ path: 'src/app.ts', tool: 'edit', turn: 1 }],
      steps: [
        { kind: 'start', turn: 0, model: 'opencode-go/deepseek-v4-pro', workspace: 'C:/proj' },
        { kind: 'turn', turn: 1, tokens: 50 },
        { kind: 'tool', turn: 1, name: 'edit', target: 'src/app.ts', outcome: 'ok', durationMs: 4 },
        { kind: 'approval', tool: 'edit', decision: 'approved', risk: 'safe' }
      ]
    }, file);

    const { stdout } = await run(process.execPath, [CLI, 'history', '--steps', '--limit', '1'], { cwd: ROOT, env });

    assert.match(stdout, /run started: opencode-go\/deepseek-v4-pro in C:\/proj/);
    assert.match(stdout, /turn 1 \(50 tokens\)/);
    assert.match(stdout, /· turn 1: edit src\/app\.ts {2}\[ok, 4ms\]/);
    assert.match(stdout, /approval edit: approved \(safe\)/);
    assert.match(stdout, /changed 1 file: src\/app\.ts/);
    // No stored step may render as an undefined field.
    assert.doesNotMatch(stdout, /undefined/);
  });

  it('hints at --steps only when an agentic run is present', async () => {
    const plain = tmpHistory();
    appendHistory({ command: 'task', promptPreview: 'plain run', ok: true }, plain);
    const plainOut = await run(process.execPath, [CLI, 'history'], {
      cwd: ROOT,
      env: { ...process.env, ZSTACK_HISTORY_PATH: plain }
    });
    assert.doesNotMatch(plainOut.stdout, /Add --steps/);

    const agentic = tmpHistory();
    appendHistory({ command: 'agent', promptPreview: 'agent run', ok: true, steps: [] }, agentic);
    const agenticOut = await run(process.execPath, [CLI, 'history'], {
      cwd: ROOT,
      env: { ...process.env, ZSTACK_HISTORY_PATH: agentic }
    });
    assert.match(agenticOut.stdout, /Add --steps to expand/);
  });
});
