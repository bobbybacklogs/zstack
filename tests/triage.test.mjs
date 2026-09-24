import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  triageFailure,
  heuristicTriage,
  splitFailures,
  capTriageInput
} from '../src/index.mjs';

const JDK_NPE = `Exception in thread "main" java.lang.NullPointerException: Cannot invoke "User.getName()" because "user" is null
	at com.example.Service.process(Service.java:42)
	at com.example.Main.main(Main.java:14)
`;

const MEMORY_LOG = `WARN heap usage 92% after batch import
ERROR memory growing during batch imports, heap exhausted
java.lang.OutOfMemoryError: Java heap space
	at com.example.Import.runBatch(Import.java:88)
`;

const DEADLOCK_LOG = `ERROR deadlock detected between transactions 114 and 115
Transaction 114 waiting on lock held by 115; deadlock graph dumped, connection pool exhausted
`;

describe('failure triage assistant', () => {
  it('ranks bug-fix first for a JDK NullPointerException trace', () => {
    const out = heuristicTriage(JDK_NPE, { maxCandidates: 3 });
    assert.ok(out.length > 0);
    assert.equal(out[0].playbook, 'bug-fix');
    assert.ok(out[0].trigger.length > 0);
    assert.ok(Array.isArray(out[0].nextCommands) && out[0].nextCommands[0].startsWith('zstack '));
  });

  it('ranks perf-issue first for a memory-growth log', () => {
    const out = heuristicTriage(MEMORY_LOG, { maxCandidates: 3 });
    assert.equal(out[0].playbook, 'perf-issue');
  });

  it('ranks runtime-forensics first for a deadlock log', () => {
    const out = heuristicTriage(DEADLOCK_LOG, { maxCandidates: 3 });
    assert.equal(out[0].playbook, 'runtime-forensics');
  });

  it('ranks distinct failures without merging them', () => {
    const blocks = splitFailures(`${JDK_NPE}\n\n${DEADLOCK_LOG}`);
    assert.ok(blocks.length >= 2, `want 2+ blocks, got ${blocks.length}`);
    const out = heuristicTriage(`${JDK_NPE}\n\n${DEADLOCK_LOG}`, { maxCandidates: 3 });
    const ids = out.map(c => c.playbook);
    assert.ok(ids.includes('bug-fix'), `want bug-fix in ${ids}`);
    assert.ok(ids.includes('runtime-forensics'), `want runtime-forensics in ${ids}`);
  });

  it('honors the live JSON contract via an injected role', async () => {
    const out = await triageFailure({
      input: JDK_NPE,
      live: true,
      runRole: async () => JSON.stringify({
        playbook: 'bug-fix',
        confidence: 0.9,
        rationale: 'Null pointer crash in service layer.',
        nextSteps: ['Reproduce with a null user fixture']
      })
    });
    assert.equal(out.heuristicOnly, false);
    assert.equal(out.candidates[0].playbook, 'bug-fix');
    assert.equal(out.candidates[0].confidence, 0.9);
  });

  it('falls back with an explicit notice on unparseable model output', async () => {
    let calls = 0;
    const out = await triageFailure({
      input: MEMORY_LOG,
      live: true,
      runRole: async () => {
        calls++;
        return 'not json {{{';
      }
    });
    assert.equal(calls, 2, 'must retry once');
    assert.equal(out.heuristicOnly, true);
    assert.ok(out.notice && out.notice.includes('heuristic only'));
    assert.equal(out.candidates[0].playbook, 'perf-issue');
  });

  it('drops unknown playbook ids from the model and notes it', async () => {
    const out = await triageFailure({
      input: JDK_NPE,
      live: true,
      runRole: async () => JSON.stringify({ playbook: 'nope-unknown', confidence: 1, rationale: 'x', nextSteps: [] })
    });
    assert.equal(out.heuristicOnly, true);
    assert.ok(out.notice.includes('heuristic only'));
  });

  it('rejects empty input and caps oversized input with markers', async () => {
    await assert.rejects(() => triageFailure({ input: '   ' }), /Empty triage input/);
    const big = 'line\n'.repeat(20000);
    const capped = capTriageInput(big, { budgetTokens: 100 });
    assert.equal(capped.trimmed, true);
    assert.ok(capped.text.includes('omitted lines'));
    assert.throws(() => capTriageInput(big, { budgetTokens: 100, noPrune: true }), /--no-prune/);
  });

  it('decodes binary bytes with replacement instead of throwing', () => {
    const buf = Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x0a, 0x45, 0x72, 0x72, 0x6f, 0x72]);
    const out = heuristicTriage(buf, { maxCandidates: 3 });
    assert.ok(Array.isArray(out));
  });
});
