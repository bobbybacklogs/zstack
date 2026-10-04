/**
 * Turn budgets.
 *
 * Nobody knows how many turns a task will take, including the model. So the
 * budget is a guess by construction, and the design follows from that rather
 * than fighting it:
 *
 *  - Ask for the *shape* of the work, not a number. "Quick look" is a question
 *    a person can answer; "how many model turns" is not.
 *  - Default generously. A budget that runs out mid-work wastes the run; a
 *    budget that is too high costs nothing, because a run that finishes early
 *    stops on its own terms.
 *  - Make it recoverable. A run that hits the ceiling can be continued with a
 *    bigger one (`--resume`), so the number is a checkpoint rather than a
 *    deadline.
 *
 * The harness itself defaults to 8 turns. zstack deliberately overrides that:
 * 8 is enough to look around and not much else, and the reader is not the one
 * who pays for the extra budget.
 */

/** The budget zstack sends when the caller expresses no preference. */
export const DEFAULT_MAX_TURNS = 25;

/**
 * The largest budget zstack will send.
 *
 * There is no infinite setting in the harness: `--max-turns` falls back to 8 on
 * any non-positive or non-finite value, so "unlimited" has to be a number. This
 * is that number, and it is high enough that a run hitting it is pathological
 * rather than merely long. Naming it honestly matters more than pretending the
 * ceiling is not there.
 */
export const MAX_MAX_TURNS = 500;

/**
 * The presets, in the order a reader should see them.
 *
 * Each one answers "what are you doing" with a number attached, because the
 * number is the thing the reader cannot know. `hint` says what the budget buys,
 * so the choice is informed rather than a guess at the model's appetite.
 */
export const TURN_PRESETS = Object.freeze([
  Object.freeze({
    id: 'quick',
    label: 'Quick look',
    turns: 8,
    hint: 'Read a few files and answer. No edits worth the name.'
  }),
  Object.freeze({
    id: 'standard',
    label: 'Standard',
    turns: DEFAULT_MAX_TURNS,
    hint: 'Investigate, make the change, verify it. The default.'
  }),
  Object.freeze({
    id: 'deep',
    label: 'Deep',
    turns: 60,
    hint: 'A multi-file change, or a task that needs several rounds of checking.'
  }),
  Object.freeze({
    id: 'marathon',
    label: 'Marathon',
    turns: 200,
    hint: 'Long refactors and migrations. You can still stop it any time.'
  })
]);

