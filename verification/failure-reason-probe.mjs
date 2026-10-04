/**
 * Probe: does a failed run carry the harness's reason into the SDK result?
 *
 * A run can die before its first turn — an expired key, a provider that rejects
 * the request — and the harness states why on stderr, where zstack used to drop
 * it. The page could therefore only report an exit code, which is the one fact
 * the reader already had. This runs that exact case for real and prints what a
 * caller now receives.
 *
 * Needs a live ModelHitch bridge (for role mapping) and the harness entry point.
 * Usage: node verification/failure-reason-probe.mjs [provider/model]
 */
import { ZStack } from '../src/sdk.mjs';

const model = process.argv[2] || 'opencode/claude-sonnet-4-6';
const z = new ZStack();

const result = await z.agent({
  prompt: 'Reply with exactly: hello',
  model,
  timeoutMs: 120_000,
});

console.log(
  JSON.stringify(
    {
      model,
      ok: result.ok,
      exitCode: result.exitCode,
      turns: result.turns,
      toolCalls: result.toolCalls,
      errorText: result.errorText,
    },
    null,
    2,
  ),
);

const verdict = result.ok === false && typeof result.errorText === 'string' && result.errorText !== ''
  ? 'VERDICT: the failure reason reached the caller.'
  : result.ok === true
    ? 'VERDICT: the run succeeded, so this probe proves nothing — pick a model that fails.'
    : 'VERDICT: the run failed with no recoverable reason (the caller falls back to its generic message).';
console.log(verdict);
