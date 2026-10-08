import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunRegistry,
  POLICIES,
  validateStartRequest,
  normalizeStartRequest,
  historyRecordFor,
  narrativeOf
} from '../src/runs.mjs';
import { readHistory, readHistoryTail, findHistoryEntry, checkpointHistory, appendHistory } from '../src/history.mjs';
import { createLiveRun, applyLiveEvent } from '../src/blocks.mjs';
import { DEFAULT_MAX_TURNS, SEGMENT_TURNS } from '../src/turns.mjs';
import { HARNESS_DEFAULT_MAX_TURNS } from '../src/harness.mjs';

function tmpHistory() {
  return join(mkdtempSync(join(tmpdir(), 'zstack-runs-')), 'history.jsonl');
}

/**
 * The result `buildProgression` would produce for a set of events.
 *
 * Derived from the events rather than hard-coded, so a stub can never claim the
 * run did something its own event stream contradicts. A stub that disagrees
 * with itself tests the disagreement instead of the code.
 */
function resultFrom(events = [], overrides = {}) {
  const tools = events.filter((e) => e.type === 'tool');
  const done = events.find((e) => e.type === 'done');
  const accepted = (t) => t.outcome === 'ok' || t.outcome === 'dry-run';
  return {
    ok: true,
    exitCode: 0,
    turns: done?.turns ?? 0,
    toolCalls: tools.length,
    failedTools: tools.filter((t) => !accepted(t) && t.outcome !== 'declined').length,
    declinedTools: tools.filter((t) => t.outcome === 'declined').length,
    durationMs: done?.durationMs ?? 1200,
    model: 'opencode-go/deepseek-v4-pro',
    playbook: 'feature',
    role: 'feature, refactoring',
    workspaceDir: '/repo',
    usage: done?.tokens ? { total_tokens: done.tokens } : null,
    narrative: events.filter((e) => e.type === 'text').map((e) => e.text).join(''),
    steps: [{ kind: 'start', turn: 0, model: 'opencode-go/deepseek-v4-pro', workspace: '/repo' }],
    fileChanges: tools
      .filter((t) => accepted(t) && (t.name === 'write' || t.name === 'edit') && t.args?.file_path)
      .map((t) => ({ path: t.args.file_path, tool: t.name, turn: t.turn })),
    ...overrides
  };
}

/**
 * A stand-in for the SDK.
 *
 * The registry's job is folding events, recording, and fanning out to
 * subscribers. None of that needs a model, a harness, or a network, so the
 * tests drive it with a scripted `agent()` and stay hermetic.
 */
function stubZStack(script = {}) {
  const calls = [];
  const events = script.events || [];
  return {
    calls,
    async agent(options) {
      calls.push(options);
      if (script.beforeEvents) await script.beforeEvents(options);
      for (const event of events) {
        if (options.signal?.aborted) break;
        options.onEvent?.(event);
      }
      if (script.throw) {
        const err = new Error(script.throw);
        if (script.kind) err.kind = script.kind;
        throw err;
      }
      return script.result ?? resultFrom(events, options.workspaceDir ? { workspaceDir: options.workspaceDir } : {});
    }
  };
}

