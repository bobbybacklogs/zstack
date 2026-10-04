import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_KINDS,
  titleFromPrompt,
  outcomeTone,
  turnBudgetText,
  projectStoredRun,
  projectRunSummary,
  createLiveRun,
  applyLiveEvent,
  finishLiveRun,
  liveRunToPage
} from '../src/blocks.mjs';

/** A stored agentic record, shaped like a real history line. */
function agenticEntry(overrides = {}) {
  const promptPreview = "Change any copy from 'Chronos' to 'OddEvents' in this project.";
  return {
    id: 'run-1',
    ts: '2026-09-28T19:20:38.397Z',
    command: 'agent',
    playbook: 'feature',
    role: 'feature, refactoring',
    model: 'opencode/deepseek-v4-pro',
    durationMs: 14677,
    usage: { total_tokens: 46989 },
    // Must match the preview length, or the fixture claims its own prompt was
    // cut short and every notice assertion picks up the wrong block.
    promptChars: promptPreview.length,
    promptPreview,
    files: [],
    ok: true,
    agentic: true,
    applied: true,
    workspace: 'C:/temp/oddevents',
    turns: 2,
    toolCalls: 3,
    failedTools: 1,
    declinedTools: 0,
    fileChanges: [{ path: 'events.js', tool: 'edit', turn: 3 }],
    stepsTruncated: false,
    steps: [
      { kind: 'start', turn: 0, model: 'opencode/deepseek-v4-pro', workspace: 'C:/temp/oddevents' },
      { kind: 'turn', turn: 1, tokens: 4737 },
      { kind: 'approval', tool: 'bash', decision: 'approved', risk: 'safe' },
      { kind: 'tool', turn: 1, name: 'grep_search', target: 'Chronos', outcome: 'ok', durationMs: 68 },
      { kind: 'tool', turn: 1, name: 'bash', target: 'find . -type f', outcome: 'error', durationMs: 0 },
      { kind: 'turn', turn: 2, tokens: 5122 },
      { kind: 'approval', tool: 'edit', decision: 'declined', risk: 'caution' },
      { kind: 'tool', turn: 2, name: 'edit', target: 'events.js', outcome: 'ok', durationMs: 12 }
    ],
    ...overrides
  };
}

/**
 * Every block must declare a kind this module publishes and carry the fields
 * that kind implies. This is the guard that keeps the tagged union honest: a
 * renderer switches on `kind`, so an unpublished kind is a blank row and a
 * missing field is an undefined in the UI.
 */
function assertWellFormed(blocks) {
  const required = {
    callout: ['tone', 'text'],
    prose: ['text'],
    tool: ['name', 'outcome', 'tone'],
    approval: ['tool', 'decision'],
    divider: ['label'],
    notice: ['tone', 'text'],
    summary: ['label', 'items']
  };
  for (const block of blocks) {
    assert.ok(BLOCK_KINDS.includes(block.kind), `unknown block kind: ${block.kind}`);
    for (const field of required[block.kind]) {
      assert.ok(block[field] !== undefined, `${block.kind} block is missing ${field}`);
    }
  }
}

describe('block vocabulary', () => {
  it('derives a title that collapses whitespace and cuts long prompts', () => {
    assert.equal(titleFromPrompt('  fix\n\n the   retry loop '), 'fix the retry loop');
    assert.equal(titleFromPrompt(''), 'Untitled run');
    assert.equal(titleFromPrompt('   '), 'Untitled run');
    assert.equal(titleFromPrompt('', 'agent run'), 'agent run');
    const long = titleFromPrompt('x'.repeat(200));
    assert.equal(long.length, 72);
    assert.ok(long.endsWith('…'));
  });

  it('maps outcomes to tones without calling a refusal a failure', () => {
    assert.equal(outcomeTone('ok'), 'ok');
    assert.equal(outcomeTone('dry-run'), 'ok');
    assert.equal(outcomeTone('error'), 'error');
    assert.equal(outcomeTone('timeout'), 'warning');
    assert.equal(outcomeTone('declined'), 'declined');
    assert.equal(outcomeTone('something-new'), 'neutral');
  });
});

