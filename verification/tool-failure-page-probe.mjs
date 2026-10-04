/**
 * Probe: does a failed tool call reach the run page with its reason?
 *
 * The harness now puts a failed call's own text on its `tool` event. This drives
 * the real path end to end — registry → harness → progression → stored record →
 * page projection — and prints what a reader would actually be shown, because a
 * field that reaches the event and dies in the projection is the same as no fix
 * at all.
 *
 * Writes to a throwaway history file, never the real one. Needs a live
 * ModelHitch bridge (for role mapping) and the sibling ModelHitch checkout.
 *
 * Usage: node verification/tool-failure-page-probe.mjs [provider/model]
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunRegistry } from '../src/runs.mjs';
import { projectStoredRun } from '../src/blocks.mjs';

const model = process.argv[2] || 'opencode-go/gpt-5.6-luna';
const historyPath = join(mkdtempSync(join(tmpdir(), 'zstack-probe-')), 'history.jsonl');

const registry = new RunRegistry({ historyPath });
const live = registry.start({
  prompt: "Call the subagent tool with agent 'definitely-not-an-agent' and task 'do nothing'. Then reply DONE.",
  model,
  policy: 'apply',
  maxTurns: 3,
  workspaceDir: process.cwd()
});

// The registry returns as soon as the run has an id; the page is only worth
// reading once it has settled.
const deadline = Date.now() + 180_000;
while (!live.settled && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const page = registry.getPage(live.id);
console.log(`run ${live.id} settled=${live.settled} status=${page?.status}`);
const failed = (page?.blocks ?? []).filter((b) => b.kind === 'tool' && b.tone === 'error');
if (failed.length === 0) {
  console.log('No failed tool call was recorded, so this run proves nothing about the failure path.');
  process.exit(1);
}
const first = failed[0];
console.log(`tool block: ${first.name} ${first.outcome} ${first.durationText}`);
console.log(`reason on the live page: ${first.output}`);

// The same run, re-opened from history: the record is what a reader returns to.
const record = JSON.parse(readFileSync(historyPath, 'utf8').trim().split('\n').at(-1));
const storedToolSteps = (record.steps ?? []).filter((s) => s.kind === 'tool');
console.log(`stored tool steps: ${storedToolSteps.length}, with a reason: ${storedToolSteps.filter((s) => s.output).length}`);
console.log(`stored turns: ${(record.steps ?? []).filter((s) => s.kind === 'turn').map((s) => s.turn).join(',')}`);
const stored = projectStoredRun(record);
const storedFailed = stored.blocks.filter((b) => b.kind === 'tool' && b.tone === 'error');
console.log(`reason on the stored page: ${storedFailed[0]?.output}`);

const verdict = first.output && storedFailed[0]?.output
  ? 'VERDICT: the failure reason reaches both the live page and the stored record.'
  : 'VERDICT: the reason reached the event but not the page.';
console.log(verdict);
