import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZStack,
  CLASSIFY_CONFIDENCE_THRESHOLD,
  CLASSIFY_AMBIGUITY_MARGIN,
  CLASSIFY_MAX_CANDIDATES
} from '../src/index.mjs';

describe('guided playbook selection', () => {
  const z = new ZStack();

  it('keeps classifyPrompt backward compatible', () => {
    const out = z.classifyPrompt('Fix memory leak in web socket handler');
    assert.equal(out.type, 'perf-issue');
    assert.equal(out.playbookFile, 'playbooks/perf-issue.md');
    assert.ok(Array.isArray(out.principles) && out.principles.length > 0);
    assert.equal(out.candidates, undefined);
  });

  it('ranks perf-issue first for memory growth during batch imports', () => {
    const detailed = z.classifyPromptDetailed('Why is memory growing during batch imports?');
    assert.ok(detailed.candidates.length >= 1);
    assert.equal(detailed.candidates[0].type, 'perf-issue');
    assert.equal(detailed.type, 'perf-issue');
    assert.equal(detailed.playbookFile, 'playbooks/perf-issue.md');
  });

  it('orders candidates by score with match reasons', () => {
    const detailed = z.classifyPromptDetailed('Fix slow CSS regression on the login page');
    const ids = detailed.candidates.map(c => c.type);
    assert.ok(ids.includes('bug-fix'), 'should include bug-fix');
    assert.ok(ids.includes('perf-issue'), 'should include perf-issue');
    assert.ok(ids.includes('visual-parity'), 'should include visual-parity');
    // bug-fix has two keyword hits (fix + regression) so it must lead.
    assert.equal(detailed.candidates[0].type, 'bug-fix');
    for (const c of detailed.candidates) {
      assert.ok(typeof c.score === 'number' && c.score > 0);
      assert.ok(typeof c.reason === 'string' && c.reason.includes('matched'));
      assert.ok(c.playbookFile === `playbooks/${c.type}.md`);
    }
    assert.ok(detailed.candidates.length <= CLASSIFY_MAX_CANDIDATES);
  });

  it('marks single strong matches confident and close races ambiguous', () => {
    const confident = z.classifyPromptDetailed('Authoring a skill for webhook retries');
    assert.equal(confident.ambiguous, false);
    assert.equal(confident.candidates.length, 1);

    // perf-issue (slow) vs bug-fix (bug) tie on one hit each: margin 0 -> ambiguous.
    const race = z.classifyPromptDetailed('Slow CSS bug on the login page');
    assert.equal(race.ambiguous, true);
    assert.ok(['perf-issue', 'bug-fix', 'visual-parity'].includes(race.candidates[0].type));
  });

  it('documents the confidence threshold and margin', () => {
    assert.equal(CLASSIFY_CONFIDENCE_THRESHOLD, 1.0);
    assert.equal(CLASSIFY_AMBIGUITY_MARGIN, 0.5);
    assert.equal(CLASSIFY_MAX_CANDIDATES, 3);
  });

  it('falls back to feature with no candidates on empty matches', () => {
    const detailed = z.classifyPromptDetailed('zzzqqq no keywords here 12345');
    assert.equal(detailed.type, 'feature');
    assert.deepEqual(detailed.candidates, []);
    assert.equal(detailed.ambiguous, false);
  });
});
