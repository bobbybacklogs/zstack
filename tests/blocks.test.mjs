import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_KINDS,
  titleFromPrompt,
  outcomeTone,
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
});
