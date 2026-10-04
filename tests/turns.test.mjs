import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_TURNS,
  MAX_MAX_TURNS,
  MAX_TOTAL_TURNS,
  SEGMENT_TURNS,
  TURN_PRESETS,
  continuationBudget,
  runWithExtensions,
  segmentFinished,
  turnPreset,
  presetForTurns,
  resolveMaxTurns,
  maxTurnsProblem
} from '../src/turns.mjs';

describe('turn presets', () => {
  it('looks a preset up by id, and misses on anything else', () => {
    assert.equal(turnPreset('quick').turns, 8);
    assert.equal(turnPreset('standard').turns, DEFAULT_MAX_TURNS);
    assert.equal(turnPreset('deep').turns, 60);
    assert.equal(turnPreset('marathon').turns, 200);

    // An id is an exact key. A near-miss that resolved anyway would start a run
    // with a budget the caller did not pick and cannot see.
    assert.equal(turnPreset('Deep'), null);
    assert.equal(turnPreset('standard '), null);
    assert.equal(turnPreset('nope'), null);
    assert.equal(turnPreset(''), null);
    assert.equal(turnPreset(undefined), null);
    assert.equal(turnPreset(25), null);
  });

  it('names the preset a stored budget came from, and only on an exact match', () => {
    assert.equal(presetForTurns(8).id, 'quick');
    assert.equal(presetForTurns(DEFAULT_MAX_TURNS).id, 'standard');
    // A budget that arrived as text from a form still labels, which is the
    // whole point: the reader sees "Deep" instead of a bare 60.
    assert.equal(presetForTurns('60').id, 'deep');

    // Anything between presets is just a number. Rounding to the nearest label
    // would tell the reader the budget is something it is not.
    assert.equal(presetForTurns(7), null);
    assert.equal(presetForTurns(2.5), null);
    assert.equal(presetForTurns('deep'), null);
    assert.equal(presetForTurns(null), null);
    assert.equal(presetForTurns(undefined), null);
  });

  it('publishes only budgets a run could actually use', () => {
    for (const preset of TURN_PRESETS) {
      assert.ok(
        Number.isInteger(preset.turns) && preset.turns > 0,
        `${preset.id} must carry a positive integer budget`
      );
      // A preset above the ceiling would be an option the validator refuses,
      // which is a control in the UI that cannot start a run.
      assert.ok(preset.turns <= MAX_MAX_TURNS, `${preset.id} must be a budget the validator accepts`);
      assert.ok(preset.label, `${preset.id} needs a label a reader can choose by`);
      assert.ok(preset.hint, `${preset.id} must say what the budget buys`);
    }

    const ids = TURN_PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'two presets sharing an id makes one of them unreachable');

    // "No preference" and "Standard" have to be the same choice, or the default
    // is a budget the reader was never shown.
    assert.equal(turnPreset('standard').turns, DEFAULT_MAX_TURNS);
  });
});

describe('continuation budgets', () => {
  it('doubles what the previous run had, because the same budget stops in the same place', () => {
    assert.equal(continuationBudget(DEFAULT_MAX_TURNS), DEFAULT_MAX_TURNS * 2);
    assert.equal(continuationBudget(30), 60);
    assert.equal(continuationBudget(200), 400);
  });

  it('never drops below the default, so a short run is not continued with less than a fresh one', () => {
    // Doubling "quick" would be 16, which is less than a brand-new run gets.
    assert.equal(continuationBudget(8), DEFAULT_MAX_TURNS);
    assert.equal(continuationBudget(2.5), DEFAULT_MAX_TURNS);
  });

  it('stops at the ceiling the rest of the module enforces', () => {
    // Doubling a marathon is 400, which is fine; doubling anything above 250 is
    // not, and a budget above the ceiling is one the validator refuses.
    assert.equal(continuationBudget(250), MAX_MAX_TURNS);
    assert.equal(continuationBudget(MAX_MAX_TURNS), MAX_MAX_TURNS);
    assert.equal(continuationBudget(100000), MAX_MAX_TURNS);
  });

  it('falls back to the default when the previous run recorded no usable budget', () => {
    // A record from before budgets were stored, or one whose budget was never
    // written, must not produce a continuation of zero turns.
    assert.equal(continuationBudget(undefined), DEFAULT_MAX_TURNS);
    assert.equal(continuationBudget(null), DEFAULT_MAX_TURNS);
    assert.equal(continuationBudget(0), DEFAULT_MAX_TURNS);
    assert.equal(continuationBudget(-5), DEFAULT_MAX_TURNS);
    assert.equal(continuationBudget('lots'), DEFAULT_MAX_TURNS);
    assert.equal(continuationBudget(NaN), DEFAULT_MAX_TURNS);
  });
});