describe('turn budget lines', () => {
  it('reads the budget as spent of chosen while the run is inside it', () => {
    assert.equal(turnBudgetText(3, 25), '3 of 25');
    // A run that has not reported a turn count yet has spent none of its
    // budget, not an unreadable number of them.
    assert.equal(turnBudgetText(undefined, 25), '0 of 25');
    // A budget that arrived as text still renders as a number.
    assert.equal(turnBudgetText(9, '25'), '9 of 25');
  });

  it('describes a run that outgrew the size it was started with', () => {
    // A run is driven a turn at a time and continues while it has work, so
    // outgrowing the chosen size is normal. "31 of 8" would be arithmetic the
    // reader has to interpret, so the line says what happened instead.
    assert.equal(turnBudgetText(31, 8, false, 23), '31 turns, continued past 8');
    assert.equal(turnBudgetText(31, 8), '31 turns, continued past 8');
    // At the hard ceiling the run did not finish and nobody stopped it, which
    // is a different ending from continuing past the chosen size.
    assert.equal(turnBudgetText(500, 8, true, 492), '500 turns, stopped at the ceiling');
  });

  it('names the limit when a run stopped inside its size', () => {
    assert.equal(turnBudgetText(25, 25), '25 of 25');
    assert.equal(turnBudgetText(25, 25, true), '25 of 25 (limit reached)');
    assert.equal(turnBudgetText(24, 25, false), '24 of 25');
  });

  it('still reports the turns when there is no size to compare against', () => {
    // A record from before budgets were stored has no size, and "3 of 0" would
    // invent one out of a missing field. Nothing is printed at all: the plain
    // turn count already has its own property, and repeating it is noise.
    assert.equal(turnBudgetText(3, undefined), null);
    assert.equal(turnBudgetText(3, 0), null);
    assert.equal(turnBudgetText(3, NaN), null);
    assert.equal(turnBudgetText(3, 'deep'), null);
  });
});

