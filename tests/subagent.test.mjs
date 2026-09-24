import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runContextOffload,
  rankOffloadFiles,
  walkPaths,
  formatOffloadReport
} from '../src/index.mjs';

const SENTINEL = 'SENTINEL_SECRET_BODY_XYZ_123';

function makeWorkspace(structure) {
  const dir = mkdtempSync(join(tmpdir(), 'zstack-offload-'));
  for (const [name, content] of Object.entries(structure)) {
    const full = join(dir, name);
    const parts = name.split('/');
    if (parts.length > 1) {
      mkdirSync(join(dir, parts.slice(0, -1).join('/')), { recursive: true });
    }
    if (Buffer.isBuffer(content)) {
      writeFileSync(full, content);
    } else {
      writeFileSync(full, content, 'utf8');
    }
  }
  return dir;
}

function stubFetch({ chatContent, onChat } = {}) {
  const calls = { config: 0, models: 0, chat: 0 };
  const json = obj => ({
    status: 200,
    ok: true,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(obj),
    json: async () => obj
  });
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/v1/config')) {
      calls.config++;
      return json({ keys: { openai: 'x' }, defaultProviderId: 'openai', defaultModel: 'gpt-5.6-luna' });
    }
    if (url.endsWith('/v1/models')) {
      calls.models++;
      return json({ data: [{ id: 'openai/gpt-5.6-luna' }] });
    }
    if (url.endsWith('/v1/chat/completions') && init.method === 'POST') {
      calls.chat++;
      const body = JSON.parse(init.body);
      if (onChat) onChat(body);
      const content = typeof chatContent === 'function' ? chatContent(calls.chat) : chatContent;
      return json({ model: 'openai/gpt-5.6-luna', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    return { status: 404, ok: false, headers: { get: () => null }, text: async () => 'nope', json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const VALID_ANSWER = JSON.stringify({
  findings: [{ file: 'src/context.mjs', line: 10, claim: 'Trimming lives here.', confidence: 0.9 }],
  answer: 'Context trimming is implemented in src/context.mjs.',
  uncovered: []
});

describe('context offload subagent', () => {
  it('ranks filename matches above body-only matches', () => {
    const ranked = rankOffloadFiles('context budget trimming', [
      { file: 'src/notes.md', content: 'context budget trimming '.repeat(50) },
      { file: 'src/context-budget.ts', content: 'unrelated filler text here' }
    ]);
    assert.equal(ranked[0].file, 'src/context-budget.ts');
    assert.ok(ranked[0].fileHits > 0);
  });

  it('walks paths while skipping node_modules, .git, and dotfiles', async () => {
    const dir = makeWorkspace({
      'src/a.ts': 'context budget trimming marker',
      '.hidden': 'context budget secret',
      'node_modules/pkg/i.js': 'context budget vendored',
      '.git/HEAD': 'context budget ref'
    });
    const files = await walkPaths([dir]);
    assert.ok(files.some(f => f.endsWith('a.ts')));
    assert.ok(!files.some(f => f.includes('node_modules')));
    assert.ok(!files.some(f => f.includes('.hidden')));
    assert.ok(!files.some(f => f.includes('.git')));
  });

  it('attaches matching files and returns a distilled report', async () => {
    const dir = makeWorkspace({
      'src/context.mjs': `export function planContext() { /* ${SENTINEL} trimming logic */ }\n`,
      'docs/unrelated.md': 'notes about lunch menus and parking'
    });
    let sawPrompt = '';
    const { fetchImpl, calls } = stubFetch({
      chatContent: VALID_ANSWER,
      onChat: body => { sawPrompt = body.messages[0].content; }
    });
    const result = await runContextOffload(
      { query: 'context budget trimming', paths: [dir], fetchImpl },
      {}
    );
    assert.equal(result.ok, true);
    assert.equal(result.filesAttached, 1);
    assert.ok(result.filesScanned >= 2);
    assert.ok(sawPrompt.includes('src/context.mjs'), 'subagent payload must include the match');
    assert.deepEqual(result.findings[0].file, 'src/context.mjs');
  });

  it('enforces the byte cap with omission markers', async () => {
    const dir = makeWorkspace({
      'src/big.ts': 'context budget trimming\n' + 'filler line\n'.repeat(2000)
    });
    const { fetchImpl } = stubFetch({ chatContent: VALID_ANSWER });
    const result = await runContextOffload(
      { query: 'context budget trimming', paths: [dir], budgetTokens: 100, fetchImpl },
      {}
    );
    assert.equal(result.ok, true);
    assert.equal(result.filesAttached, 1);
    assert.ok(result.omitted.some(o => o.includes('byte cap') || o.includes('maxFileBytes')));
  });

  it('truncates single files exceeding maxFileBytes instead of skipping', async () => {
    const dir = makeWorkspace({
      'src/huge.ts': 'context budget trimming\n' + 'x'.repeat(5000)
    });
    const { fetchImpl } = stubFetch({ chatContent: VALID_ANSWER });
    const result = await runContextOffload(
      { query: 'context budget trimming', paths: [dir], maxFileBytes: 500, fetchImpl },
      {}
    );
    assert.equal(result.filesAttached, 1);
    assert.ok(result.omitted.some(o => o.includes('maxFileBytes')));
  });

  it('skips binary files with a note', async () => {
    const dir = makeWorkspace({
      'src/binary.dat': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
      'src/real.ts': 'context budget trimming implementation'
    });
    const { fetchImpl } = stubFetch({ chatContent: VALID_ANSWER });
    const result = await runContextOffload(
      { query: 'context budget trimming', paths: [dir], fetchImpl },
      {}
    );
    assert.equal(result.filesAttached, 1);
    assert.ok(result.omitted.some(o => o.includes('binary')));
  });

  it('retries once on malformed JSON then fails without fabricating', async () => {
    const dir = makeWorkspace({ 'src/a.ts': 'context budget trimming here' });
    const { fetchImpl, calls } = stubFetch({ chatContent: 'garbage {{{' });
    const result = await runContextOffload(
      { query: 'context budget trimming', paths: [dir], fetchImpl },
      {}
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'parse-error');
    assert.equal(calls.chat, 2);
    assert.deepEqual(result.findings, []);
  });

  it('never returns raw file bodies to the caller', async () => {
    const dir = makeWorkspace({
      'src/secret.ts': `context budget trimming\n${SENTINEL}\n${'body line\n'.repeat(100)}`
    });
    const { fetchImpl } = stubFetch({ chatContent: VALID_ANSWER });
    const result = await runContextOffload(
      { query: 'context budget trimming', paths: [dir], fetchImpl },
      {}
    );
    assert.ok(!JSON.stringify(result).includes(SENTINEL), 'no returned field may contain raw file body text');
  });

  it('returns ok with no dispatch when nothing matches', async () => {
    const dir = makeWorkspace({ 'src/a.ts': 'completely unrelated lunch notes' });
    const { fetchImpl, calls } = stubFetch({ chatContent: VALID_ANSWER });
    const result = await runContextOffload(
      { query: 'quantum chromodynamics lattice', paths: [dir], fetchImpl },
      {}
    );
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'No matching files for query.');
    assert.equal(result.filesAttached, 0);
    assert.equal(calls.chat, 0, 'must not dispatch without matches');
  });

  it('formats a human-readable report', () => {
    const text = formatOffloadReport({
      ok: true,
      answer: 'Trimming lives in src/context.mjs.',
      findings: [{ file: 'src/context.mjs', line: 10, claim: 'Trimming lives here.' }],
      uncovered: ['edge case docs'],
      filesScanned: 5,
      filesAttached: 1,
      estimatedTokens: 100
    });
    assert.ok(text.includes('Trimming lives in src/context.mjs.'));
    assert.ok(text.includes('src/context.mjs:10'));
  });
});