describe('resolving a turn budget', () => {  it('treats unset as no preference rather than as a number', () => {
    // The caller must be able to distinguish "no opinion" from "one turn", and
    // null is how it does.
    assert.equal(resolveMaxTurns(undefined), null);
    assert.equal(resolveMaxTurns(null), null);
    assert.equal(resolveMaxTurns(''), null);
    // A form field left as spaces is a blank field, not a budget of NaN.
    assert.equal(resolveMaxTurns('   '), null);
  });

  it('accepts the three ways a caller spells the same budget', () => {
    assert.equal(resolveMaxTurns(25), 25);
    assert.equal(resolveMaxTurns('60'), 60);
    assert.equal(resolveMaxTurns(' 60 '), 60);
    // The id arrives from a CLI flag or a form select, where a name is the
    // only sane thing to send.
    assert.equal(resolveMaxTurns('quick'), 8);
    assert.equal(resolveMaxTurns('deep'), 60);
    assert.equal(resolveMaxTurns(' deep '), 60);
    assert.equal(resolveMaxTurns('marathon'), 200);
  });

  it('returns null for a value it cannot use, so validation can complain', () => {
    // Garbage must not be quietly replaced by the default: the caller asked for
    // something, and running with 25 turns anyway hides that it was ignored.
    assert.equal(resolveMaxTurns('lots'), null);
    assert.equal(resolveMaxTurns('unlimited'), null);
    assert.equal(resolveMaxTurns(0), null);
    assert.equal(resolveMaxTurns('0'), null);
    assert.equal(resolveMaxTurns(-5), null);
    assert.equal(resolveMaxTurns(2.5), null);
    assert.equal(resolveMaxTurns('2.5'), null);
    assert.equal(resolveMaxTurns(NaN), null);
    // The harness floors a fractional budget, so accepting one here would send
    // a number the run does not actually get.
    assert.equal(resolveMaxTurns('25 turns'), null);
  });

  it('refuses a boolean rather than reading it as one turn', () => {
    // Number(true) is 1, so a naive coercion accepts `{ maxTurns: true }` and
    // runs the task on a one-turn budget. That is the opposite of what a caller
    // writing `true` meant, and the failure is silent: the run just stops
    // immediately. Refusing it at the boundary turns a mystery into an error.
    assert.equal(resolveMaxTurns(true), null);
    assert.equal(resolveMaxTurns(false), null);
    assert.match(maxTurnsProblem(true), /not a boolean/);
    assert.match(maxTurnsProblem(false), /not a boolean/);
  });
});

describe('turn budget validation', () => {
  it('has no complaint when the caller expressed no preference', () => {
    assert.equal(maxTurnsProblem(undefined), null);
    assert.equal(maxTurnsProblem(null), null);
    assert.equal(maxTurnsProblem(''), null);
  });

  it('accepts every preset id, since that is the answer the UI offers', () => {
    for (const preset of TURN_PRESETS) {
      assert.equal(maxTurnsProblem(preset.id), null, `${preset.id} must be startable`);
      assert.equal(maxTurnsProblem(` ${preset.id} `), null);
      assert.equal(maxTurnsProblem(preset.turns), null);
    }
  });

  it('accepts positive integers, and stops at the ceiling rather than below it', () => {
    assert.equal(maxTurnsProblem(1), null);
    assert.equal(maxTurnsProblem(37), null);
    assert.equal(maxTurnsProblem('120'), null);
    // The ceiling itself is allowed. An off-by-one would refuse the largest
    // budget the UI can offer, which is the one a long run needs.
    assert.equal(maxTurnsProblem(MAX_MAX_TURNS), null);
    assert.match(maxTurnsProblem(MAX_MAX_TURNS + 1), new RegExp(`at most ${MAX_MAX_TURNS}`));
  });

  it('names the presets when the value is unusable', () => {
    const problem = maxTurnsProblem('lots');
    assert.match(problem, /positive integer/);
    // The message is the only place a reader learns what would have worked, so
    // it has to list the presets rather than say "invalid".
    for (const preset of TURN_PRESETS) assert.match(problem, new RegExp(preset.id));

    assert.match(maxTurnsProblem(0), /positive integer/);
    assert.match(maxTurnsProblem(-5), /positive integer/);
    assert.match(maxTurnsProblem(2.5), /positive integer/);
    // 'unlimited' is not a preset. Saying so beats running with 25 turns when
    // the caller asked for no ceiling.
    assert.match(maxTurnsProblem('unlimited'), /positive integer/);
  });

  it('complains about a value above the ceiling with the ceiling in the message', () => {
    const problem = maxTurnsProblem(MAX_MAX_TURNS + 100);
    assert.match(problem, new RegExp(String(MAX_MAX_TURNS)));
    assert.doesNotMatch(problem, /positive integer/);
  });
});