async function settled(registry, id, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = registry.get(id);
    if (run?.settled) return run;
    if (Date.now() > deadline) throw new Error(`run ${id} never settled (status ${run?.status})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const happyEvents = [
  { type: 'run-start', model: 'deepseek-v4-pro', provider: 'opencode-go', workspace: '/repo', playbook: 'feature' },
  { type: 'turn', turn: 1, tokens: 100 },
  { type: 'text', turn: 1, text: 'Looking at the file.' },
  { type: 'approval', tool: 'bash', decision: 'approved', risk: 'safe' },
  { type: 'tool', turn: 1, name: 'read', args: { file_path: 'main.js' }, outcome: 'ok', durationMs: 3 },
  { type: 'tool', turn: 1, name: 'write', args: { file_path: 'main.js' }, outcome: 'ok', durationMs: 9 },
  { type: 'done', turns: 1, tokens: 400, tools: 2, durationMs: 1200 }
];

describe('start request validation', () => {
  it('requires a prompt and rejects unknown lanes and policies', () => {
    assert.deepEqual(validateStartRequest({ prompt: 'do it' }), []);
    assert.match(validateStartRequest({}).join(' '), /needs a prompt/);
    assert.match(validateStartRequest({ prompt: '   ' }).join(' '), /needs a prompt/);
    assert.match(validateStartRequest({ prompt: 'x', lane: 'turbo' }).join(' '), /Unknown lane/);
    assert.match(validateStartRequest({ prompt: 'x', policy: 'yolo' }).join(' '), /Unknown policy/);
    assert.match(validateStartRequest({ prompt: 'x', maxTurns: 0 }).join(' '), /positive integer/);
    assert.match(validateStartRequest({ prompt: 'x', maxTurns: 2.5 }).join(' '), /positive integer/);
    assert.match(validateStartRequest({ prompt: 'x', apply: 'yes' }).join(' '), /must be a boolean/);
    assert.match(validateStartRequest({ prompt: 'x', autoPr: 'yes' }).join(' '), /must be a boolean/);
    assert.match(validateStartRequest({ prompt: 'x', pr: 'yes' }).join(' '), /must be a boolean/);
  });

  it('folds apply into a policy so there is one representation', () => {
    assert.equal(normalizeStartRequest({ prompt: 'x' }).policy, 'read-only');
    assert.equal(normalizeStartRequest({ prompt: 'x', apply: true }).policy, 'apply');
    assert.equal(normalizeStartRequest({ prompt: 'x', apply: false }).policy, 'read-only');
    assert.equal(normalizeStartRequest({ prompt: 'x', policy: 'strict' }).policy, 'strict');
    assert.equal(normalizeStartRequest({ prompt: 'x', autoPr: true }).autoPr, true);
    assert.equal(normalizeStartRequest({ prompt: 'x', pr: true }).autoPr, true);
    assert.equal(normalizeStartRequest({ prompt: 'x' }).autoPr, false);
    // The policy decides what the harness is actually told.
    assert.deepEqual(
      [normalizeStartRequest({ prompt: 'x', policy: 'apply' }).apply,
       normalizeStartRequest({ prompt: 'x', policy: 'apply' }).autoApproveSafe],
      [true, false]
    );
    assert.deepEqual(
      [normalizeStartRequest({ prompt: 'x' }).apply,
       normalizeStartRequest({ prompt: 'x' }).autoApproveSafe],
      [false, true]
    );
    assert.equal(normalizeStartRequest({ prompt: '  spaced  ' }).prompt, 'spaced');
  });

  it('publishes the three policies it can actually honour', () => {
    assert.deepEqual(Object.keys(POLICIES), ['read-only', 'apply', 'strict']);
    for (const preset of Object.values(POLICIES)) {
      assert.equal(typeof preset.apply, 'boolean');
      assert.equal(typeof preset.autoApproveSafe, 'boolean');
      assert.ok(preset.label);
    }
  });
});

describe('run registry', () => {
  it('returns an id before the run finishes and folds events into blocks', async () => {
    const zstack = stubZStack({ events: happyEvents });
    const registry = new RunRegistry({ zstack, historyPath: tmpHistory() });
    const run = registry.start({ prompt: 'Add a footer' });

    assert.ok(run.id, 'an id must exist before any model call');
    assert.equal(run.settled, false);

    const seen = [];
    registry.subscribe(run.id, (entry) => seen.push(entry));
    await settled(registry, run.id);

    const page = registry.getPage(run.id);
    assert.equal(page.status, 'ok');
    assert.equal(page.live, true);
    assert.equal(page.counts.toolCalls, 2);
    assert.equal(page.counts.fileChanges, 1);
    const kinds = page.blocks.map((b) => b.kind);
    assert.deepEqual(kinds, ['callout', 'divider', 'prose', 'approval', 'tool', 'tool', 'summary']);
    assert.match(page.blocks[0].text, /^Ran /);

    // Every subscriber entry is numbered, which is what makes a resume
    // possible. A subscriber that attaches after some events already happened
    // sees a suffix of the log, never a restarted count.
    const all = registry.replay(run.id, 0);
    assert.ok(seen.length > 0);
    assert.deepEqual(seen.map((e) => e.seq), seen.map((_, i) => seen[0].seq + i));
    assert.deepEqual(seen, all.slice(all.length - seen.length));
    assert.equal(seen.at(-1).type, 'end');
    assert.equal(all.at(-1).type, 'end');
  });

  it('replays only what a reconnecting client missed', async () => {
    const zstack = stubZStack({ events: happyEvents });
    const registry = new RunRegistry({ zstack, historyPath: tmpHistory() });
    const run = registry.start({ prompt: 'Reconnect me' });
    await settled(registry, run.id);

    const all = registry.replay(run.id, 0);
    assert.ok(all.length >= 5);

    // The guarantee: replaying from a sequence number yields exactly the
    // entries after it, with no gap and no duplicate.
    const cut = all[Math.floor(all.length / 2)].seq;
    const rest = registry.replay(run.id, cut);
    assert.deepEqual(rest.map((e) => e.seq), all.filter((e) => e.seq > cut).map((e) => e.seq));
    assert.deepEqual(rest, all.slice(all.findIndex((e) => e.seq === cut) + 1));

    // A client that saw everything gets nothing, and an unknown run is absent
    // rather than silently empty.
    assert.deepEqual(registry.replay(run.id, all.at(-1).seq), []);
    assert.equal(registry.replay('nope', 0), null);
  });

  it('records a UI run exactly where `zstack history` reads it', async () => {
    const historyPath = tmpHistory();
    const zstack = stubZStack({ events: happyEvents });
    const registry = new RunRegistry({ zstack, historyPath });
    const run = registry.start({ prompt: 'Add a footer comment to main.js', playbook: 'feature' });
    await settled(registry, run.id);

    const { entries, total } = readHistory({ path: historyPath });
    assert.equal(total, 1);
    const entry = entries[0];
    // The live page's URL must still resolve to the same run once archived.
    assert.equal(entry.id, run.id);
    assert.equal(entry.command, 'agent');
    assert.equal(entry.agentic, true);
    assert.equal(entry.ok, true);
    assert.equal(entry.turns, 1);
    assert.equal(entry.toolCalls, 2);
    assert.equal(entry.model, 'opencode-go/deepseek-v4-pro');
    assert.equal(entry.playbook, 'feature');
    assert.equal(entry.narrative, 'Looking at the file.');
    assert.equal(entry.promptChars, 'Add a footer comment to main.js'.length);
    assert.deepEqual(entry.fileChanges, [{ path: 'main.js', tool: 'write', turn: 1 }]);
    // The stored steps are the SDK's, so `zstack history --steps` renders them.
    assert.equal(entry.steps[0].kind, 'start');
    assert.equal(run.persisted, true);
  });

  it('passes the policy through to the SDK as the harness expects it', async () => {
    const zstack = stubZStack({ events: [] });
    const registry = new RunRegistry({ zstack, historyPath: tmpHistory() });

    await settled(registry, registry.start({ prompt: 'a', policy: 'apply', maxTurns: 4, lane: 'go' }).id);
    const applied = zstack.calls.at(-1);
    assert.equal(applied.apply, true);
    assert.equal(applied.autoApproveSafe, false);
    // One turn per call, whatever size the reader picked: that granularity is
    // what lets a pause land at the next boundary. The 4 they chose is the
    // run's size, not this call's budget.
    assert.equal(applied.maxTurns, SEGMENT_TURNS);
    assert.equal(applied.lane, 'go');

    await settled(registry, registry.start({ prompt: 'b' }).id);
    const readOnly = zstack.calls.at(-1);
    assert.equal(readOnly.apply, false);
    assert.equal(readOnly.autoApproveSafe, true);
    // Not left to the harness. Its own default is 8 turns, which is too tight
    // to finish real work, so zstack always sends a number it chose.
    assert.equal(readOnly.maxTurns, SEGMENT_TURNS);
    assert.ok(DEFAULT_MAX_TURNS > HARNESS_DEFAULT_MAX_TURNS);
  });

  it('reports a missing harness as a failed page, not a lost run', async () => {
    const historyPath = tmpHistory();
    const zstack = stubZStack({
      throw: 'The ModelHitch harness was not found.',
      kind: 'harness-missing'
    });
    const registry = new RunRegistry({ zstack, historyPath });
    const run = registry.start({ prompt: 'no harness' });
    await settled(registry, run.id);

    const page = registry.getPage(run.id);
    assert.equal(page.status, 'failed');
    assert.equal(page.tone, 'error');
    assert.match(page.blocks.at(-2).text, /harness was not found/);
    assert.equal(page.blocks.at(-1).label, 'Run failed');

    // A failed run is still recorded, with ok:false, so it shows in history.
    const entry = readHistory({ path: historyPath }).entries[0];
    assert.equal(entry.ok, false);
    assert.equal(entry.errorKind, 'harness-missing');
    assert.equal(entry.exitCode, 1);
  });

  it('cancels a run and says it was stopped rather than failed', async () => {
    const historyPath = tmpHistory();
    const zstack = stubZStack({
      beforeEvents: (options) =>
        new Promise((resolve) => {
          // Wait for the abort, then emit whatever events arrived first, which
          // is what a real killed process leaves behind.
          options.signal.addEventListener('abort', () => {
            options.onEvent?.({ type: 'turn', turn: 1, tokens: 10 });
            resolve();
          }, { once: true });
        }),
      result: { ok: false, exitCode: 1, turns: 1, toolCalls: 0 }
    });
    const registry = new RunRegistry({ zstack, historyPath });
    const run = registry.start({ prompt: 'long one' });

    assert.equal(registry.cancel(run.id), true);
    const settledRun = await settled(registry, run.id);
    assert.equal(settledRun.cancelled, true);

    const page = registry.getPage(run.id);
    assert.equal(page.status, 'cancelled');
    assert.equal(page.tone, 'neutral');
    assert.equal(page.blocks.at(-1).label, 'Run stopped');
    assert.match(page.blocks.at(-2).text, /Stopped on request/);

    // Stopping is not failing, and history must not record it as one.
    const entry = readHistory({ path: historyPath }).entries[0];
    assert.equal(entry.ok, false);
    assert.equal(entry.errorKind, 'cancelled');
    assert.equal(registry.cancel(run.id), false, 'a settled run cannot be cancelled twice');
  });

  it('refuses an invalid request instead of starting a run', () => {
    const registry = new RunRegistry({ zstack: stubZStack({}), historyPath: tmpHistory() });
    assert.throws(() => registry.start({ prompt: '' }), /needs a prompt/);
    assert.throws(() => registry.start({ prompt: 'x', lane: 'nope' }), /Unknown lane/);
    assert.equal(registry.order.length, 0, 'a rejected request must not leave a run behind');
  });

  it('lists live runs newest first with a card shape', async () => {
    const registry = new RunRegistry({ zstack: stubZStack({ events: [] }), historyPath: tmpHistory() });
    const first = registry.start({ prompt: 'first run' });
    const second = registry.start({ prompt: 'second run' });
    await settled(registry, first.id);
    await settled(registry, second.id);

    const cards = registry.listLive();
    assert.equal(cards.length, 2);
    assert.equal(cards[0].id, second.id);
    assert.equal(cards[0].title, 'second run');
    assert.equal(cards[0].badge, 'agent');
    assert.equal(cards[0].live, false);
    assert.equal(cards[0].applied, false);
  });

  it('retains a bounded number of finished runs', async () => {
    const registry = new RunRegistry({
      zstack: stubZStack({ events: [] }),
      historyPath: tmpHistory(),
      maxRetained: 3
    });
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const run = registry.start({ prompt: `run ${i}` });
      ids.push(run.id);
      await settled(registry, run.id);
    }
    assert.equal(registry.runs.size, 3);
    assert.equal(registry.get(ids[0]), null);
    assert.ok(registry.get(ids[5]), 'the newest run is always still addressable');
  });

  it('drops subscribers on shutdown so open streams cannot hang', async () => {
    const registry = new RunRegistry({ zstack: stubZStack({ events: [] }), historyPath: tmpHistory() });
    const run = registry.start({ prompt: 'held open' });
    const seen = [];
    registry.subscribe(run.id, (entry) => seen.push(entry));
    await settled(registry, run.id);
    registry.shutdown();
    assert.equal(seen.at(-1).type, 'shutdown');
    assert.equal(registry.get(run.id).subscribers.size, 0);
  });

  it('opens a pull request when autoPr is requested and changes exist', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'zstack-pr-test-'));
    const zstack = stubZStack({ events: happyEvents });
    let prHead = null;
    let gitPushed = false;
    const fakeGitExec = (cmd, args, opts, cb) => {
      if (cmd === 'git' && args[0] === 'push') {
        gitPushed = true;
        cb(null, 'pushed\n', '');
      } else if (cmd === 'git' && args[0] === 'remote') {
        cb(null, 'origin\n', '');
      } else if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        cb(null, 'true\n', '');
      } else if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        cb(null, `${repoDir}\n`, '');
      } else if (cmd === 'git' && args[0] === 'status' && args.includes('-b')) {
        cb(null, '## main...origin/main\n', '');
      } else if (cmd === 'gh' && args[0] === 'pr') {
        prHead = args[args.indexOf('--head') + 1];
        cb(null, 'https://github.com/my-org/my-repo/pull/77\n', '');
      } else {
        cb(null, 'ok\n', '');
      }
    };
    const registry = new RunRegistry({
      zstack,
      historyPath: tmpHistory(),
      gitExecFile: fakeGitExec
    });
    const run = registry.start({
      prompt: 'Add toggle for PR',
      policy: 'apply',
      autoPr: true,
      workspaceDir: repoDir
    });
    await settled(registry, run.id);

    const page = registry.getPage(run.id);
    assert.equal(run.prError, undefined);
    assert.equal(page.status, 'ok');
    assert.equal(run.prUrl, 'https://github.com/my-org/my-repo/pull/77');
    assert.equal(page.prUrl, 'https://github.com/my-org/my-repo/pull/77');
    assert.ok(page.blocks.some((b) => b.kind === 'notice' && b.text.includes('Pull request opened: https://github.com/my-org/my-repo/pull/77')));
    assert.ok(gitPushed);
    assert.match(prHead, /^zstack\/add-toggle-for-pr/);
  });

  it('skips auto-PR when no file changes occurred', async () => {
    const zstack = stubZStack({ events: [] });
    const registry = new RunRegistry({ zstack, historyPath: tmpHistory() });
    const run = registry.start({
      prompt: 'Check something',
      policy: 'apply',
      autoPr: true
    });
    await settled(registry, run.id);

    const page = registry.getPage(run.id);
    assert.equal(run.prUrl, undefined);
    assert.ok(page.blocks.some((b) => b.kind === 'notice' && b.text.includes('Auto-PR skipped: run made no file changes.')));
  });
});

describe('turn budgets', () => {
  /**
   * A previous run in the shape the registry or history hands one back.
   *
   * The defaults describe the case the whole feature exists for: a run that
   * spent its budget, saved its session, and left a record saying so.
   */
  function previousRun(overrides = {}) {
    return {
      id: 'run-prev',
      prompt: 'Add a footer',
      playbook: 'feature',
      sessionId: 'session-1',
      maxTurns: DEFAULT_MAX_TURNS,
      turns: DEFAULT_MAX_TURNS,
      turnLimitReached: true,
      workspace: '/repo',
      ...overrides
    };
  }

  it('continues a saved session as a new run linked to the old one', async () => {
    const historyPath = tmpHistory();
    const zstack = stubZStack({
      events: happyEvents,
      result: resultFrom(happyEvents, { sessionId: 'session-2' })
    });
    const registry = new RunRegistry({ zstack, historyPath });

    const next = registry.continueRun(previousRun(), {});
    // The earlier run is not modified: it stopped where it stopped, and that is
    // what happened. The continuation is a new run with its own id that points
    // back at it, never a second attempt under the same id.
    assert.notEqual(next.id, 'run-prev');
    await settled(registry, next.id);

    const call = zstack.calls.at(-1);
    // `resume` is what makes this a continuation rather than a rerun: the
    // harness restores the prior history from the session id.
    assert.equal(call.resume, 'session-1');
    // Without this the run would have no session of its own, so a run that runs
    // out twice could not be continued the second time.
    assert.equal(call.saveSession, true);

    const page = registry.getPage(next.id);
    assert.equal(page.continuationOf, previousRun().id);
    assert.equal(page.turnBudget.sessionId, 'session-2');

    // Both facts live on the request the run was started with, which is what
    // the registry hands to `historyRecordFor` when the run is recorded. Held
    // here rather than only read back from the file, so a continuation is
    // still testable as a continuation when history storage changes shape.
    assert.equal(next.request.continuationOf, 'run-prev');
    assert.equal(next.request.resume, 'session-1');
    // And the continuation is recorded at all: a second run that never reached
    // history would be work the reader cannot see.
    const entry = readHistory({ path: historyPath }).entries[0];
    assert.equal(entry.id, next.id);
    assert.equal(entry.turns, 1);
  });

  it('gives the continuation a bigger size unless told otherwise', async () => {
    const zstack = stubZStack({ events: [] });
    const registry = new RunRegistry({ zstack, historyPath: tmpHistory() });

    // The size lives on the run's own request, not on the harness call: every
    // call is one turn, so asserting the call's budget would assert nothing
    // about what the reader asked for.
    const doubled = registry.continueRun(previousRun(), {});
    await settled(registry, doubled.id);
    // Continuing at the size that just ran out would stop in the same place,
    // which is the failure mode the feature exists to avoid.
    assert.equal(doubled.request.maxTurns, DEFAULT_MAX_TURNS * 2);
    // And it resumes the previous session rather than restarting the task.
    assert.equal(zstack.calls.at(-1).resume, previousRun().sessionId);

    const explicit = registry.continueRun(previousRun(), { maxTurns: 120 });
    await settled(registry, explicit.id);
    assert.equal(explicit.request.maxTurns, 120);

    // A preset name is a size too, and resolves to the number the UI offered.
    const preset = registry.continueRun(previousRun(), { maxTurns: 'deep' });
    await settled(registry, preset.id);
    assert.equal(preset.request.maxTurns, 60);

    // A run from before sizes were recorded still gets the default rather than
    // a doubling of nothing, which would be zero turns.
    const legacy = registry.continueRun(previousRun({ maxTurns: null }), {});
    await settled(registry, legacy.id);
    assert.equal(legacy.request.maxTurns, DEFAULT_MAX_TURNS);
  });

  it('refuses a run that cannot be resumed instead of rerunning it', () => {
    const zstack = stubZStack({ events: [] });
    const registry = new RunRegistry({ zstack, historyPath: tmpHistory() });

    // Rerunning the original task under a "continue" label is a worse lie than
    // refusing, so a record with no session is a hard stop.
    assert.throws(
      () => registry.continueRun(previousRun({ sessionId: null })),
      (err) => err.kind === 'not-resumable' && /no saved session/.test(err.message)
    );
    // A caller holding an id this registry never saw is told so, not handed a
    // phantom run.
    assert.throws(() => registry.continueRun(null), (err) => err.kind === 'unknown-run');

    assert.equal(registry.order.length, 0, 'a refused continuation must not leave a run behind');
    assert.equal(zstack.calls.length, 0);
  });

  it('rejects an unusable budget rather than substituting the default', () => {
    const zstack = stubZStack({ events: [] });
    const registry = new RunRegistry({ zstack, historyPath: tmpHistory() });

    try {
      registry.continueRun(previousRun(), { maxTurns: 'lots' });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.kind, 'invalid-request');
      // The problems array is what the HTTP layer reports verbatim, so a thrown
      // message without one would reach the browser as a bare 500.
      assert.ok(Array.isArray(err.problems) && err.problems.length === 1);
      assert.match(err.problems[0], /positive integer/);
    }

    // Zero is the other boundary: it is a number, so it looks like a choice,
    // and the harness would quietly fall back to its own 8 turns.
    assert.throws(
      () => registry.continueRun(previousRun(), { maxTurns: 0 }),
      (err) => err.kind === 'invalid-request' && err.problems.some((p) => /positive integer/.test(p))
    );

    assert.equal(registry.order.length, 0, 'a run started with a substituted budget would be a lie');
    assert.equal(zstack.calls.length, 0);
  });

  it('lands the continuation in the same project under the same policy', async () => {
    const historyPath = tmpHistory();
    const zstack = stubZStack({ events: [] });
    const registry = new RunRegistry({ zstack, historyPath });

    const inProject = registry.continueRun(previousRun({ projectId: 'p-1', policy: 'apply' }), {});
    await settled(registry, inProject.id);
    const call = zstack.calls.at(-1);
    // A write-enabled run continued as read-only would decline its own work and
    // report the task as unfinished for the wrong reason.
    assert.equal(call.apply, true);
    assert.equal(call.autoApproveSafe, false);
    // The project id and a workspace path are two answers to one question: the
    // server resolves the directory from the project and faults on both.
    assert.equal(call.workspaceDir, undefined);

    const entry = readHistory({ path: historyPath }).entries[0];
    assert.equal(entry.projectId, 'p-1');
    assert.equal(inProject.request.policy, 'apply');

    // Without a project the workspace is the place, and it must not be lost.
    await settled(
      registry,
      registry.continueRun(previousRun({ policy: 'apply', projectId: null }), {}).id
    );
    assert.equal(zstack.calls.at(-1).workspaceDir, '/repo');
  });

  it('sends an instruction to carry on, never the original prompt again', async () => {
    const zstack = stubZStack({ events: [] });
    const registry = new RunRegistry({ zstack, historyPath: tmpHistory() });

    await settled(registry, registry.continueRun(previousRun(), { prompt: 'Finish the footer' }).id);
    assert.equal(zstack.calls.at(-1).prompt, 'Finish the footer');

    await settled(registry, registry.continueRun(previousRun(), {}).id);
    const derived = zstack.calls.at(-1).prompt;
    // The harness has the original prompt in the session it is restoring, so
    // repeating it would ask the model to start the task over.
    assert.notEqual(derived, previousRun().prompt);
    assert.match(derived, /Carry on/);
    // It says why a second run exists and what the first one spent, so the
    // record is readable on its own.
    assert.match(derived, new RegExp(`${DEFAULT_MAX_TURNS} turn budget`));

    // A prompt that is only whitespace is not a prompt, and must not become one.
    await settled(registry, registry.continueRun(previousRun(), { prompt: '   ' }).id);
    assert.match(zstack.calls.at(-1).prompt, /Carry on/);
  });
});

describe('history record shape', () => {
  it('builds the same fields the CLI writes', () => {
    const live = createLiveRun({ id: 'run-9', prompt: 'do a thing' });
    live.model = 'opencode-go/deepseek-v4-pro';
    live.workspace = '/repo';
    applyLiveEvent(live, { type: 'turn', turn: 2, tokens: 50 });
    live.endedAt = live.startedAt + 1500;

    const request = normalizeStartRequest({ prompt: 'do a thing', apply: true, files: ['a.js'] });
    const record = historyRecordFor(request, { ok: true, exitCode: 0 }, live);

    assert.equal(record.id, 'run-9');
    assert.equal(record.command, 'agent');
    assert.equal(record.applied, true);
    assert.equal(record.ok, true);
    assert.equal(record.turns, 2);
    assert.equal(record.workspace, '/repo');
    assert.equal(record.durationMs, 1500);
    assert.equal(record.promptChars, 10);
    assert.deepEqual(record.files, ['a.js']);
    assert.equal(record.narrative, '');
  });

  it('collects the model narrative from the run blocks', () => {
    const live = createLiveRun({ id: 'run-10', prompt: 'p' });
    applyLiveEvent(live, { type: 'turn', turn: 1, tokens: 1 });
    applyLiveEvent(live, { type: 'text', turn: 1, text: 'First part.' });
    applyLiveEvent(live, { type: 'turn', turn: 2, tokens: 1 });
    applyLiveEvent(live, { type: 'text', turn: 2, text: 'Second part.' });
    assert.equal(narrativeOf(live), 'First part.\n\nSecond part.');
  });

  it('keeps the budget, the session, and what a run continues', () => {
    const live = createLiveRun({ id: 'run-11', prompt: 'Carry on' });
    const request = normalizeStartRequest({
      prompt: 'Carry on',
      maxTurns: 'deep',
      resume: 'session-1',
      continuationOf: 'run-prev'
    });
    const record = historyRecordFor(
      request,
      { ok: true, exitCode: 0, maxTurns: 60, sessionId: 'session-2', turnLimitReached: true },
      live
    );

    // What a run was allowed is a fact about that run and nothing else records
    // it, so it is stored rather than recomputed from the preset later.
    assert.equal(record.maxTurns, 60);
    assert.equal(record.sessionId, 'session-2');
    assert.equal(record.continuationOf, 'run-prev');
    // Without this flag the question "did it stop early?" is unanswerable from
    // history, and the reader is left guessing whether the work was finished.
    assert.equal(record.turnLimitReached, true);

    // A run that stopped on its own terms carries no limit flag: the key is
    // undefined so JSON drops it, and its absence is what "not cut short" means.
    const plain = historyRecordFor(normalizeStartRequest({ prompt: 'one shot' }), { ok: true }, live);
    assert.equal(plain.turnLimitReached, undefined);
    assert.equal(plain.maxTurns, DEFAULT_MAX_TURNS, 'the budget zstack chose is recorded even when the caller named none');
    // An ordinary run continues nothing and resumed nothing, and saying so
    // beats a missing field a reader has to interpret.
    assert.equal(plain.sessionId, null);
    assert.equal(plain.continuationOf, null);
  });
});


describe('durable run progress', () => {
  it('recovers a forcibly killed owner with partial prose, tools and project intact', async () => {
    const historyPath = tmpHistory();
    const moduleUrl = new URL('../src/runs.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { RunRegistry } from ${JSON.stringify(moduleUrl)};
      const registry = new RunRegistry({ historyPath: process.argv[1], zstack: {
        async agent(options) {
          options.onEvent({ type: 'run-start', model: 'test', workspace: '/repo' });
          options.onEvent({ type: 'turn', turn: 1, tokens: 100 });
          options.onEvent({ type: 'text', turn: 1, text: 'Work in progress.' });
          options.onEvent({ type: 'tool', turn: 1, name: 'write', args: { file_path: 'partial.txt' }, outcome: 'ok', output: 'private successful body' });
          options.onEvent({ type: 'tool', turn: 1, name: 'bash', args: { command: 'check' }, outcome: 'error', output: 'check failed' });
          setInterval(() => {}, 1000);
          process.send({ id: registry.order[0] });
          await new Promise(() => {});
        }
      }});
      registry.start({ prompt: 'Finish the task', projectId: 'project-1', policy: 'apply' });
    `, historyPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    try {
      const [{ id }] = await once(child, 'message');
      assert.equal(readHistory({ path: historyPath }).entries.length, 0, 'a live owner is not recovered');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const records = readHistoryTail(10, historyPath);
      assert.equal(records.length, 1);
      const record = records[0];
      assert.equal(record.id, id);
      assert.equal(record.ok, false);
      assert.equal(record.errorKind, 'interrupted');
      assert.equal(record.narrative, 'Work in progress.');
      assert.equal(record.turns, 1);
      assert.equal(record.toolCalls, 2);
      assert.equal(record.projectId, 'project-1');
      assert.equal(record.policy, 'apply');
      assert.equal(record.steps.filter(s => s.kind === 'tool').length, 2);
      assert.equal(record.steps.at(-1).output, 'check failed');
      assert.ok(!JSON.stringify(record).includes('private successful body'));
      assert.equal(record.fileChanges[0].path, 'partial.txt');
      assert.match(record.error, /recovered/);
      assert.equal(findHistoryEntry(id, historyPath).id, id);
      assert.equal(readHistory({ path: historyPath }).total, 1, 'repeated recovery does not duplicate');
      assert.deepEqual(readdirSync(historyPath + '.active'), []);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('saves partial progress synchronously on shutdown even if the SDK never settles', async () => {
    const historyPath = tmpHistory();
    const registry = new RunRegistry({ historyPath, zstack: {
      async agent(options) {
        options.onEvent({ type: 'turn', turn: 1 });
        options.onEvent({ type: 'text', turn: 1, text: 'Partial answer' });
        await new Promise(() => {});
      }
    }});
    const run = registry.start({ prompt: 'Work' });
    registry.shutdown();
    const record = findHistoryEntry(run.id, historyPath);
    assert.equal(record.errorKind, 'interrupted');
    assert.equal(record.narrative, 'Partial answer');
    assert.equal(record.steps[0].kind, 'turn');
    assert.ok(run.controller.signal.aborted);
    assert.throws(() => registry.start({ prompt: 'Late admission' }), /shutting down/);
    assert.throws(() => registry.resume(run.id), /shutting down/);
  });

  it('preserves progression when the harness throws before returning its steps', async () => {
    const historyPath = tmpHistory();
    const registry = new RunRegistry({ historyPath, zstack: stubZStack({ events: happyEvents.slice(0, -1), throw: 'Harness died' }) });
    const run = registry.start({ prompt: 'Work' });
    await settled(registry, run.id);
    const record = findHistoryEntry(run.id, historyPath);
    assert.equal(record.steps.filter(s => s.kind === 'tool').length, 2);
    assert.equal(record.narrative, 'Looking at the file.');
    assert.deepEqual(readdirSync(historyPath + '.active'), []);
  });
});


it('claims recovery across processes and preserves truncation flags', async () => {
  const historyPath = tmpHistory();
  const finished = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(finished, 'exit');
  const id = 'interrupted-capped-run';
  checkpointHistory({ id, command: 'agent', ok: false,
    steps: Array.from({ length: 205 }, (_, i) => ({ kind: 'turn', turn: i })),
    narrative: 'x'.repeat(13000) }, historyPath);
  const file = join(historyPath + '.active', readdirSync(historyPath + '.active')[0]);
  const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
  checkpoint.pid = finished.pid;
  writeFileSync(file, JSON.stringify(checkpoint));
  const moduleUrl = new URL('../src/history.mjs', import.meta.url).href;
  const readers = Array.from({ length: 3 }, () => spawn(process.execPath, ['--input-type=module', '-e', `
    import { readHistory } from ${JSON.stringify(moduleUrl)};
    readHistory({ path: process.argv[1] });
  `, historyPath], { stdio: 'ignore' }));
  const exits = await Promise.all(readers.map(child => once(child, 'exit')));
  assert.ok(exits.every(([code]) => code === 0));
  const history = readHistory({ path: historyPath });
  assert.equal(history.total, 1);
  assert.equal(history.entries[0].stepsTruncated, true);
  assert.equal(history.entries[0].narrativeTruncated, true);
  assert.deepEqual(readdirSync(historyPath + '.active'), []);
});

it('does not overwrite a final archive if the owner died before checkpoint cleanup', async () => {
  const historyPath = tmpHistory();
  const finished = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(finished, 'exit');
  const id = 'already-archived';
  checkpointHistory({ id, command: 'agent', ok: false }, historyPath);
  const file = join(historyPath + '.active', readdirSync(historyPath + '.active')[0]);
  const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
  checkpoint.pid = finished.pid;
  writeFileSync(file, JSON.stringify(checkpoint));
  appendHistory({ id, command: 'agent', ok: true, narrative: 'Finished' }, historyPath);
  const history = readHistory({ path: historyPath });
  assert.equal(history.total, 1);
  assert.equal(history.entries[0].ok, true);
  assert.deepEqual(readdirSync(historyPath + '.active'), []);
});
