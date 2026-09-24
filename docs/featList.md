5\. Interactive Z-Mode Shell

Add a persistent interactive session so users stop paying process start-up and re-typing context. Scope: add `zstack shell` (alias `zstack repl`) dispatched from `bin/zstack.mjs`, using `node:readline/promises` (already imported there for guided playbook selection in `resolveGuidedPlaybook`). Expected behavior: each input line runs the existing one-shot path — classification via `z.classifyPromptDetailed`, guided selection when ambiguous, then `z.task` — and prints the same output the one-shot command prints today. Session state carries a sticky playbook, attached files, role override, and json mode. Slash commands: `/playbook <id>`, `/files <a,b>`, `/role <role>`, `/model <provider/model>`, `/json on|off`, `/context <tokens>`, `/status`, `/help`, `/exit`. Edge cases: non-TTY stdin (refuse to start, print a usage error and exit 2), SIGINT must exit cleanly with code 0 and no stack trace, EOF on stdin (exit 0), empty/whitespace lines (ignore, do not re-prompt with an error), unknown slash commands (print help, keep the session alive), and any error thrown by `z.task` must be printed and must not terminate the session. Reuse `contextFlags`/`reportContext` from `bin/zstack.mjs` rather than duplicating budget handling. Validation: add `tests/shell.test.mjs` spawning `node bin/zstack.mjs shell` with piped stdin (`/help\\n/playbook bug-fix\\n/exit\\n`) asserting exit code 0 and expected stderr/stdout lines, plus a case asserting exit 2 when stdin is not a TTY.



7\. Gateway Failure Hardening

Harden ModelHitch gateway failure handling so failures are classified, bounded, and never silently ambiguous. Scope: `src/connector.mjs` and the error paths in `bin/zstack.mjs` (`gatewayUnreachable`, `fail`, `jsonError`). Add a per-request timeout (default 30000ms, overridable with `--timeout <ms>` and `MODELHITCH\_TIMEOUT`), implemented with `AbortController` plus `node:timers/promises` — no new dependencies. Add bounded retry with exponential backoff (max 3 attempts, base 250ms, cap 2000ms) only for idempotent GETs such as health and `/models`; never auto-retry task, prompt, or panel POSTs. Return a structured error on every failure result: `{ kind: 'unreachable' | 'timeout' | 'http' | 'parse', status, message, baseUrl, attempts }`. Retry HTTP 429 honoring `Retry-After` when present, and 502/503/504; never retry 400/401/403/404/422. Map kinds to the documented exit codes: unreachable/timeout to 3, parse to 1, partial panel failure to 4. Edge cases: abort firing mid-response body, a socket that connects and then stalls (must hit the timeout, not hang), malformed JSON bodies, `Retry-After` as an HTTP date vs seconds, and a panel where one family fails while others succeed (report per-model `ok` and keep exit 4). Validation: add a `node:http` stub server in `tests/connector.test.mjs` that simulates a hang, a 500, a 429 with `Retry-After`, and an invalid-JSON 200, asserting the returned `kind`, `status`, and `attempts`, and asserting POST endpoints are attempted exactly once.



9\. Failure Triage Assistant

Add `zstack triage` to turn raw failure output into a playbook decision. Scope: new `src/triage.mjs` exporting `triageFailure({ input, maxCandidates, live })`, re-exported from `src/index.mjs`, plus a `triage` command in `bin/zstack.mjs`. Input: `--file <path>` or stdin (test output, stack traces, logs); cap input using the existing budgeting logic in `src/context.mjs` (default 12000 tokens, `\~4 chars/token`, with `\[... omitted lines X-Y ...]` markers and `--no-prune` aborting instead of trimming). Pipeline: a deterministic heuristic pass reusing the keyword/specificity scoring already in `src/router.mjs` produces candidates; when the ModelHitch bridge is reachable and `live` is enabled, send a strict-JSON prompt through the existing `ZStack.runRole` path asking for `{ playbook, confidence, rationale, nextSteps: string\[] }` constrained to the 15 known playbook ids. Provider-neutral by construction: use only the existing gateway, no vendor SDK or vendor-specific request shape. Expected output: up to 3 ranked candidates with `{ playbook, trigger, confidence, reason, nextCommands }`, where `nextCommands` are literal `zstack` invocations. Must never fabricate: if the gateway is unreachable or the model returns unparseable/non-conforming JSON, retry once, then fall back to the heuristic result and print an explicit `\[!] heuristic only` notice. Edge cases: empty input (exit 2), binary/non-UTF8 bytes (decode with replacement chars), a single log containing multiple distinct failures (rank them, do not merge), and playbook ids returned by the model that are not in the known list (drop and note). Validation: add `tests/triage.test.mjs` with fixture JDK-style stack traces, a memory-growth log, and a deadlock log asserting the expected top playbook ids on the heuristic path, plus a fake-gateway test for the JSON contract and the fallback notice; keep any real-gateway case behind `ZSTACK\_LIVE=1`.



3\. Task Run History

