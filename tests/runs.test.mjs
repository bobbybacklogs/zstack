import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
import { readHistory } from '../src/history.mjs';
import { createLiveRun, applyLiveEvent } from '../src/blocks.mjs';

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
      return script.result ?? resultFrom(events);
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
  });

  it('folds apply into a policy so there is one representation', () => {
    assert.equal(normalizeStartRequest({ prompt: 'x' }).policy, 'read-only');
    assert.equal(normalizeStartRequest({ prompt: 'x', apply: true }).policy, 'apply');
    assert.equal(normalizeStartRequest({ prompt: 'x', apply: false }).policy, 'read-only');
    assert.equal(normalizeStartRequest({ prompt: 'x', policy: 'strict' }).policy, 'strict');
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
    assert.equal(applied.maxTurns, 4);
    assert.equal(applied.lane, 'go');

    await settled(registry, registry.start({ prompt: 'b' }).id);
    const readOnly = zstack.calls.at(-1);
    assert.equal(readOnly.apply, false);
    assert.equal(readOnly.autoApproveSafe, true);
    assert.equal(readOnly.maxTurns, undefined);
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
});