describe('archived runs as pages', () => {
  it('projects a stored agentic run into ordered blocks and properties', () => {
    const page = projectStoredRun(agenticEntry());
    assert.equal(page.id, 'run-1');
    assert.equal(page.badge, 'agent');
    assert.equal(page.status, 'ok');
    assert.equal(page.tone, 'ok');
    assert.equal(page.live, false);
    assert.equal(page.truncated, false);
    assertWellFormed(page.blocks);

    const prompt = page.blocks.find((b) => b.kind === 'prose');
    assert.match(prompt.text, /Chronos/);

    // The progression header precedes the steps it labels.
    const headerIndex = page.blocks.findIndex((b) => b.kind === 'divider' && b.label === 'Recorded progression');
    const firstTurn = page.blocks.findIndex((b) => b.kind === 'divider' && b.label === 'Turn 1');
    assert.ok(headerIndex >= 0 && headerIndex < firstTurn, 'progression header must come first');

    const tools = page.blocks.filter((b) => b.kind === 'tool');
    assert.equal(tools.length, 3);
    assert.equal(tools[0].tone, 'ok');
    assert.equal(tools[1].tone, 'error');
    assert.equal(tools[1].durationText, '0ms');
    assert.equal(tools[2].target, 'events.js');

    const declined = page.blocks.find((b) => b.kind === 'approval' && b.decision === 'declined');
    assert.equal(declined.tone, 'declined');

    const props = Object.fromEntries(page.props.map((p) => [p.key, p.value]));
    assert.equal(props.model, 'opencode/deepseek-v4-pro');
    assert.equal(props.tokens, '46,989');
    assert.equal(props.duration, '14.7s');
    assert.equal(props.policy, 'apply');
    assert.equal(props.workspace, 'C:/temp/oddevents');

    const summary = page.blocks.find((b) => b.kind === 'summary');
    assert.equal(summary.label, 'Changed 1 file');
    assert.equal(summary.items[0].name, 'events.js');
  });

  it('says a single-completion run has no progression instead of an empty body', () => {
    const page = projectStoredRun({
      id: 'run-2',
      ts: '2026-09-28T19:00:00.000Z',
      command: 'task',
      playbook: 'feature',
      promptPreview: 'explain the retry loop',
      promptChars: 22,
      ok: true
    });
    assertWellFormed(page.blocks);
    const callout = page.blocks.find((b) => b.kind === 'callout');
    assert.equal(callout.text, 'Single-completion run');
    assert.match(callout.detail, /cannot read, run, or change anything/);
    assert.equal(page.blocks.filter((b) => b.kind === 'divider').length, 0);
    assert.equal(page.blocks.some((b) => b.kind === 'summary'), false);
  });

  it('says an agentic run recorded no progression rather than showing nothing', () => {
    const page = projectStoredRun(agenticEntry({ steps: [] }));
    assertWellFormed(page.blocks);
    const notice = page.blocks.find((b) => b.kind === 'notice');
    assert.match(notice.text, /No progression was recorded/);
  });

  it('marks a capped progression as partial', () => {
    const page = projectStoredRun(agenticEntry({ stepsTruncated: true }));
    assert.equal(page.truncated, true);
    const notice = page.blocks.find((b) => b.kind === 'notice' && /partial/.test(b.text));
    assert.ok(notice, 'a capped progression must say it is partial');
    assert.match(notice.text, /200 steps/);
  });

  it('flags a stored prompt that is only a preview of the real one', () => {
    const page = projectStoredRun(agenticEntry({ promptPreview: 'x'.repeat(200), promptChars: 900 }));
    const notice = page.blocks.find((b) => b.kind === 'notice');
    assert.match(notice.text, /200-character preview of 900 characters/);
    // The true length is still readable as a property.
    assert.equal(page.props.find((p) => p.key === 'promptChars').value, '900 chars');
  });

  it('reports a failed run as failed', () => {
    const page = projectStoredRun(agenticEntry({ ok: false, exitCode: 1, errorKind: 'timeout' }));
    assert.equal(page.status, 'failed');
    assert.equal(page.tone, 'error');
    const callout = page.blocks.find((b) => b.kind === 'callout');
    assert.equal(callout.tone, 'error');
  });

  it('states a stored run\'s failure reason instead of only its exit code', () => {
    // A run that failed before its first turn has no steps to explain it, so the
    // recorded reason is the only thing standing between the reader and "exited
    // with code 1".
    const page = projectStoredRun(agenticEntry({
      ok: false,
      exitCode: 1,
      steps: [],
      error: 'Provider "opencode" returned HTTP 401: Missing API key.'
    }));
    assertWellFormed(page.blocks);
    const notice = page.blocks.find((b) => b.kind === 'notice' && b.tone === 'error');
    assert.ok(notice, 'a stored failure with a reason must show it');
    assert.match(notice.text, /HTTP 401/);

    // No recorded reason is not a licence to invent one.
    const bare = projectStoredRun(agenticEntry({ ok: false, exitCode: 1, error: null }));
    assert.equal(
      bare.blocks.some((b) => b.kind === 'notice' && b.tone === 'error'),
      false
    );
  });

  it('falls back to the start step for the model and workspace', () => {
    const page = projectStoredRun(agenticEntry({ model: null, workspace: null }));
    const props = Object.fromEntries(page.props.map((p) => [p.key, p.value]));
    assert.equal(props.model, 'opencode/deepseek-v4-pro');
    assert.equal(props.workspace, 'C:/temp/oddevents');
  });

  it('says an apply run recorded no attributed change, not that nothing changed', () => {
    const page = projectStoredRun(agenticEntry({ fileChanges: [], applied: true }));
    const notice = page.blocks.find((b) => b.kind === 'notice');
    assert.match(notice.text, /no attributed file change/);
  });

  it('summarizes the card fields the run list needs', () => {
    const card = projectRunSummary(agenticEntry());
    assert.equal(card.title, "Change any copy from 'Chronos' to 'OddEvents' in this project.");
    assert.equal(card.tone, 'ok');
    assert.equal(card.agentic, true);
    assert.equal(card.applied, true);
    assert.equal(card.tokensText, '46,989');
    assert.equal(card.durationText, '14.7s');
    assert.equal(card.fileChangeCount, 1);
    // A card carries no body, which is the point of keeping it separate.
    assert.equal(card.blocks, undefined);
  });

  it('reports a stored run that stopped at the ceiling and can be continued', () => {
    const page = projectStoredRun(agenticEntry({
      turns: 500,
      maxTurns: 25,
      turnLimitReached: true,
      sessionId: 'session-1'
    }));

    // `canContinue` is the honest answer to "can I get more of this": it needs
    // a session to resume, and a reason to. Here the reason is the ceiling.
    assert.deepEqual(page.turnBudget, {
      maxTurns: 25,
      used: 500,
      extensions: 0,
      limitReached: true,
      paused: false,
      sessionId: 'session-1',
      // Never in place for an archived record: resuming a pause continues the
      // live run, and this projection has no live run behind it.
      inPlace: false,
      canContinue: true
    });
    // The same fact as a property, because that is what the header renders.
    const props = Object.fromEntries(page.props.map((p) => [p.key, p.value]));
    assert.equal(props.turnBudget, '500 turns, stopped at the ceiling');
  });

  it('reports a paused run as resumable', () => {
    // The case pause exists for: the run stopped on purpose mid-task with its
    // session saved, so resuming is the obvious next action.
    const page = projectStoredRun(agenticEntry({
      turns: 12,
      maxTurns: 25,
      paused: true,
      sessionId: 'session-2'
    }));
    assert.equal(page.status, 'paused');
    assert.equal(page.tone, 'paused');
    assert.equal(page.turnBudget.paused, true);
    assert.equal(page.turnBudget.canContinue, true);
    assert.equal(page.turnBudget.limitReached, false);
  });

  it('describes a run that outgrew its chosen size', () => {
    const page = projectStoredRun(agenticEntry({ turns: 90, maxTurns: 25, extensions: 65 }));
    const props = Object.fromEntries(page.props.map((p) => [p.key, p.value]));
    assert.equal(props.turnBudget, '90 turns, continued past 25');
    assert.equal(page.turnBudget.extensions, 65);
    assert.equal(page.turnBudget.limitReached, false);
  });

  it('offers no continuation without both a reason and a session', () => {
    // Finishing inside the size you picked is not something to continue.
    const finished = projectStoredRun(agenticEntry({ turns: 4, maxTurns: 25, sessionId: 'session-1' }));
    assert.equal(finished.turnBudget.limitReached, false);
    assert.equal(finished.turnBudget.paused, false);
    assert.equal(finished.turnBudget.canContinue, false);

    // A record whose session was never saved has a budget and a turn count but
    // nothing to resume, so it reports the budget and offers nothing. Claiming
    // otherwise would start the task over under a "continue" label.
    const noSession = projectStoredRun(agenticEntry({ turns: 500, maxTurns: 25, turnLimitReached: true }));
    assert.equal(noSession.turnBudget.sessionId, null);
    assert.equal(noSession.turnBudget.canContinue, false);

    const pausedNoSession = projectStoredRun(agenticEntry({ turns: 3, maxTurns: 25, paused: true }));
    assert.equal(pausedNoSession.turnBudget.canContinue, false);

    // A record from before budgets were stored and with no turns says nothing
    // at all, rather than a zeroed budget the reader would take for a real one.
    assert.equal(projectStoredRun(agenticEntry()).turnBudget, null);
  });
});

