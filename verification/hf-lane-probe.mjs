/**
 * Live probe: does the HuggingFace lane actually work end to end?
 *
 * This is the canary for the claims the lane makes. It is env-gated: it needs
 * a running ModelHitch bridge on 127.0.0.1:3939 with a HuggingFace key, live
 * network access, and a ModelHitch harness on PATH. It spends real tokens.
 *
 *   node verification/hf-lane-probe.mjs [tier]
 *
 * What it proves, in order:
 *   1. The filter resolves roles from the live catalogue, not from a fixture.
 *   2. The resolved model id routes through the gateway: a real completion
 *      comes back. `huggingface/<org>/<model>` carries two slashes, so this is
 *      the check that the provider prefix is split correctly on the wire.
 *   3. The harness accepts that same id as `--model` and the model can call a
 *      tool, which is the property the filter's capability gate exists to
 *      guarantee. A lane of models that cannot call tools would be useless for
 *      `zstack --agent`, and this is what would catch that.
 *
 * Not part of the hermetic suite; it never runs under `npm run verify`.
 */
import { fetchModelHitchState } from '../src/connector.mjs';
import { resolveHuggingFaceLane, isHuggingFaceModel } from '../src/hf.mjs';
import { resolveBudgetMapping } from '../src/budget.mjs';
import { sendChat } from '../src/connector.mjs';
import { runHarnessTask, resolveHarnessEntry } from '../src/harness.mjs';

const tier = process.argv[2] || 'med-high';
const fail = (msg) => { console.error(`\n[✖] ${msg}`); process.exit(1); };

console.log(`zstack HuggingFace lane probe (tier: ${tier})\n`);

// 1. Resolve against the live catalogue.
let state;
try {
  state = await fetchModelHitchState();
} catch (err) {
  fail(`cannot reach the ModelHitch bridge: ${err.message}`);
}
const hfServed = state.models.map(m => m.id).filter(isHuggingFaceModel);
console.log(`[1] gateway serves ${state.models.length} models, ${hfServed.length} of them HuggingFace`);
console.log(`    HF key active: ${!!state.keys['huggingface']}`);
console.log(`    capability metadata: ${state.hfCapabilities?.source ?? 'absent'}`);
if (hfServed.length === 0) fail('no HuggingFace models are served, so the lane cannot be exercised');

const mapping = resolveBudgetMapping({ tier, source: 'catalog', lane: 'hf', state });
if (mapping.lane !== 'hf' || mapping.laneApplied !== true) fail(`lane did not apply: ${mapping.lane}/${mapping.laneApplied}`);
if (mapping.laneNote) console.log(`    note: ${mapping.laneNote}`);
console.log(`[1] filter: considered ${mapping.hfLaneFilter.considered}, admitted ${mapping.hfLaneFilter.admitted}, rejected ${mapping.hfLaneFilter.rejected}`);
console.log(`    coder      ${mapping.models['feature, refactoring']}`);
console.log(`    fast       ${mapping.models['fast exploration']}`);
console.log(`    architect  ${mapping.models['judgment and prose']}`);
console.log(`    reasoner   ${mapping.models['deep reasoning']}`);
console.log(`    panel      ${mapping.panelList.join(', ')}`);
for (const m of [...mapping.panelList, mapping.models['feature, refactoring']]) {
  if (!hfServed.includes(m)) fail(`pinned ${m}, which the gateway does not serve`);
}

// 2. A real completion through the gateway, on the model the lane pinned.
const model = mapping.models['feature, refactoring'];
console.log(`\n[2] one completion via the gateway, model ${model}`);
try {
  const res = await sendChat({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: HF LANE OK' }],
    maxTokens: 32
  });
  const text = String(res.content || '').trim();
  console.log(`    model echoed: ${res.model}`);
  console.log(`    usage: ${JSON.stringify(res.usage)}`);
  console.log(`    reply: ${text.slice(0, 120) || '(empty)'}`);
  if (!text) fail('the model returned no text');
} catch (err) {
  fail(`completion failed: ${err.message} (kind ${err.kind ?? 'n/a'})`);
}

// 3. The harness, with the same id, must let the model call a tool.
console.log(`\n[3] harness tool loop, read-only, max 3 turns`);
const harness = resolveHarnessEntry();
if (!harness) fail('no ModelHitch harness found (mhh on PATH, a sibling checkout, or ZSTACK_HARNESS_BIN)');
console.log(`    harness: ${harness.command} ${harness.args.join(' ')} (via ${harness.source})`);

const events = [];
const result = await runHarnessTask({
  prompt: 'Read the file package.json in the current directory and report only the value of its "name" field.',
  model,
  workspaceDir: process.cwd(),
  apply: false,
  autoApproveSafe: true,
  maxTurns: 3,
  saveSession: false,
  timeoutMs: 180000,
  onEvent: (e) => {
    events.push(e);
    if (e.type === 'tool') console.log(`    tool ${e.name} [${e.outcome}]`);
    if (e.type === 'turn') console.log(`    turn ${e.turn}`);
  }
});
const toolCalls = events.filter(e => e.type === 'tool');
console.log(`    ok=${result.ok} exit=${result.exitCode} turns=${toolCalls.length ? events.filter(e => e.type === 'turn').length : 0} tool calls=${toolCalls.length}`);
if (!result.ok) fail(`harness run failed: ${result.stderr?.slice(-400) || 'no stderr'}`);
if (toolCalls.length === 0) fail('the model called no tool, so tool calling is not actually working on this lane');
if (toolCalls.every(t => t.outcome !== 'ok')) fail(`every tool call failed: ${toolCalls.map(t => `${t.name}:${t.outcome}`).join(', ')}`);

console.log('\n[✓] HuggingFace lane verified: filter resolved, the id routed through the gateway, and the model called a tool.');
