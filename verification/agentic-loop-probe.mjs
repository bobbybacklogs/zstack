#!/usr/bin/env node
/**
 * The core proof: run a task that cannot be answered without touching the
 * filesystem, and show that the harness actually executed tool calls.
 *
 * Read-only mode (apply: false). Mutating calls are declined by the non-TTY
 * gate, which is itself worth seeing.
 *
 * Usage: node verification/agentic-loop-probe.mjs [model] [--apply]
 */
import { runHarnessTask, buildProgression, formatEventLine, finalText } from '../src/harness.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const model = args.find((a) => !a.startsWith('--')) || 'opencode-go/deepseek-v4-pro';

const prompt = [
  'Inspect this repository and report its purpose.',
  'Run exactly one shell command that lists the top-level files and directories.',
  'Then answer in two sentences: the project name, and how many top-level entries exist.'
].join(' ');

console.log(`model  : ${model}`);
console.log(`apply  : ${apply}`);
console.log(`cwd    : ${process.cwd()}\n`);

const result = await runHarnessTask({
  prompt,
  model,
  workspaceDir: process.cwd(),
  apply,
  maxTurns: 6,
  onEvent: (event) => {
    const line = formatEventLine(event);
    if (line) console.log(line);
  }
});

console.log(`\nok=${result.ok} exit=${result.exitCode} events=${result.events.length} malformed=${result.malformed}`);

const toolEvents = result.events.filter((e) => e.type === 'tool');
console.log(`\n--- tool calls executed: ${toolEvents.length} ---`);
for (const event of toolEvents) {
  const argsJson = JSON.stringify(event.args).slice(0, 160);
  console.log(`  ${event.name} outcome=${event.outcome} ${event.durationMs}ms truncated=${event.truncated} bytes=${event.bytes}`);
  console.log(`    args: ${argsJson}`);
}

const approvals = result.events.filter((e) => e.type === 'approval');
console.log(`\n--- approvals: ${approvals.length} ---`);
for (const a of approvals) console.log(`  ${a.tool} -> ${a.decision}${a.risk ? ` (${a.risk})` : ''}`);

const progression = buildProgression(result.events, { model });
console.log(`\nturns=${progression.turns} tools=${progression.toolCount} failed=${progression.failed} declined=${progression.declined}`);
console.log(`final text:\n${finalText(progression).slice(0, 600)}`);

if (!result.ok) {
  console.log('\n--- stderr tail ---');
  console.log(result.stderr.split('\n').slice(-20).join('\n'));
}
