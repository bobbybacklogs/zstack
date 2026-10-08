---
name: verify-zstack
description: Verify that zstack behaves as documented in docs/FEATURE_MAP.md. Runs the hermetic default suite (all offline node:test checks) and the optional live ModelHitch/network canaries. Use whenever a change claims to preserve or alter zstack behavior, before opening a PR.
---

# verify-zstack

Proves zstack behavior against the live artifact: the automated test suite and CLI probes.
This skill reads `docs/FEATURE_MAP.md` as the canonical behavior contract and the map does
the same verification, so the map and this skill never drift apart.

## Run the default (hermetic) verify

No secrets. No network beyond loopback stubs. No ModelHitch bridge required.

```bash
npm test             # historical suite entrypoint: full connector live + unit mix (may be red without a bridge)
npm run verify       # hermetic default: all offline unit suites + the connector failure-hardening suite
```

`npm run verify` must exit `0` when every covered check passes, `1` when any covered check
fails, `2` on a runner usage error.

Expected output (TAP summary per suite, then a total):

```
ok      budget: 8 passed, 0 failed
ok      classify: 6 passed, 0 failed
...
ok      connector (hermetic: gateway failure hardening): 7 passed, 0 failed
---
Total: 85 passed, 0 failed
```

## Scope

### Covered by the hermetic default (must be green)

| Area | Tests |
| :--- | :--- |
| SDK indexes, manifest/frontmatter, JSON CLI shape, exit codes 2/3 | `manifest`, `cli-json`, `connector` (SDK class suites are offline except the live-gated cases) |
| Classification, confidence rules, semantic router + embedding cache, cosine | `classify`, `router` |
| Gateway failure hardening: timeout, retry, Retry-After, parse errors, POST-once | `connector` (`gateway failure hardening` suite only) |
| Context budget, budget tiers/persistence | `context`, `budget` |
| Provider lanes, the HuggingFace filter and lane resolution, routine dialog lane choices | `budget`, `hf`, `web-lanes` (`cli-json` drives `zstack hf` against a loopback stub gateway) |
| Grading, triage (heuristic + injected live contract), offload subagent, history, shell | `grader`, `triage`, `subagent`, `history`, `shell` |

### Env-gated (optional, excluded from `npm run verify`)

Add `-l` / `--live`, or run `npm run verify:live`, on a dev box with a live ModelHitch bridge
on `MODELHITCH_BASE_URL` (default `http://127.0.0.1:3939`) and network access:

```bash
npm run verify:live
```

Covers:
- `checkBridgeHealth`, `fetchModelHitchState`, `resolveRoleMapping` against the real bridge
- live `sendChat` / `z.task` end-to-end prompt execution
- upstream `checkUpstream` GitHub API canary (`cursor/plugins` pstack)

These checks report as failed under `--live` when the bridge or network is absent, but the
hermetic default exit code is unaffected. Per the map, these live paths are the ones not
covered by hermetic CI.

### Known gaps (see docs/FEATURE_MAP.md)

- `zstack sync` Cursor-rule file artifact
- `zstack update --apply` checkpoint recording
- `zstack budget --confirm` apply flow
- live provider-to-role routing decisions

## Interpreting a red run

Rules:

1. Never edit `docs/FEATURE_MAP.md` to match broken behavior. The map is the contract.
2. A red hermetic suite means a real regression. Fix the code or the test, not the map.
3. A red live canary with a green hermetic default means the bridge/network is absent, not
   that the product regressed. Record it as an env-gated gap in the PR body.

## Evidence for a PR

Capture both the exit code and the summary:

```bash
npm run verify; echo "verify exit: $?"
npm run verify -- --json    # machine-readable evidence document
```

Paste the exit code and the `Total: N passed, M failed` line into the PR body.