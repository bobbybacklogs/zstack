# zstack Feature Map

Canonical, gardener-maintained catalog of what zstack does today, and how to prove it.
Claims are either proven by an automated check or explicitly marked as a gap. This map never
describes broken behavior as if it worked.

See also: `docs/featList.md` is the upstream feature request list that seeded the CLI surface.
This map is the verified counterpart: it records only behavior that the live code and test
suite actually exercise. `FEATURE_MAP.md` is the canonical gardener map; `featList.md` is left
as the historical backlog source signal and is not maintained here.

## How to read the proof column

| Tag | Meaning |
| :--- | :--- |
| `tests/<name>.test.mjs` | Proven by an automated node:test suite (hermetic unless noted) |
| `CLI` | Proven by a probe run of `bin/zstack.mjs` (see [Verification](#verification)) |
| `GAP` | Claimed by docs or backlog but not proven by any automated check in this repo |

## Convention

- Hermetic = runs offline, no secrets, no network beyond loopback stubs.
- Env-gated = needs the ModelHitch bridge, network, or an env var; skipped by the default verify.

---

## Core SDK & manifest

| Feature | Behavior to preserve | Proof |
| :--- | :--- | :--- |
| Playbook index | Exactly **15** playbooks resolve from `playbooks/*.md`, ids equal filenames | `tests/manifest.test.mjs` (`all shipped principles and playbooks parse and validate`), `tests/sdk` in `connector.test.mjs` (`lists playbooks and principles`) |
| Principle index | Exactly **20** principles resolve from `principles/*.md` | `connector.test.mjs` (`lists playbooks and principles`) |
| Frontmatter contract | Leading `---` block (`id`, `title`, `applyWhen`, `keywords`, `requires`, `version`) parses dependency-free; no-frontmatter docs fall back to legacy extraction with a stderr warning; mismatched id vs filename, duplicate ids, non-array keywords, unterminated blocks are errors | `tests/manifest.test.mjs` |
| SDK surface | `ZStack` exports classifiers, task, panel, runRole, about, budget, upstream, index listing, and the module files re-exported from `src/index.mjs` | `src/index.mjs`, `src/index.d.ts`; exercised throughout `tests/` |
| `zstack --about` | Prints architecture, tenets, package metadata; stable exit 0 | `CLI` (probe offline) |
| `zstack playbooks --json` / `--json` output shape | Single JSON doc `{ ok: true, playbooks: [...] }` on stdout; diagnostics on stderr | `tests/cli-json.test.mjs`; `CLI` (probe returns 15 ids) |
| `zstack principles --json` | Single JSON doc `{ ok: true, principles: [...] }`; 20 entries | `tests/cli-json.test.mjs`; `CLI` (probe returns 20) |
| `zstack version` | Prints `zstack v0.1.0` | `CLI` |

## Classifier & guided routing

| Feature | Behavior to preserve | Proof |
| :--- | :--- | :--- |
| Keyword classification | `classifyPrompt` maps memory-ish prompts to `perf-issue`, OAuth/feature wording to `feature`, cleanup wording to `refactoring`; `perf-issue` leads candidates for memory-growth prompts | `tests/classify.test.mjs`, `connector.test.mjs` (`classifies prompts into appropriate playbooks`) |
| Confidence rules | Confident iff top score >= 1.0 with >= 0.5 margin; close races flagged ambiguous; `CLASSIFY_CONFIDENCE_THRESHOLD`, `CLASSIFY_AMBIGUITY_MARGIN`, `CLASSIFY_MAX_CANDIDATES` exported | `tests/classify.test.mjs` |
| Semantic router | Ambiguous keyword matches are refined by embedding similarity when the gateway is reachable; **falls back silently to the keyword result (null) when unreachable** | `tests/router.test.mjs` (stub server + unreachable probe) |
| Embedding cache | `verification/playbook-embeddings.json`, content-hash keyed; `getPlaybookEmbeddings` reuses cache with zero refetches; model `ROUTER_EMBEDDING_MODEL` (default `openai/text-embedding-3-small`), `ZSTACK_EMBEDDING_MODEL` override | `tests/router.test.mjs` |
| Cosine similarity | `cosineSimilarity` returns 1/0/0 for orthogonal, empty, mismatched vectors | `tests/router.test.mjs` |

## Gateway connector (ModelHitch)

| Feature | Behavior to preserve | Proof |
| :--- | :--- | :--- |
| Bridge health / state | `checkBridgeHealth`, `fetchModelHitchState` reach the bridge at `MODELHITCH_BASE_URL` or `http://127.0.0.1:3939` | **Env-gated**: `connector.test.mjs` live tests fail when no bridge is up; stub-routed variants pass `tests/router.test.mjs` |
| Role mapping | `resolveRoleMapping` assigns a model for every key of `ZSTACK_ROLES` (and `mapping.models`) and >= 1 panel model | Env-gated live + `budget.test.mjs` (`resolves catalog mappings across all 15 roles`) |
| Timeout | Default `DEFAULT_GATEWAY_TIMEOUT_MS` 30000; overridable per call and via `MODELHITCH_TIMEOUT`; stalls classify as `timeout` (AbortController), not hang | `tests/connector.test.mjs` |
| Retry policy | Idempotent GETs retry <= 3 with exponential backoff; 429 honors `Retry-After`; retries 502/503/504; never 400/401/403/404/422; POSTs attempted exactly once | `tests/connector.test.mjs` |
| Structured failures | Failures throw `GatewayError { kind: 'unreachable'\|'timeout'\|'http'\|'parse', status, message, baseUrl, attempts }`; malformed JSON bodies are `parse` | `tests/connector.test.mjs` |
| Exit-code map | CLI exits 0 success, 1 failure, 2 usage, 3 gateway unreachable, 4 partial panel; `--json` emits `{ ok: false, error, ... }` on failures | `tests/cli-json.test.mjs` (exit 2 + 3), `bin/zstack.mjs:EXIT` |

> Note: the `npm test` live suite (`tests/connector.test.mjs` first two describe blocks and upstream)
> requires a running ModelHitch bridge on `127.0.0.1:3939` and network. These are the only
> env-gated checks; the default `npm run verify` covers them as optional canaries.

## Task execution & context budget

| Feature | Behavior to preserve | Proof |
| :--- | :--- | :--- |
| Task with playbook | `z.task({ prompt, playbook })` returns model content, usage, and echoes the playbook; requires ModelHitch | **Env-gated** live test |
| Context budgeter | Default 12000 tokens (`~4 chars/token`); oversized file bodies truncate with `[... omitted lines X-Y ...]` markers; trailing principles drop with a note; `--no-prune` aborts instead of trimming | `tests/context.test.mjs` |
| Budget tiers | Four tiers (`low-med`, `med-high`, `high`, `max`): catalog source maps every tier across all 15 roles; config source strictly uses ModelHitch config policy; tier/source persists to `verification/budget.json`; unknown tier falls back to `med-high` | `tests/budget.test.mjs` |
| Agentic execution (`z.agent`, `--agent`/`--apply`/`--project`) | Runs the ModelHitch harness tool loop: tools execute and results feed back until done or `--max-turns`. Delegation is what makes the loop real, so `task()` stays one completion and `agent()` is the only path that can change files | `tests/harness.test.mjs` (event parsing, progression, arg building); **Env-gated** live: `verification/agentic-loop-probe.mjs` |
| Harness entry resolution | Resolves `ZSTACK_HARNESS_BIN`, then a sibling ModelHitch checkout (`dist/harness-cli.js`), then `mhh` on `PATH`; returns `null` rather than guessing, and rejects a directory, which `existsSync` alone would accept | `tests/harness.test.mjs` |
| Run event stream | Parses the harness `--json-events` NDJSON stream (schema 1) across chunk boundaries; tolerates a partial trailing line, blank lines, and garbage without losing surrounding records; counts malformed lines | `tests/harness.test.mjs` |
| Progression reduction | One run reduces to turns, tool calls, per-outcome counts (ok/error/declined/truncated), approvals, model prose in turn order, and the files a successful writer tool touched; declined writes are never counted as changes; a provider-qualified model is not double-prefixed | `tests/harness.test.mjs` |
| Read-only safety default | Without `--apply`, mutating calls are declined rather than run; `--auto-approve-safe` (on by default for read-only runs) approves only calls the harness risk-classifies `safe`, so `ls`/`cat`/`grep` run while a write or a listening server does not | **Env-gated** live: `verification/agentic-loop-probe.mjs` (declined vs approved) |
| Change observation | Writer-tool attribution plus `git status --porcelain` when the workspace is a repository, because a model writing through `node -e` or a shell redirect changes the tree with no attributable call. Outside a repository the CLI says what is unconfirmed instead of claiming nothing changed | `tests/harness.test.mjs` (`observeGitStatus` outside a repo); **Env-gated** live for the git path |
| Agentic run history | An agentic run persists its progression in `history.jsonl` (turns, tool calls, outcomes, approvals, changed files, steps); steps cap at 200 with `stepsTruncated` marking a capped list; single-completion runs carry none of these fields; `zstack history --steps` renders them and never prints an `undefined` field | `tests/history.test.mjs` |

## Grade, triage, offload, history, shell

| Feature | Behavior to preserve | Proof |
| :--- | :--- | :--- |
| Principle grading | Grades a diff against the 20 principles with pass/warn/fail verdicts; strict JSON schema; oversized diffs chunk by file hunk; unparseable output is reported (retry once for full path), never fabricated | `tests/grader.test.mjs` |
| Failure triage | Heuristic keyword ranking (bug-fix/perf-issue/runtime-forensics first for the canonical fixtures); live JSON path via `runRole` when reachable and `--live`/default; falls back with explicit `[!] heuristic only` notice; unknown ids dropped and noted; empty input rejects; binary bytes decode with replacement | `tests/triage.test.mjs`; `CLI` (offline heuristic JSON probe) |
| Context offload (`zstack explore`) | Walks paths skipping `node_modules/.git/dotfiles`; ranks filename > body; caps bytes with omission markers; retries parse once then `ok:false` without fabricating; raw file bodies never returned; `--json` single doc; exit 2 missing query / non-positive `--max-files` | `tests/subagent.test.mjs` |
| Run history | One JSONL line per run in `~/.zstack/history.jsonl` (`ZSTACK_HISTORY_PATH` override); newest first with `--limit`; malformed lines skipped and counted; preview cap 200 chars with `--yes` guard on `--rerun`; non-zero runs recorded `ok:false`; unwritable path warns once, never fails the task | `tests/history.test.mjs`; `CLI` (offline JSON probe) |
| Interactive shell / repl | Persists sticky playbook, files, role, model, json mode; slash commands (`/playbook`, `/files`, `/role`, `/model`, `/json`, `/context`, `/status`, `/help`, `/exit`); unknown commands reprint help and stay alive; empty lines ignored; SIGINT and EOF exit 0; non-TTY stdin exits 2 unless `ZSTACK_SHELL_FORCE` | `tests/shell.test.mjs` |
| `status`/`sync`/`update` | `status` reports bridge health and role mappings; `sync` writes Cursor rules; `update` checks upstream `cursor/plugins` pstack via GitHub API and records `verification/upstream-sync.json` | `status`/`sync`: **Env-gated** (live only). `update` state read/write: hermetic; **GitHub API call is env/network**-gated (`connector.test.mjs` upstream test fails offline) |

## Local UI (`zstack serve`)

| Feature | Behavior to preserve | Proof |
| :--- | :--- | :--- |
| Run addressing | Every appended record carries a sortable unique `id`; records written before ids existed get a stable id derived from the hash of their own stored line, so appending never renumbers existing runs | `tests/history.test.mjs` (`run addressing`) |
| Tail read | `readHistoryTail(n)` returns the same newest-first records as a full scan at any limit, growing one bounded window from the end of the file; reads multi-chunk files without corrupting multi-byte characters; skips a malformed line without losing neighbours | `tests/history.test.mjs` |
| Page projection | A stored run becomes `{ id, title, props, blocks }`; an agentic run yields callout, prose, turn dividers, approvals, tool blocks, notices, and a file-change summary; a single-completion run says it has no progression instead of rendering an empty body; `stepsTruncated` yields a partial-progression notice; every block kind carries the fields its kind implies | `tests/blocks.test.mjs` |
| Live projection | Consecutive `text` deltas merge into one prose block per turn; a closed turn clears its streaming flag; the opening callout moves to past tense; the closing summary is written on finish (where the outcome is known) rather than on `done`; a writer counts as a file change and a successful read does not; declined is counted apart from failed | `tests/blocks.test.mjs` |
| One block vocabulary | A live page and an archived page emit the same set of block kinds, so "live view" and "history view" cannot disagree | `tests/blocks.test.mjs` (`renders a live page in the shape the archive uses`) |
| Run registry | `start()` returns an id before the first model call; a UI run is recorded to `history.jsonl` in the CLI's exact field shape, so `zstack history` reads it; `ok:false` runs are recorded; a missing harness becomes a failed page rather than a lost run; retained finished runs are bounded; `shutdown()` releases subscribers | `tests/runs.test.mjs` |
| Run cancellation | `cancel()` aborts the harness process; the run settles through the normal path as `cancelled`, is recorded with `errorKind: 'cancelled'`, and renders as "stopped" rather than failed | `tests/runs.test.mjs`; `tests/server.test.mjs` |
| Event stream | SSE with one numbered entry per log record; `Last-Event-ID` or `?since=` replays exactly the entries after that sequence number with no gap and no duplicate; a finished run's stream closes instead of hanging; a live run streams before it ends | `tests/server.test.mjs` |
| HTTP surface | `GET /api/health`, `GET /api/runs` (tail read, live runs merged without duplication, `hasMore` rather than an unaffordable total), `GET /api/runs/:id`, `POST /api/runs`, `POST /api/runs/:id/cancel`, `GET /api/runs/:id/events`, `GET /api/config`, `PUT /api/budget`, `GET /api/status`; wrong method on a known path is 405; unknown path is 404 | `tests/server.test.mjs` |
| Request validation | `POST /api/runs` reports every fault at once; bodies over 256 KiB are refused with 413; a non-JSON or non-object body is refused with 400 | `tests/server.test.mjs` |
| Local-only binding | Binds `127.0.0.1` by default; a `Host` header naming a host the server does not answer for is refused with 403 (DNS-rebinding defence); a state-changing request from another origin is refused with 403; `EADDRINUSE` fails with exit 2 and names `--port` instead of silently choosing another port | `tests/server.test.mjs` |
| Static serving | Assets resolve inside `web/`; `..` segments, percent-encoded traversal, backslash traversal, and NUL are all refused, and every accepted path is verified to be inside the root | `tests/server.test.mjs` |
| Projects | A project is a name plus an existing directory in `~/.zstack/projects.json` (`ZSTACK_PROJECTS_PATH` override), written atomically; create reports every validation problem at once; rename keeps the id runs refer to; delete keeps the runs, which list under no project; a corrupted file yields an empty list rather than taking down the server | `tests/projects.test.mjs` |
| Project defaults | `defaultPlaybook`/`defaultPolicy` stored per project; unknown values fault (an empty catalogue skips the playbook check rather than refusing everything); an empty string clears a default; the composer pre-selects them but an explicit choice always wins; a default naming something the server never loaded faults with the project's name | `tests/projects.test.mjs`; `tests/server.test.mjs` (`projects`) |
| Run page project link | Live and archived pages carry `projectName` when the project still exists; a deleted project's page omits the key rather than linking nowhere; live names resolve per projection so a rename lands without a re-read | `tests/server.test.mjs` (`projects`) |
| Project runs | A run records `projectId` next to `workspace` in history; starting with `projectId` executes in the stored directory and reports an unknown id or a contradictory workspaceDir as 400; the project page lists archived runs (by scan with constant memory, so deep runs are not silently dropped) plus live runs; the main list annotates each card with its project name | `tests/server.test.mjs` (`projects`) |
| Run rename/move/delete | `PATCH /api/runs/:id` sets a custom title (empty clears it) or a `projectId` (null detaches), validated against the project list with every problem at once; `DELETE /api/runs/:id` hides the run from every list without rewriting history; pages still resolve by id after delete; page, card, and project listing agree, live and archived; a patch for an unknown run is 404 and writes nothing | `tests/overrides.test.mjs`; `tests/server.test.mjs` (`projects`) |
| Client | Vanilla ES modules and one stylesheet, no build step and no dependency; hash routing so the server needs no catch-all and a missing asset is a real 404; live blocks patched by index rather than re-rendering the page; all model output and paths assigned as `textContent` | **GAP** (driven manually against a running server; not covered by an automated suite) |

## Known gaps (claimed but unproven)

These are asserted in `featList.md` or the README but have no automated proof in this repo yet.
They are documented here because the probe proves the CLI surface exists, but behavior beyond
"command runs" is not covered:

- **Syncing Cursor / editor rule files** (`zstack sync --project` writes `.cursor/rules/...`) — no automated check asserts the file artifact.
- **`zstack update --apply` checkpoint recording** — no test asserts `verification/upstream-sync.json` is updated as documented.
- **`zstack budget ... --confirm` apply path** — persistence of tier/source is tested, but the CLI confirm/apply flow is not exercised end-to-end.
- **Live ModelHitch routing decisions** (which model actually gets picked per provider and per task) — logic is tested with mock state, not against a live bridge in CI.
- **The browser client** (`web/*.js`) — no automated suite drives it. The projection and transport it relies on are covered, but the DOM wiring is not: the review that produced it found two bugs (a topbar cleared by the view renderer, and `onClick` attaching no listener because `addEventListener` is case-sensitive) that a source-level check and a passing server suite both missed. Driving the page is currently manual.
- **Per-call approval from the UI** — not reachable. `runHarnessTask` pipes the prompt on stdin and passes `--yes` or `--auto-approve-safe`; under a non-TTY stdin the harness declines rather than blocking on a question. The UI therefore offers run-level policy only (read-only, apply, strict).

## Verification

Hermetic default (no secrets, no network beyond loopback stubs):

```bash
npm run verify          # full hermetic suite (exit 0 when green)
npm run verify:live     # live ModelHitch bridge + upstream network canaries (env-gated, intended for a dev box with a running bridge)
```

Exit codes: `0` all covered checks pass; `1` at least one covered check failed; `2` usage/runner error.
Environment-gated checks report as skipped, not failed, when their prerequisite (bridge or network) is absent.

See `.agents/skills/verify-zstack/SKILL.md` for the full verify skill: scope, expected outputs,
and how to interpret partial runs.