describe('live runs as pages', () => {
  function runWith(events, request = {}) {
    const run = createLiveRun({ id: 'live-1', prompt: 'Do the thing', workspaceDir: '/repo', ...request });
    for (const event of events) applyLiveEvent(run, event);
    return run;
  }

  const start = { type: 'run-start', model: 'deepseek-v4-pro', provider: 'opencode-go', workspace: '/repo', playbook: 'feature' };

  it('merges streamed text deltas into one block per turn', () => {
    const run = runWith([
      start,
      { type: 'turn', turn: 1, tokens: 100 },
      { type: 'text', turn: 1, text: 'I will ' },
      { type: 'text', turn: 1, text: 'read the file' },
      { type: 'text', turn: 1, text: ' first.' },
      { type: 'turn', turn: 2, tokens: 200 },
      { type: 'text', turn: 2, text: 'Done.' }
    ]);
    const prose = run.blocks.filter((b) => b.kind === 'prose');
    assert.equal(prose.length, 2);
    assert.equal(prose[0].text, 'I will read the file first.');
    assert.equal(prose[1].text, 'Done.');
  });

  it('stops streaming a prose block once its turn ends', () => {
    const run = runWith([
      start,
      { type: 'turn', turn: 1, tokens: 100 },
      { type: 'text', turn: 1, text: 'thinking' },
      { type: 'turn', turn: 2, tokens: 200 }
    ]);
    const prose = run.blocks.find((b) => b.kind === 'prose');
    // A block nothing will append to again must not keep a streaming cursor.
    assert.equal(prose.streaming, false);
  });

  it('numbers turns across extensions instead of restarting at 1', () => {
    // The shape of an extended run: the first segment spends its turn, the run
    // is extended, and the resumed session numbers its turns from 1 again. Both
    // the count and the labels have to carry the total forward, or the page
    // shows a second "Turn 1" and reads as the run going backwards.
    const run = createLiveRun({ id: 'live-ext', prompt: 'Long task', workspaceDir: '/repo', maxTurns: 25 });
    for (const event of [
      start,
      { type: 'turn', turn: 1, tokens: 100 },
      { type: 'text', turn: 1, text: 'Starting.' },
      { type: 'done', turns: 1, sessionId: 'sess-1' }
    ]) applyLiveEvent(run, event);
    assert.equal(run.turns, 1);

    // The registry does this between segments.
    run.turnOffset = run.turns;
    applyLiveEvent(run, { type: 'run-start', model: 'deepseek-v4-pro', provider: 'opencode-go' });
    applyLiveEvent(run, { type: 'turn', turn: 1, tokens: 200 });
    applyLiveEvent(run, { type: 'turn', turn: 2, tokens: 300 });
    applyLiveEvent(run, { type: 'done', turns: 2, sessionId: 'sess-2' });

    assert.equal(run.turns, 3);
    const labels = run.blocks.filter((b) => b.kind === 'divider').map((b) => b.label);
    assert.deepEqual(labels, ['Turn 1', 'Turn 2', 'Turn 3']);

    // The extension does not announce a second run. One run continuing is the
    // whole point, so the start callout stays singular.
    const callouts = run.blocks.filter((b) => b.kind === 'callout' && /^Running/.test(b.text));
    assert.equal(callouts.length, 1);
  });

  it('counts a writer as a file change and a successful read as none', () => {
    const run = runWith([
      start,
      { type: 'tool', turn: 1, name: 'read', args: { file_path: 'main.js' }, outcome: 'ok' },
      { type: 'tool', turn: 1, name: 'grep_search', args: { pattern: 'x', path: 'src' }, outcome: 'ok' },
      { type: 'tool', turn: 1, name: 'write', args: { file_path: 'main.js' }, outcome: 'ok' },
      { type: 'tool', turn: 1, name: 'write', args: { file_path: 'gone.js' }, outcome: 'error' }
    ]);
    assert.deepEqual(run.fileChanges, [{ path: 'main.js', tool: 'write', turn: 1 }]);
  });

  it('counts a declined call apart from a failed one', () => {
    const run = runWith([
      start,
      { type: 'tool', turn: 1, name: 'bash', args: { command: 'ls' }, outcome: 'ok' },
      { type: 'tool', turn: 1, name: 'bash', args: { command: 'rm -rf /' }, outcome: 'declined' },
      { type: 'tool', turn: 1, name: 'bash', args: { command: 'false' }, outcome: 'error' }
    ]);
    assert.equal(run.toolCalls, 3);
    assert.equal(run.declined, 1);
    assert.equal(run.failed, 1);
    const tones = run.blocks.filter((b) => b.kind === 'tool').map((b) => b.tone);
    assert.deepEqual(tones, ['ok', 'declined', 'error']);
  });

  it('reports each event as the block that changed', () => {
    const run = createLiveRun({ id: 'live-1', prompt: 'p' });
    const first = applyLiveEvent(run, { type: 'turn', turn: 1, tokens: 5 });
    assert.deepEqual(first.map((c) => c.index), [0]);
    assert.equal(first[0].block.kind, 'divider');

    const second = applyLiveEvent(run, { type: 'text', turn: 1, text: 'a' });
    const third = applyLiveEvent(run, { type: 'text', turn: 1, text: 'b' });
    // Both deltas report the same index, which is what lets the client replace
    // one block instead of re-rendering the page.
    assert.equal(second[0].index, third[0].index);
    assert.equal(third[0].block.text, 'ab');

    assert.deepEqual(applyLiveEvent(run, { type: 'noise' }), []);
    assert.deepEqual(applyLiveEvent(run, null), []);
    assert.deepEqual(applyLiveEvent(null, { type: 'turn' }), []);
  });

  it('writes the closing summary on finish, not when the model stops', () => {
    const run = runWith([
      start,
      { type: 'turn', turn: 1, tokens: 100 },
      { type: 'text', turn: 1, text: 'answer' },
      { type: 'done', turns: 1, tokens: 500, tools: 2, durationMs: 1500 }
    ]);
    // The model stopping says nothing about whether the process then exited
    // non-zero, so no verdict block exists yet.
    assert.equal(run.blocks.some((b) => b.kind === 'summary'), false);

    finishLiveRun(run, { ok: true });
    const summary = run.blocks.at(-1);
    assert.equal(summary.kind, 'summary');
    assert.equal(summary.label, 'Run finished');
    assert.equal(summary.tone, 'ok');
    assert.equal(summary.items.find((i) => i.name === 'Tokens').detail, '500');
    assert.equal(summary.items.find((i) => i.name === 'Duration').detail, '1.5s');
  });

  it('rewrites the opening callout once the run has started', () => {
    const run = runWith([start]);
    assert.match(run.blocks[0].text, /^Running /);
    finishLiveRun(run, { ok: true });
    assert.match(run.blocks[0].text, /^Ran opencode-go\/deepseek-v4-pro$/);
  });

  it('puts the reason above the verdict when a run fails', () => {
    const run = runWith([start, { type: 'turn', turn: 1, tokens: 1 }]);
    finishLiveRun(run, { ok: false, exitCode: 3 });
    assert.equal(run.status, 'failed');
    assert.equal(run.tone, 'error');
    const kinds = run.blocks.map((b) => b.kind);
    assert.deepEqual(kinds.slice(-2), ['notice', 'summary']);
    assert.match(run.blocks.at(-2).text, /exited with code 3/);
    assert.equal(run.blocks.at(-1).tone, 'error');
    assert.equal(run.blocks.at(-1).label, 'Run failed');
  });

  it('reports a harness that never started as an error page', () => {
    const run = createLiveRun({ id: 'live-2', prompt: 'p' });
    finishLiveRun(run, { error: 'The ModelHitch harness was not found.' });
    assert.equal(run.status, 'failed');
    assert.match(run.blocks.at(-2).text, /harness was not found/);
  });

  it('carries a failed call\'s own words, and drops them for a call that worked', () => {
    // The harness sends `output` only for a failure. Without it the page can say
    // a call failed and how fast, which is not enough to do anything about it.
    const run = runWith([
      start,
      { type: 'turn', turn: 1, tokens: 1 },
      {
        type: 'tool',
        turn: 1,
        name: 'subagent',
        args: { agent: 'scout' },
        outcome: 'error',
        durationMs: 4,
        output: 'Error: unknown subagent "scout". Available: repo-assessor, shipper.'
      },
      {
        type: 'tool',
        turn: 1,
        name: 'read',
        args: { path: 'a.ts' },
        outcome: 'ok',
        durationMs: 2,
        // A body on a successful call is not carried by the harness, and a stray
        // one must not reach the page either.
        output: 'file body'
      }
    ]);
    finishLiveRun(run, { ok: true });
    const page = liveRunToPage(run);
    const [failed, ok] = page.blocks.filter((b) => b.kind === 'tool');
    assert.match(failed.output, /unknown subagent "scout"/);
    assert.equal(ok.output, null);
  });

  it('renders a live page in the shape the archive uses', () => {
    const run = runWith([
      start,
      { type: 'turn', turn: 1, tokens: 100 },
      { type: 'text', turn: 1, text: 'answer' },
      { type: 'approval', tool: 'write', decision: 'approved', risk: 'caution' },
      { type: 'tool', turn: 1, name: 'write', args: { file_path: 'a.js' }, outcome: 'ok', durationMs: 9 },
      { type: 'done', turns: 1, tokens: 700, tools: 1, durationMs: 2000 }
    ]);
    finishLiveRun(run, { ok: true });
    const page = liveRunToPage(run);

    assert.equal(page.live, true);
    assert.equal(page.status, 'ok');
    assertWellFormed(page.blocks);
    assert.equal(page.counts.toolCalls, 1);
    assert.equal(page.counts.fileChanges, 1);

    // The two sources must produce the same block vocabulary, or "live view"
    // and "history view" are two features that disagree.
    const archived = projectStoredRun(agenticEntry());
    const liveKinds = new Set(page.blocks.map((b) => b.kind));
    const archiveKinds = new Set(archived.blocks.map((b) => b.kind));
    for (const kind of liveKinds) {
      assert.ok(BLOCK_KINDS.includes(kind), `live emitted ${kind}, which the archive vocabulary lacks`);
    }
    assert.deepEqual([...liveKinds].sort(), [...archiveKinds].sort());
  });

  it('carries page properties and the prompt on a live page', () => {
    const run = runWith([start, { type: 'turn', turn: 1, tokens: 10 }], { apply: false, role: 'feature, refactoring' });
    finishLiveRun(run, { ok: true });
    const page = liveRunToPage(run);
    const props = Object.fromEntries(page.props.map((p) => [p.key, p.value]));
    assert.equal(props.prompt, 'Do the thing');
    assert.equal(props.policy, 'read-only');
    assert.equal(props.model, 'opencode-go/deepseek-v4-pro');
    assert.equal(props.role, 'feature, refactoring');
  });

  it('offers a continuation on a live page only when there is a reason and a session', () => {
    // The size the reader picked lives on the request, which is the one
    // authority for it: the registry records turns taken separately.
    const run = runWith([start, { type: 'turn', turn: 25, tokens: 10 }], { maxTurns: 25 });
    run.sessionId = 'session-1';
    run.turnLimitReached = true;
    finishLiveRun(run, { ok: true });

    const page = liveRunToPage(run);
    assert.equal(page.turnBudget.maxTurns, 25);
    assert.equal(page.turnBudget.used, 25);
    assert.equal(page.turnBudget.sessionId, 'session-1');
    assert.equal(page.turnBudget.canContinue, true);

    // Continue means resume, so a run with no saved session cannot be one, even
    // when it hit the ceiling.
    run.sessionId = null;
    assert.equal(liveRunToPage(run).turnBudget.canContinue, false);

    // And a run that finished inside its size has nothing to continue.
    run.sessionId = 'session-1';
    run.turnLimitReached = false;
    assert.equal(liveRunToPage(run).turnBudget.limitReached, false);
    assert.equal(liveRunToPage(run).turnBudget.canContinue, false);

    // A paused run is resumable without having hit anything.
    run.paused = true;
    assert.equal(liveRunToPage(run).turnBudget.canContinue, true);
    assert.equal(liveRunToPage(run).turnBudget.paused, true);
    run.paused = false;

    // A run started without a budget reports none, so the page cannot claim a
    // ceiling that was never sent.
    const unbudgeted = runWith([start, { type: 'turn', turn: 1, tokens: 5 }]);
    finishLiveRun(unbudgeted, { ok: true });
    assert.equal(liveRunToPage(unbudgeted).turnBudget, null);
  });
});