Persist a compact local history of runs so users can review and repeat work without retyping. Scope: create `src/history.mjs` exported from `src/index.mjs` that appends one JSON line per invocation to `\~/.zstack/history.jsonl` (override with `ZSTACK\_HISTORY\_PATH`), and add `zstack history \[--limit N] \[--json]` plus `zstack history --last --rerun` to `bin/zstack.mjs`. Expected behavior: `handleTask`, `handleOneShotPrompt`, and the panel handler each append `{ ts, command, playbook, role, model, durationMs, usage, contextEstimate, promptChars, promptPreview, ok, errorKind }`; `promptPreview` holds at most the first 200 characters of the prompt and the full body is never stored by default. `--rerun` re-dispatches the last recorded invocation, but when the recorded preview was truncated it must require `--yes` and print a warning that the prompt may be incomplete. Edge cases: an unwritable home directory warns once to stderr and never fails the underlying task; a malformed JSONL line is skipped on read and counted in a `skipped` field; `--limit` returns the newest entries first; a run that exits non-zero is still recorded with `ok: false` and the exit code. Validation: tests with a stubbed connector asserting exactly one line is appended per run, asserting newest-first ordering with `--limit`, asserting malformed-line tolerance, and asserting the truncated-preview rerun guard.



4\. Principle Frontmatter Schema

Replace ad-hoc markdown extraction with an explicit, validated document contract. Scope: create `src/manifest.mjs` exporting `parseDoc(text)` and `validateDocs(docs)`, and re-export from `src/index.mjs`. `parseDoc` reads a leading `---` block containing `id`, `title`, `applyWhen`, `keywords` (array), `requires` (array), and `version` using a small dependency-free parser — do not add a YAML library. Expected behavior: migrate `ZStack.listPlaybooks()` and `listPrinciples()` to build their indexes from `parseDoc` and delete the old extraction code in the same change, per the migrate-callers-then-delete-legacy-apis principle; documents without frontmatter fall back to today's behavior with a stderr warning so nothing breaks; `zstack principles --json` and `zstack playbooks --json` include the parsed fields without changing existing keys. Edge cases: `id` that does not match the filename is an error; duplicate ids across the principle and playbook sets are an error; a non-array `keywords` value is an error; CRLF line endings and a leading BOM must still parse; a `---` line inside the body must not terminate the block early; an unterminated block is an error naming the file. Validation: add `tests/manifest.test.mjs` with one assertion per error case plus a repository-wide test asserting all shipped principles and playbooks parse and validate, and a regression test asserting the `--json` output shape is unchanged for existing keys.



1\. Context Offload Subagent

Implement a Context Offload Subagent in zstack that enforces the existing `principles/guard-the-context-window.md` rule by delegating bulk file reads and searches to a narrow, throwaway subagent that returns only a distilled summary into the parent context.



Scope:

1\. Create `src/subagent.mjs`. Export `async function runContextOffload({ query, paths = \['.'], maxFiles = 40, maxFileBytes = 200000, budgetTokens = 4000, model, role = 'how explorer / why', signal, fetchImpl }, deps = {})` plus a `formatOffloadReport(result)` helper. Reuse the existing gateway plumbing in `src/connector.mjs`/`src/upstream.mjs` (do not re-implement HTTP or provider discovery) and reuse token estimation + trimming from `src/context.mjs` so the offload payload honors the same `\~4 chars/token` budget.

2\. Behavior: (a) walk `paths` with `node:fs/promises` (skip `node\_modules`, `.git`, `dist`, `build`, dotfiles unless explicitly passed), (b) rank candidate files by case-insensitive keyword overlap with `query` (filename weight > first 200 lines weight), (c) cap total bytes sent to the subagent at `budgetTokens`, truncating with the existing `\[... omitted lines X-Y ...]` marker convention, (d) dispatch one prompt to the resolved role asking for a bounded answer shaped as `{ findings: \[{ file, line?, claim, confidence }], answer, uncovered }`, (e) parse strict JSON; on parse failure retry exactly once, then return `{ ok: false, error: 'parse-error' }` — never fabricate findings.

3\. Return `{ ok, answer, findings, filesScanned, filesAttached, estimatedTokens, omitted: \[...], model, role, durationMs }`. Never return raw file bodies to the caller.

4\. Export `runContextOffload` from `src/index.mjs` alongside the existing `export \* from './context.mjs';` line, and add the matching declaration to `src/index.d.ts`.

5\. CLI: add an `explore` subcommand to `bin/zstack.mjs`, added to `KNOWN\_COMMANDS` and `printHelp()`. Signature: `zstack explore "<query>" \[--paths src,tests] \[--max-files N] \[--context-budget <tokens>] \[--json]`. Human mode prints the answer then a compact findings table plus `Scanned N files · attached M · \~T tokens`. `--json` emits a single document `{ ok, answer, findings, filesScanned, filesAttached, estimatedTokens, omitted, model, durationMs }` and disables prompts. Reuse `parseArgs` for `--paths`/`--context-budget` (extend it, do not fork it) and the existing exit-code map: `EXIT.GATEWAY` (3) when ModelHitch is unreachable, `EXIT.USAGE` (2) when the query is missing or `--max-files`/`--context-budget` are non-positive, `EXIT.FAIL` (1) on parse failure after retry.

6\. Non-negotiable: the offload must never dump file contents to the parent context window — only the distilled report. Assert this in the tests.



Edge cases to cover: zero matching files (return `ok: true` with `answer: 'No matching files for query.'`), a single file exceeding `maxFileBytes` (truncate, do not skip), binary files (skip with a note), an abort via `signal`, and a gateway that hangs (respect an AbortController timeout, map to `EXIT.GATEWAY`).



Validation: add `tests/subagent.test.mjs` runnable as `npm test` alongside `tests/connector.test.mjs`. Test with a stubbed `fetchImpl` (no live gateway required): ranking order, byte cap enforcement, omission markers present, malformed-JSON retry-then-fail path, and that no returned field contains raw file body text. Then verify end-to-end against the real bridge per `principles/prove-it-works.md` by running `zstack explore "where is context budget trimming implemented" --paths src --json` and confirming the output is valid JSON and cites `src/context.mjs`.

