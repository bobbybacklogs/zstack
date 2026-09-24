import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeDiff,
  rankPrinciples,
  splitDiffIntoChunks,
  validateVerdicts
} from '../src/index.mjs';

const FIXTURE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,4 +1,4 @@
-import { legacyHelper, unusedHelper } from './helpers';
+import { legacyHelper } from './helpers';
 export function login(user) {
-  return legacyHelper(user) || unusedHelper(user);
+  return legacyHelper(user);
 }
 `;

function validVerdicts() {
  return [
    {
      principle: 'laziness-protocol',
      applies: true,
      verdict: 'pass',
      rationale: 'Removes dead import and call without adding abstraction.',
      evidence: ["-import { legacyHelper, unusedHelper } from './helpers';"]
    },
    {
      principle: 'experience-first',
      applies: false,
      verdict: 'pass',
      rationale: 'No caller-facing behavior changes.',
      evidence: ['@@ -1,4 +1,4 @@']
    }
  ];
}

describe('principle reasoning grader', () => {
  it('grades a fixture diff with schema-conformant verdicts', async () => {
    const result = await gradeDiff(FIXTURE_DIFF, {
      embeddings: false,
      chat: async () => ({ content: JSON.stringify(validVerdicts()) })
    });
    assert.ok(!result.parseError, `should parse (got ${result.parseError})`);
    const checked = validateVerdicts(result.verdicts);
    assert.equal(checked.ok, true, checked.error);
    assert.equal(result.verdicts.length, 2);
    assert.ok(Array.isArray(result.principles) && result.principles.length > 0);
    assert.equal(result.chunked, false);
  });

  it('never fabricates verdicts on unparseable output', async () => {
    let calls = 0;
    const result = await gradeDiff(FIXTURE_DIFF, {
      embeddings: false,
      chat: async () => {
        calls++;
        return { content: 'this is not json at all {{{' };
      }
    });
    assert.equal(calls, 2, 'should retry once');
    assert.deepEqual(result.verdicts, []);
    assert.ok(result.parseError, 'should report a parse error');
  });

  it('rejects empty diffs', async () => {
    await assert.rejects(() => gradeDiff('   ', { embeddings: false }), /Empty diff/);
  });

  it('ranks principles by keyword overlap in score order', () => {
    const ranked = rankPrinciples(FIXTURE_DIFF, { topN: 4 });
    assert.ok(ranked.length > 0);
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1].score >= ranked[i].score, 'scores must be descending');
    }
    for (const r of ranked) {
      assert.ok(typeof r.id === 'string' && r.id.length > 0);
      assert.ok(typeof r.snippet === 'string');
    }
  });

  it('chunks oversized diffs by file hunk with markers', async () => {
    const big = FIXTURE_DIFF.repeat(400);
    const chunks = splitDiffIntoChunks(big);
    assert.ok(chunks.length > 1, 'oversized diff must produce multiple chunks');
    const result = await gradeDiff(big, {
      embeddings: false,
      chat: async () => ({ content: JSON.stringify(validVerdicts()) })
    });
    assert.equal(result.chunked, true);
  });

  it('validates verdict schemas strictly', () => {
    assert.equal(validateVerdicts([]).ok, false);
    assert.equal(validateVerdicts([{ principle: 'x' }]).ok, false);
    assert.equal(validateVerdicts([{ principle: 'x', applies: true, verdict: 'maybe', rationale: 'r', evidence: [] }]).ok, false);
    assert.equal(validateVerdicts(validVerdicts()).ok, true);
  });
});
