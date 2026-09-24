import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc, validateDocs, ZStack } from '../src/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const VALID = `---
id: perf-issue
title: Performance Issue
applyWhen: Diagnosing slow queries
keywords: [perf, latency, memory]
requires: [prove-it-works]
version: 1
---
# Playbook: Performance Issue
`;

describe('principle frontmatter schema', () => {
  it('parses a full frontmatter block', () => {
    const { data, body, fallback } = parseDoc(VALID, 'playbooks/perf-issue.md');
    assert.equal(fallback, false);
    assert.equal(data.id, 'perf-issue');
    assert.equal(data.title, 'Performance Issue');
    assert.equal(data.applyWhen, 'Diagnosing slow queries');
    assert.deepEqual(data.keywords, ['perf', 'latency', 'memory']);
    assert.deepEqual(data.requires, ['prove-it-works']);
    assert.equal(data.version, '1');
    assert.ok(body.includes('# Playbook'));
  });

  it('parses CRLF line endings with a leading BOM', () => {
    const crlf = '﻿---\r\nid: a\r\ntitle: T\r\nkeywords: [x]\r\n---\r\nbody\r\n';
    const { data, fallback } = parseDoc(crlf, 'x.md');
    assert.equal(fallback, false);
    assert.equal(data.id, 'a');
    assert.deepEqual(data.keywords, ['x']);
  });

  it('does not terminate the block early on body --- lines', () => {
    const text = VALID + '\n---\n\nMore body after a rule.\n';
    const { data, body } = parseDoc(text, 'x.md');
    assert.equal(data.id, 'perf-issue');
    assert.ok(body.includes('More body after a rule.'));
  });

  it('errors on unterminated blocks naming the file', () => {
    assert.throws(() => parseDoc('---\nid: x\ntitle: T\n', 'principles/x.md'), /principles\/x\.md.*unterminated/);
  });

  it('errors on non-array keywords', () => {
    assert.throws(() => parseDoc('---\nid: x\nkeywords: nope\n---\nbody\n', 'x.md'), /keywords.*must be an array/);
  });

  it('falls back for documents without frontmatter', () => {
    const { data, body, fallback } = parseDoc('# Just markdown\n\nNo block.\n', 'x.md');
    assert.equal(fallback, true);
    assert.equal(data, null);
    assert.ok(body.includes('Just markdown'));
  });

  it('errors when id does not match the filename', () => {
    const { errors } = validateDocs([{ source: 'principles/real.md', id: 'other', data: { id: 'other' } }]);
    assert.ok(errors.some(e => e.includes('does not match filename')));
  });

  it('errors on duplicate ids across sets', () => {
    const { ok, errors } = validateDocs([
      { source: 'principles/shared.md', id: 'shared', data: { id: 'shared' } },
      { source: 'playbooks/shared.md', id: 'shared', data: { id: 'shared' } }
    ]);
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('duplicate id')));
  });

  it('all shipped principles and playbooks parse and validate', () => {
    const docs = [];
    for (const [dir, set] of [['playbooks', 'playbook'], ['principles', 'principle']]) {
      for (const file of readdirSync(join(ROOT, dir)).filter(f => f.endsWith('.md'))) {
        const content = readFileSync(join(ROOT, dir, file), 'utf8');
        const parsed = parseDoc(content, `${dir}/${file}`);
        const id = parsed.data?.id || file.replace(/\.md$/, '');
        docs.push({ source: `${dir}/${file}`, id, data: parsed.data, set });
      }
    }
    assert.ok(docs.length >= 35, `want 35+ docs, got ${docs.length}`);
    const { ok, errors } = validateDocs(docs);
    assert.equal(ok, true, errors.join('; '));
  });

  it('keeps existing --json keys unchanged for list indexes', () => {
    const z = new ZStack({ rootDir: ROOT });
    const pb = z.listPlaybooks();
    assert.ok(pb.length > 0);
    for (const key of ['id', 'file', 'path', 'title', 'trigger']) {
      assert.ok(key in pb[0], `playbook entry must keep key ${key}`);
    }
    const pr = z.listPrinciples();
    for (const key of ['id', 'file', 'path', 'title', 'applyWhen']) {
      assert.ok(key in pr[0], `principle entry must keep key ${key}`);
    }
    // Parsed fields are included without changing existing keys.
    assert.ok('keywords' in pb[0] && 'version' in pr[0]);
  });
});