/** The preset with this id, or null. */
export function turnPreset(id) {
  return TURN_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * The budget a continuation gets when the caller does not name one.
 *
 * Double what the previous run had, floored at the default. Continuing with the
 * same budget that just ran out would stop in the same place, which is the one
 * outcome a continuation exists to avoid. Doubling is a guess, but it is a guess
 * that fails in the useful direction: too much budget costs nothing, because a
 * run that finishes early stops on its own terms.
 */
export function continuationBudget(previousMaxTurns) {
  const previous = Number(previousMaxTurns);
  if (!Number.isFinite(previous) || previous <= 0) return DEFAULT_MAX_TURNS;
  return Math.min(MAX_MAX_TURNS, Math.max(DEFAULT_MAX_TURNS, Math.floor(previous) * 2));
}

/**
 * The most turns one run may use, across every extension it takes.
 *
 * Extension has to end somewhere or a loop that never converges burns a budget
 * nobody agreed to. This is that boundary, and it applies to the run as a whole
 * rather than to each segment: doubling 25 forever would pass any per-segment
 * cap while still being unbounded in total.
 */
export const MAX_TOTAL_TURNS = MAX_MAX_TURNS;

/**
 * Turns per harness call.
 *
 * One. The harness saves its session in exactly one place — when its loop emits
 * `done` — and the only way to make that loop end early is to let it reach its
 * turn budget. So the granularity of a harness call is the granularity of every
 * control the reader has: a pause lands at the next boundary, which is the next
 * turn. Driving a run one turn at a time is what turns "stop spending tokens"
 * from a hard kill that loses the session into a request the run can honour.
 *
 * The cost is a harness process per turn and one resumed session per step. A
 * run that finishes inside one turn costs the same as it did; a long run pays
 * process startup per turn, and prompt tokens it was already paying, because
 * every turn re-sends the history either way.
 */
export const SEGMENT_TURNS = 1;

/**
 * Did this segment finish, or did it run out?
 *
 * This is the subtle part of turn-by-turn, and getting it wrong is expensive in
 * both directions. At a one-turn budget `turnLimitReached` is *always* true:
 * the harness computes it as `turns >= maxTurns`, and 1 >= 1. So the flag
 * cannot distinguish "the model answered" from "the model ran out", and a loop
 * that trusted it would extend every finished run — including a plain question
 * the model answered in its first turn — until the ceiling.
 *
 * The signal that does distinguish them is the tool calls. The harness ends its
 * loop the moment a turn asks for no tools, and a turn that asks for no tools is
 * the model's answer. A segment that called at least one tool did work and can
 * be continued; a segment that called none has nothing left to continue. With
 * one turn per segment this is exact rather than a heuristic.
 */
export function segmentFinished(result) {
  if (!result) return true;
  if ((Number(result.toolCalls) || 0) === 0) return true;
  // A segment that did work but did not reach its budget ran out of task rather
  // than of turns, which only happens when the harness stops for another reason.
  return result.turnLimitReached !== true;
}

/**
 * One run's steps, gathered from every segment it took.
 *
 * A run driven a turn at a time is many harness calls, and each one numbers its
 * own turns from 1 and opens with its own `run-start`. Concatenating them as
 * they come would replay a ten-turn run as ten "turn 1"s under ten start rows,
 * so this renumbers each segment's turns onto the run's clock and keeps only the
 * first segment's start — the run starts once.
 *
 * The alternative is worse than untidy: keeping just the last segment's steps
 * stores a run whose page says "6 failed calls" above a progression that shows
 * none of them, which is how a reader concludes the tools never ran.
 */
export function mergeSegmentSteps(gathered, offset) {
  if (!Array.isArray(gathered) || gathered.length === 0) return [];
  return gathered
    .filter((step) => step && typeof step === 'object')
    // A later segment's `run-start` is the same run beginning again from a saved
    // session, not a second run: only the first one describes anything.
    .filter((step) => !(step.kind === 'start' && offset > 0))
    // Every step that names a turn, not just the turn dividers: a tool call
    // renumbered as turn 1 under a "Turn 4" heading is worse than no number at
    // all. The start step's turn 0 is left alone — it did not happen in a turn.
    .map((step) => (Number(step.turn) > 0 && Number.isFinite(offset) && offset > 0
      ? { ...step, turn: Number(step.turn) + offset }
      : step));
}

/**
 * Run a task a turn at a time, continuing while it is still working.
 *
 * The loop lives here, apart from both callers, because the rule is the same
 * whether the run came from the browser or the command line: a run that reaches
 * its budget has not finished, it has run out, and stopping there throws away
 * the model's working state. Each iteration is one resumed session, so the run
 * carries on with its history intact, bounded by `MAX_TOTAL_TURNS`.
 *
 * `call` performs one segment and resolves with the SDK's result, which must
 * report `toolCalls`, `turnLimitReached`, and `sessionId`. `onExtend` fires
 * before each resumed segment so the caller can tell the reader what happened.
 * `shouldStop` is consulted between segments so a cancellation wins over an
 * extension, and `shouldPause` so a pause request takes effect at the boundary
 * rather than mid-turn — the one place it can be honoured without losing work.
 *
 * `result.steps` on the way out is the whole run's progression rather than the
 * last segment's, so a caller that records it records the run.
 *
 * @returns {{result: object|null, used: number, grants: number, paused: boolean, ceilingHit: boolean, extensions: Array}}
 */
export async function runWithExtensions({
  maxTurns,
  resume = null,
  segmentTurns = SEGMENT_TURNS,
  call,
  onExtend,
  shouldStop,
  shouldPause
} = {}) {
  // The size the reader picked is where the run starts, not where it stops: a
  // run that still has work continues past it, which is the behaviour that
  // removed the mid-task cutoff. The hard ceiling is what actually ends a run
  // that will not converge.
  const chosen = resolveMaxTurns(maxTurns) ?? DEFAULT_MAX_TURNS;
  const ceiling = MAX_TOTAL_TURNS;
  let current = resume;
  let used = 0;
  let result = null;
  let paused = false;
  let ceilingHit = false;
  const extensions = [];
  const steps = [];

  for (;;) {
    result = await call({ maxTurns: segmentTurns, resume: current });
    const segmentTurnsUsed = Number(result?.turns) || 0;
    steps.push(...mergeSegmentSteps(result?.steps, used));
    used += segmentTurnsUsed;

    if (shouldStop?.()) break;
    // A pause is checked before the finish test: a reader who asked to stop gets
    // told the run is paused, not that it happened to be done anyway.
    if (shouldPause?.()) {
      paused = true;
      break;
    }
    if (segmentFinished(result)) break;

    if (used >= ceiling) {
      // Out of budget for good. The run is recorded as having hit the ceiling,
      // which is the honest description: it did not finish, and it was not
      // stopped by anyone.
      ceilingHit = true;
      break;
    }

    // Without a session there is nothing to resume, so continuing would
    // silently re-run the task from the start and look like progress while
    // repeating work the reader already paid for.
    const nextResume = result.sessionId ?? current;
    if (!nextResume) break;

    current = nextResume;
    const extension = { turn: used, sessionId: nextResume };
    extensions.push(extension);
    onExtend?.(extension);
  }

  return { result: withSteps(result, steps), chosen, used, paused, ceilingHit, extensions };
}

/**
 * The run's result, reporting every segment's steps rather than the last one's.
 *
 * A new object rather than a mutation: `result` is the SDK's own return value,
 * and writing the aggregate onto it would make two callers of the same object
 * disagree about what the run did.
 */
function withSteps(result, steps) {
  if (!result || typeof result !== 'object') return result;
  if (steps.length === 0) return result;
  return { ...result, steps };
}

/**
 * The preset whose budget is this number, when one matches.
 *
 * Used to label a stored budget in the UI: a project set to 25 reads as
 * "Standard" rather than a bare number the reader has to interpret.
 */
export function presetForTurns(turns) {
  const n = Number(turns);
  if (!Number.isInteger(n)) return null;
  return TURN_PRESETS.find((p) => p.turns === n) ?? null;
}

/**
 * Normalize a caller's turn budget.
 *
 * Accepts a preset id, a number, or a numeric string, because the value arrives
 * from an HTTP body, a CLI flag, or a form field and all three spell it
 * differently. Returns null for anything unset or unusable so the caller can
 * distinguish "no preference" from a real choice, and lets the validation layer
 * complain about a garbage value rather than silently substituting a default.
 */
export function resolveMaxTurns(value) {
  if (value === undefined || value === null || value === '') return null;
  // Booleans are not numbers here even though `Number(true)` is 1. Accepting
  // one would run a task on a one-turn budget because a caller wrote `true`
  // where it meant "I don't care", which is the opposite of what they asked.
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    const named = turnPreset(value.trim());
    if (named) return named.turns;
    const text = value.trim();
    if (text === '') return null;
    const parsed = Number(text);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Why this budget is unusable, or null when it is fine.
 *
 * `undefined` and `null` are not problems: they mean "use the default". An
 * explicit `'unlimited'` is not a preset either, and saying so beats silently
 * running with 25 turns when the caller asked for no ceiling.
 */
export function maxTurnsProblem(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return 'maxTurns must be a positive integer, not a boolean.';
  if (typeof value === 'string' && turnPreset(value.trim())) return null;
  const resolved = resolveMaxTurns(value);
  if (resolved === null) {
    const names = TURN_PRESETS.map((p) => p.id).join(', ');
    return `maxTurns must be a positive integer or one of: ${names}.`;
  }
  if (resolved > MAX_MAX_TURNS) {
    return `maxTurns is at most ${MAX_MAX_TURNS}.`;
  }
  return null;
}