describe('turn-by-turn driving', () => {
  const work = (n = 1) => ({ turns: 1, toolCalls: n, turnLimitReached: true, sessionId: `sess-${Math.random()}` });
  const answer = () => ({ turns: 1, toolCalls: 0, turnLimitReached: true, sessionId: `sess-${Math.random()}` });

  it('drives one turn per call, whatever size the reader picked', () => {
    // One turn per call is what makes a pause land at the next boundary. A
    // larger segment would put the boundary most of a budget away.
    const sizes = [];
    return runWithExtensions({
      maxTurns: 200,
      call: async ({ maxTurns }) => {
        sizes.push(maxTurns);
        return sizes.length < 3 ? work() : answer();
      }
    }).then(() => {
      assert.deepEqual(sizes, [SEGMENT_TURNS, SEGMENT_TURNS, SEGMENT_TURNS]);
      assert.equal(SEGMENT_TURNS, 1);
    });
  });

  it('gathers every segment\'s steps onto the run\'s own turn clock', async () => {
    // A run driven a turn at a time is many harness calls, each numbering its
    // turns from 1. Storing only the last segment's steps is how a run page ends
    // up saying "6 failed calls" above a progression that shows none of them.
    let calls = 0;
    const outcome = await runWithExtensions({
      maxTurns: 25,
      call: async () => {
        calls += 1;
        const steps = [
          { kind: 'start', turn: 0, model: 'p/m' },
          { kind: 'turn', turn: 1, tokens: 10 },
          ...(calls <= 2 ? [{ kind: 'tool', turn: 1, name: 'subagent', outcome: 'error', output: `failure ${calls}` }] : [])
        ];
        return calls <= 2
          ? { turns: 1, toolCalls: 1, turnLimitReached: true, sessionId: `sess-${calls}`, steps }
          : { turns: 1, toolCalls: 0, turnLimitReached: true, sessionId: `sess-${calls}`, steps };
      }
    });

    const steps = outcome.result.steps;
    // One run starts once, however many times the model was resumed.
    assert.equal(steps.filter((s) => s.kind === 'start').length, 1);
    // Turns are renumbered onto the run's clock, and every failure survives.
    assert.deepEqual(steps.filter((s) => s.kind === 'turn').map((s) => s.turn), [1, 2, 3]);
    assert.deepEqual(steps.filter((s) => s.kind === 'tool').map((s) => s.output), ['failure 1', 'failure 2']);
    // A tool call is renumbered with its turn, or it reads as a call made in a
    // turn that had already gone by.
    assert.deepEqual(steps.filter((s) => s.kind === 'tool').map((s) => s.turn), [1, 2]);
    assert.equal(steps.find((s) => s.kind === 'start').turn, 0);
    assert.equal(outcome.used, 3);
  });

  it('stops when a turn asks for no tools, because that turn is the answer', async () => {
    // The subtle half. At a one-turn budget `turnLimitReached` is always true
    // (1 >= 1), so a loop trusting that flag would extend a plain answered
    // question until the ceiling. The tool calls are the real signal.
    let calls = 0;
    const outcome = await runWithExtensions({
      maxTurns: 25,
      call: async () => {
        calls += 1;
        return answer();
      }
    });
    assert.equal(calls, 1);
    assert.equal(outcome.used, 1);
    assert.equal(outcome.ceilingHit, false);
    assert.equal(outcome.paused, false);
  });

  it('continues while the model is still working, and resumes each time', async () => {
    const resumes = [];
    let calls = 0;
    const outcome = await runWithExtensions({
      maxTurns: 25,
      call: async ({ resume }) => {
        resumes.push(resume ?? null);
        calls += 1;
        return calls < 4 ? { ...work(2), sessionId: `sess-${calls}` } : { ...answer(), sessionId: `sess-${calls}` };
      }
    });
    // The first call starts fresh; every later one resumes the session the
    // previous turn saved, which is what keeps the history intact.
    assert.deepEqual(resumes, [null, 'sess-1', 'sess-2', 'sess-3']);
    assert.equal(outcome.used, 4);
    assert.equal(outcome.extensions.length, 3);
  });

  it('stops at the ceiling even while the model is still working', async () => {
    // The end of the road. Without it a task that never converges runs forever.
    let calls = 0;
    const outcome = await runWithExtensions({
      maxTurns: 25,
      call: async () => {
        calls += 1;
        return work(3);
      }
    });
    assert.equal(calls, MAX_TOTAL_TURNS);
    assert.equal(outcome.used, MAX_TOTAL_TURNS);
    assert.equal(outcome.ceilingHit, true);
  });

  it('reports the size the reader picked alongside the turns taken', async () => {
    const outcome = await runWithExtensions({ maxTurns: 8, call: async () => answer() });
    assert.equal(outcome.chosen, 8);
    assert.equal(outcome.used, 1);
    // The run is not bounded by the size it was started with, which is why the
    // page says "continued past 8" rather than "9 of 8".
    const long = await runWithExtensions({
      maxTurns: 8,
      call: (() => {
        let n = 0;
        return async () => (++n < 5 ? work() : answer());
      })()
    });
    assert.equal(long.chosen, 8);
    assert.equal(long.used, 5);
  });

  it('lets a pause land at the boundary rather than mid-turn', async () => {
    let calls = 0;
    let pauseAfter = 2;
    const outcome = await runWithExtensions({
      maxTurns: 25,
      call: async () => {
        calls += 1;
        return work(1);
      },
      shouldPause: () => calls >= pauseAfter
    });
    // The turn in flight finished and its session was saved; the loop stopped
    // there rather than killing anything.
    assert.equal(calls, 2);
    assert.equal(outcome.paused, true);
    assert.equal(outcome.ceilingHit, false);
    assert.equal(outcome.used, 2);
  });

  it('prefers a pause over continuing, and a stop over both', async () => {
    const paused = await runWithExtensions({
      maxTurns: 25,
      call: async () => work(),
      shouldPause: () => true
    });
    assert.equal(paused.paused, true);
    assert.equal(paused.used, 1);

    const stopped = await runWithExtensions({
      maxTurns: 25,
      call: async () => work(),
      shouldStop: () => true,
      shouldPause: () => true
    });
    // A stop is not a pause: nothing is resumable, and nothing was saved
    // deliberately.
    assert.equal(stopped.paused, false);
    assert.equal(stopped.used, 1);
  });

  it('stops rather than continuing a segment with no session to resume', async () => {
    // Continuing without a session would silently re-run the task from the top
    // and look like progress while repeating work already paid for.
    let calls = 0;
    const outcome = await runWithExtensions({
      maxTurns: 25,
      call: async () => {
        calls += 1;
        return { turns: 1, toolCalls: 2, turnLimitReached: true, sessionId: null };
      }
    });
    assert.equal(calls, 1);
    assert.equal(outcome.extensions.length, 0);
  });

  it('has a ceiling at least as large as the largest single size', () => {
    assert.ok(MAX_TOTAL_TURNS >= MAX_MAX_TURNS);
  });

  it('treats a nonsense size as the default rather than crashing', async () => {
    const outcome = await runWithExtensions({ maxTurns: 'lots', call: async () => answer() });
    assert.equal(outcome.chosen, DEFAULT_MAX_TURNS);
  });
});
