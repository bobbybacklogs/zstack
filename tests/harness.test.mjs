/**
 * Tests for the harness client: the piece that turns ModelHitch's NDJSON run
 * stream into zstack's progression view.
 *
 * These stay hermetic. The parser, the progression reducer, the renderer, and
 * the argument builder are all pure or near-pure, so nothing here spawns the
 * harness or needs a gateway. The live path is covered by
 * `verification/agentic-loop-probe.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  createEventParser,
  buildProgression,
  formatEventLine,
  createProgressRenderer,
  summarizeToolCall,
  resolveHarnessEntry,
  harnessEntryExists,
  observeGitStatus,
  mutationPath,
  finalText,
  explainEmptyContent,
  failureReasonFromStderr,
  HARNESS_DEFAULT_MAX_TURNS,
  HARNESS_EVENTS_SCHEMA
} from '../src/harness.mjs';

const runStart = (over = {}) => ({
  type: 'run-start',
  schema: HARNESS_EVENTS_SCHEMA,
  at: '2026-01-01T00:00:00.000Z',
  task: 'do a thing',
  model: 'opencode-go/deepseek-v4-pro',
  provider: 'opencode-go',
  sessionId: 's1',
  workspace: '/tmp/project',
  playbook: 'feature',
  approvals: 'non-interactive',
  ...over
});

test('event parser: reads records split across chunk boundaries', () => {
  const seen = [];
  const parser = createEventParser((event) => seen.push(event));

  const lines = [JSON.stringify(runStart()), JSON.stringify({ type: 'turn', turn: 1, tokens: 10 })].join('\n') + '\n';
  // Feed one byte at a time: the worst case for a line-oriented parser.
  for (const ch of lines) parser.push(ch);
  const { malformed } = parser.flush();

  assert.equal(malformed, 0);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].type, 'run-start');
  assert.equal(seen[1].turn, 1);
});

test('event parser: flushes a trailing record with no newline', () => {
  const seen = [];
  const parser = createEventParser((event) => seen.push(event));
  parser.push('{"type":"done","turns":2}');
  const { malformed } = parser.flush();

  assert.equal(malformed, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].turns, 2);
});

test('event parser: counts malformed lines and keeps the good ones', () => {
  const seen = [];
  const parser = createEventParser((event) => seen.push(event));
  parser.push('not json\n');
  parser.push('{"no_type":true}\n');
  parser.push('\n');
  parser.push(`${JSON.stringify({ type: 'turn', turn: 3 })}\n`);
  const { malformed } = parser.flush();

  assert.equal(malformed, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].turn, 3);
});

test('buildProgression: separates tool outcomes and keeps tool order', () => {
  const progression = buildProgression([
    runStart(),
    { type: 'turn', turn: 1, tokens: 100 },
    { type: 'tool', turn: 1, name: 'bash', args: { command: 'ls -la' }, outcome: 'ok', durationMs: 5, truncated: false, bytes: 10 },
    { type: 'approval', tool: 'bash', decision: 'approved' },
    { type: 'tool', turn: 1, name: 'bash', args: { command: 'rm -rf /' }, outcome: 'declined', durationMs: 1, truncated: false, bytes: 5 },
    { type: 'tool', turn: 2, name: 'read', args: { path: 'a.ts' }, outcome: 'error', durationMs: 2, truncated: false, bytes: 3 },
    { type: 'turn', turn: 2, tokens: 50 },
    { type: 'done', turns: 2, tools: 3, tokens: 150, durationMs: 900, changes: [{ name: 'edit', added: 2, removed: 1 }] }
  ]);

  assert.equal(progression.turns, 2);
  assert.equal(progression.toolCount, 3);
  assert.equal(progression.declined, 1);
  assert.equal(progression.failed, 1);
  assert.equal(progression.tokens, 150);
  assert.equal(progression.durationMs, 900);
  assert.equal(progression.approvals.length, 1);

  const tools = progression.steps.filter((s) => s.kind === 'tool');
  assert.deepEqual(tools.map((t) => t.name), ['bash', 'bash', 'read']);
  assert.equal(tools[0].target, 'ls -la');
  assert.equal(tools[2].target, 'a.ts');
});

test('buildProgression: attributes a file change to the writer that made it', () => {
  const progression = buildProgression([
    runStart(),
    { type: 'tool', turn: 1, name: 'edit', args: { file_path: 'src/app.ts' }, outcome: 'ok', durationMs: 4, truncated: false, bytes: 9 },
    { type: 'tool', turn: 2, name: 'read', args: { path: 'src/app.ts' }, outcome: 'ok', durationMs: 1, truncated: false, bytes: 9 },
    { type: 'done', turns: 2, tools: 2, tokens: 10, durationMs: 100 }
  ]);

  // The read is not a change even though it succeeded.
  assert.deepEqual(progression.fileChanges, [{ path: 'src/app.ts', tool: 'edit', turn: 1 }]);
});

test('buildProgression: a declined write is not a file change', () => {
  const progression = buildProgression([
    runStart(),
    { type: 'tool', turn: 1, name: 'write', args: { file_path: 'a.ts' }, outcome: 'declined', durationMs: 1, truncated: false, bytes: 5 },
    { type: 'done', turns: 1, tools: 1, tokens: 5, durationMs: 10 }
  ]);

  assert.deepEqual(progression.fileChanges, []);
});

test('buildProgression: does not double-prefix an already qualified model', () => {
  const progression = buildProgression([runStart(), { type: 'done', turns: 1, tools: 0 }]);
  assert.equal(progression.model, 'opencode-go/deepseek-v4-pro');

  const bare = buildProgression([runStart({ model: 'deepseek-v4-pro', provider: 'opencode-go' })]);
  assert.equal(bare.model, 'opencode-go/deepseek-v4-pro');
});

test('buildProgression: finalText is the last thing said, not the first', () => {
  const progression = buildProgression([
    runStart(),
    { type: 'text', turn: 1, text: 'Let me look.' },
    { type: 'text', turn: 2, text: 'Here is the answer.' }
  ]);

  assert.equal(finalText(progression), 'Here is the answer.');
  assert.equal(progression.text.length, 2);
});

test('buildProgression: concatenates streamed deltas within a turn', () => {
  // The harness emits one text event per stream delta. Keeping them as separate
  // parts made `finalText` return a single trailing token, so a run whose answer
  // ended in "." reported "." as its entire content.
  const progression = buildProgression([
    runStart(),
    { type: 'text', turn: 1, text: 'The file ' },
    { type: 'text', turn: 1, text: 'has three ' },
    { type: 'text', turn: 1, text: 'lines' },
    { type: 'text', turn: 1, text: '.' }
  ]);

  assert.equal(progression.text.length, 1);
  assert.equal(progression.text[0].text, 'The file has three lines.');
  assert.equal(finalText(progression), 'The file has three lines.');
});

test('buildProgression: deltas on either side of a tool call stay in their own turn', () => {
  const progression = buildProgression([
    runStart(),
    { type: 'text', turn: 1, text: 'Looking ' },
    { type: 'text', turn: 1, text: 'now.' },
    { type: 'tool', turn: 1, name: 'read', args: { path: 'a.ts' }, outcome: 'ok', durationMs: 1 },
    { type: 'text', turn: 2, text: 'It ' },
    { type: 'text', turn: 2, text: 'has 3 lines.' }
  ]);

  assert.deepEqual(progression.text.map((t) => t.text), ['Looking now.', 'It has 3 lines.']);
  assert.equal(finalText(progression), 'It has 3 lines.');
});

test('buildProgression: whitespace-only turns are dropped from the narrative', () => {
  const progression = buildProgression([
    runStart(),
    { type: 'text', turn: 1, text: 'Real answer.' },
    { type: 'text', turn: 2, text: '\n\n' }
  ]);

  assert.equal(progression.text.length, 1);
  assert.equal(finalText(progression), 'Real answer.');
});

test('summarizeToolCall: prefers the field a reader wants for that tool', () => {
  assert.equal(summarizeToolCall('bash', { command: 'ls -la' }), 'ls -la');
  assert.equal(summarizeToolCall('exec_command', { cmd: 'pwd && ls' }), 'pwd && ls');
  assert.equal(summarizeToolCall('read', { file_path: 'a/b.ts' }), 'a/b.ts');
  assert.equal(summarizeToolCall('grep_search', { pattern: 'TODO' }), 'TODO');
  // Unknown shapes fall back to the keys, never to "undefined".
  assert.equal(summarizeToolCall('mystery', { alpha: 1, beta: 2 }), 'alpha, beta');
  assert.equal(summarizeToolCall('mystery', {}), '');
});

test('summarizeToolCall: collapses newlines and caps length', () => {
  const target = summarizeToolCall('bash', { command: 'echo a\necho b\t echo c' });
  assert.equal(target, 'echo a echo b echo c');

  const long = summarizeToolCall('bash', { command: 'x'.repeat(500) });
  assert.ok(long.length <= 96, `expected <= 96 chars, got ${long.length}`);
  assert.ok(long.endsWith('…'));
});

test('mutationPath: reads path-like keys and ignores other arguments', () => {
  assert.equal(mutationPath({ file_path: 'a.ts' }), 'a.ts');
  assert.equal(mutationPath({ path: 'b.ts' }), 'b.ts');
  assert.equal(mutationPath({ command: 'ls' }), null);
  assert.equal(mutationPath({ file_path: '   ' }), null);
  assert.equal(mutationPath(null), null);
});

test('formatEventLine: renders each event kind, and skips blank text', () => {
  assert.match(formatEventLine(runStart()), /Agent run: opencode-go\/deepseek-v4-pro/);
  assert.match(formatEventLine({ type: 'turn', turn: 2, tokens: 40 }), /\[2\] turn 2 \(40 tokens\)/);
  assert.match(formatEventLine({ type: 'tool', name: 'read', args: { path: 'a.ts' }, outcome: 'ok', durationMs: 3 }), /· read a\.ts/);
  assert.match(formatEventLine({ type: 'tool', name: 'read', args: { path: 'a.ts' }, outcome: 'declined', durationMs: 3 }), /! read a\.ts/);
  assert.match(formatEventLine({ type: 'approval', tool: 'bash', decision: 'declined', risk: 'caution' }), /approval bash: declined \(caution\)/);
  assert.match(formatEventLine({ type: 'done', turns: 2, tools: 3, durationMs: 50 }), /\[✓\] 2 turns \| 3 tools/);
  assert.equal(formatEventLine({ type: 'text', turn: 1, text: '   ' }), null);
  assert.equal(formatEventLine({ type: 'unknown-kind' }), null);
});

test('progress renderer: coalesces streamed text into one block per turn', () => {
  const lines = [];
  const renderer = createProgressRenderer({ write: (line) => lines.push(line) });

  // A model streams a sentence one token at a time.
  renderer.push({ type: 'text', turn: 1, text: 'I' });
  renderer.push({ type: 'text', turn: 1, text: "'ll" });
  renderer.push({ type: 'text', turn: 1, text: ' look.' });
  // The tool call interrupts it, which is what flushes the block.
  renderer.push({ type: 'tool', turn: 1, name: 'bash', args: { command: 'ls' }, outcome: 'ok', durationMs: 2 });
  renderer.flush();

  assert.equal(lines.length, 2);
  assert.equal(lines[0], "    │ I'll look.");
  assert.match(lines[1], /· bash ls/);
});

test('progress renderer: a new turn flushes the previous text first', () => {
  const lines = [];
  const renderer = createProgressRenderer({ write: (line) => lines.push(line) });

  renderer.push({ type: 'text', turn: 1, text: 'First.' });
  renderer.push({ type: 'text', turn: 2, text: 'Second.' });
  renderer.flush();

  assert.deepEqual(lines, ['    │ First.', '    │ Second.']);
});

test('progress renderer: flush on an empty buffer writes nothing', () => {
  const lines = [];
  const renderer = createProgressRenderer({ write: (line) => lines.push(line) });
  renderer.push({ type: 'text', turn: 1, text: '   ' });
  renderer.flush();
  assert.deepEqual(lines, []);
});

test('resolveHarnessEntry: an explicit override wins and a script runs under node', () => {
  const script = resolveHarnessEntry({ env: { ZSTACK_HARNESS_BIN: '/opt/mhh/dist/harness-cli.js' } });
  assert.equal(script.command, process.execPath);
  assert.deepEqual(script.args, ['/opt/mhh/dist/harness-cli.js']);
  assert.equal(script.shell, false);
  assert.equal(script.source, 'ZSTACK_HARNESS_BIN');

  const binary = resolveHarnessEntry({ env: { ZSTACK_HARNESS_BIN: '/usr/local/bin/mhh' } });
  assert.equal(binary.command, '/usr/local/bin/mhh');
  assert.deepEqual(binary.args, []);
});

test('resolveHarnessEntry: returns null rather than guessing when nothing is found', () => {
  // An empty PATH and a root with no sibling checkout must not invent a path.
  const entry = resolveHarnessEntry({ env: { PATH: '' }, rootDir: join(tmpdir(), 'zstack-no-such-root') });
  assert.equal(entry, null);
  assert.equal(harnessEntryExists(entry), false);
});

test('resolveHarnessEntry: a directory is not a usable entry point', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zstack-harness-'));
  try {
    // A directory satisfies existsSync but cannot be spawned.
    assert.equal(harnessEntryExists({ command: process.execPath, args: [dir] }), false);
    assert.equal(harnessEntryExists({ command: dir, args: [] }), false);
    assert.equal(harnessEntryExists({ command: process.execPath, args: [] }), false);
    assert.equal(harnessEntryExists(null), false);

    // A real file beside it is accepted.
    const file = join(dir, 'harness-cli.js');
    writeFileSync(file, '// stub\n');
    assert.equal(harnessEntryExists({ command: process.execPath, args: [file] }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observeGitStatus: returns null outside a repository instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zstack-nogit-'));
  try {
    assert.equal(observeGitStatus(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HARNESS_EVENTS_SCHEMA is pinned to the schema this client parses', () => {
  // A bump here is a deliberate act: the event shapes above would need review.
  assert.equal(HARNESS_EVENTS_SCHEMA, 1);
});

test('buildProgression: detects a run that stopped at the turn budget', () => {
  // The loop ran the full budget, so it stopped on the limit rather than
  // finishing. This is what makes an empty `content` explicable.
  const capped = buildProgression(
    [runStart(), { type: 'turn', turn: 1, tokens: 10 }, { type: 'turn', turn: 2, tokens: 10 }, { type: 'done', turns: 2, tools: 1, durationMs: 5 }],
    { maxTurns: 2 }
  );
  assert.equal(capped.turnLimitReached, true);
  assert.equal(capped.maxTurns, 2);

  const finished = buildProgression(
    [runStart(), { type: 'turn', turn: 1, tokens: 10 }, { type: 'done', turns: 1, tools: 1, durationMs: 5 }],
    { maxTurns: 8 }
  );
  assert.equal(finished.turnLimitReached, false);
});

test('buildProgression: assumes the harness default budget when none is given', () => {
  const progression = buildProgression([runStart(), { type: 'done', turns: 1, tools: 0 }]);
  assert.equal(progression.maxTurns, HARNESS_DEFAULT_MAX_TURNS);
  assert.equal(progression.turnLimitReached, false);
});

test('explainEmptyContent: distinguishes the reasons an answer can be missing', () => {
  // A real answer needs no explanation.
  assert.equal(explainEmptyContent({ content: 'It has 3 lines.' }), null);

  // Stopped at the budget: the advice is to continue it, or raise the budget
  // for a fresh run. Continuing is named first because it resumes the session
  // rather than repeating the work already done.
  const capped = explainEmptyContent({ content: '', turnLimitReached: true, maxTurns: 3 });
  assert.match(capped, /stopped at its 3-turn limit/);
  assert.match(capped, /--continue/);
  assert.match(capped, /--max-turns/);

  // Nothing said and calls were refused: the advice is --apply.
  const declined = explainEmptyContent({ content: '', turnLimitReached: false, declinedTools: 2 });
  assert.match(declined, /2 calls were declined/);
  assert.match(declined, /--apply/);

  // Nothing said for no identifiable reason: at least point at the steps.
  const unknown = explainEmptyContent({ content: '', turnLimitReached: false, declinedTools: 0 });
  assert.match(unknown, /steps above/);

  // Whitespace is not an answer.
  assert.ok(explainEmptyContent({ content: '   \n ' }));
});

test('failureReasonFromStderr: recovers the harness\'s reason for a failed run', () => {
  // The shape a real failure takes: a numbered line in the transcript, indented
  // behind the renderer's gutter marker. A run that never reached its first turn
  // produces exactly this and nothing else.
  const auth = [
    '',
    '  MODELHITCH \u00b7 harness',
    '  opencode/claude-sonnet-4-6  \u00b7  playbook feature +3 principles',
    '',
    '\u258c \u2716 Provider "opencode" returned HTTP 401: {"type":"error","error":{"type":"AuthError","message":"Missing API key."}}',
    '',
    '\u2500\u2500 run complete \u2500\u2500',
    '  turns       0'
  ].join('\n');
  assert.match(failureReasonFromStderr(auth), /HTTP 401/);
  assert.match(failureReasonFromStderr(auth), /Missing API key/);

  // The reason is the first one, not the last thing the transcript happened to
  // print: a tool failure followed by a summary must still report the cause.
  const twoFailures = '\u258c \u2716 Read (no path) error\n\u258c \u2716 Subagent error\n';
  assert.match(failureReasonFromStderr(twoFailures), /Read \(no path\)/);

  // A transcript with no reason yields null, so the caller keeps its own generic
  // message instead of printing the harness's banner as the explanation.
  assert.equal(failureReasonFromStderr('  MODELHITCH \u00b7 harness\n  run complete\n'), null);
  assert.equal(failureReasonFromStderr(''), null);
  assert.equal(failureReasonFromStderr(undefined), null);

  // A bare `Error:` line is the harness's other spelling for a failed run.
  assert.match(failureReasonFromStderr('[harness] Error: no config at C:\\x\n'), /no config/);
});
