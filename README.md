# zstack

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-209%20passed-brightgreen.svg)](scripts/verify.mjs)
[![Gateway](https://img.shields.io/badge/gateway-ModelHitch%203939-orange.svg)](https://github.com/bobbybacklogs/ModelHitch)

An opinionated Agent Operating System, TypeScript SDK, and CLI for rigorous software engineering.

`zstack` decouples high-level engineering tasks from individual models. It structures development through task-specific playbooks, enforces twenty non-negotiable engineering principles, and routes operations to specialized language models via [ModelHitch](https://github.com/bobbybacklogs/ModelHitch) (`127.0.0.1:3939`).

---

## Key Capabilities

- **15 Standard Operating Playbooks**: Structured execution recipes for features, bug fixes, refactoring, performance forensics, and pull requests.
- **20 Durable Principles**: Non-negotiable engineering rules (laziness protocol, root cause remediation, boundary discipline, context preservation) cited against concrete code changes.
- **Local UI**: `zstack serve` opens runs as pages in a browser, streams a run in progress, and starts new ones. Same records the CLI writes, so a run started in the UI appears in `zstack history`.
- **Pinned-model Chat**: a chat page in the UI listing conversations kept on the server. One model from the live catalogue is pinned per chat, free models included, and each turn streams token by token. A chat is plain: no playbook, no tools, no workspace, and it never lands in run history.
- **Prompt Optimization**: the run composer has an Optimize button that rewrites your raw text into a clearer task prompt grounded in the playbook the request matches, in place and with Undo. It only shapes text: nothing is dispatched until you send.
- **Dynamic Workload Routing**: Routes tasks to the optimal model based on available providers (OpenCode Zen/Go, OpenAI, Anthropic, Gemini, DeepSeek).
- **Quality-Filtered HuggingFace Lane**: A fifth provider lane that draws on HuggingFace's open router. Because anyone can publish there, the lane filters the catalogue for tool calling, context, recency, and publisher before pinning any role, and reports every admission and rejection with the rule that made it.
- **Adversarial Multi-Family Panels**: Concurrently queries models across distinct provider families (`/arena`, `/panel`) to surface architectural blind spots.
- **Unified SDK & CLI**: Programmatic TypeScript API and terminal binary for direct task execution, prompt classification, and rule synchronization.

---

## Architecture Overview

```
                      +---------------------------------------+
                      |       Developer Prompt (/z-mode)      |
                      +---------------------------------------+
                                          |
                                          v
+---------------------------------------------------------------------------------+
| zstack Core (Cognitive & Workflow Layer)                                        |
|                                                                                 |
|   Classifier & Router                                                           |
|   ├── Task Classification (Feature, Bug-fix, Refactor, Investigation, etc.)     |
|   ├── Principles Index (Laziness Protocol, Prove-It-Works, Guard Context, etc.) |
|   └── Task Playbooks (playbooks/*.md)                                           |
+---------------------------------------------------------------------------------+
                                          |
             Role Assignment: Fast Coder | Architect / Judgment | Review Panels
                                          v
+---------------------------------------------------------------------------------+
| ModelHitch Gateway (http://127.0.0.1:3939/v1)                                   |
|                                                                                 |
|   - Multi-wire normalization (/responses, /messages, /chat/completions, /models)|
|   - Automatic circuit-breaking and fallback routing                             |
|   - Usage and cost telemetry                                                    |
+---------------------------------------------------------------------------------+
                         /                |               \
                        /                 |                \
                       v                  v                 v
            +--------------------+ +---------------+ +-----------------------+
            | OpenCode Go / Zen  | | OpenAI / Anth | | Gemini / DeepSeek     |
            |                    | |               | |                       |
            | - deepseek-v4-pro  | | - gpt-5.6     | | - gemini-3.6-flash    |
            | - claude-sonnet-4-6| | - o3 / o4     | | - deepseek-v4-flash   |
            | - gpt-5.5          | |               | | - deepseek-reasoner   |
            +--------------------+ +---------------+ +-----------------------+
```

---

## Model Role Allocation Matrix

When connected to ModelHitch, `zstack` inspects available providers and assigns models to roles:

| Role | Preferred Model (OpenCode) | Fallback Hitch Model | Workload Profile |
| :--- | :--- | :--- | :--- |
| **feature, refactoring** | `opencode/deepseek-v4-pro` | `deepseek/deepseek-v4-flash` | High-throughput, precise code generation and transformations. |
| **bug-fix, perf-issue** | `opencode/deepseek-v4-pro` | `deepseek/deepseek-v4-flash` | Root-cause analysis, reproduction, and minimal diff footprints. |
| **fast exploration** | `opencode/deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | Rapid exploratory scripts and throwaway spikes. |
| **judgment and prose** | `opencode/claude-sonnet-4-6` | `openai/gpt-5.6-luna` | Architecture evaluations, API contracts, and PR descriptions. |
| **deep reasoning** | `opencode/gpt-5.5` | `openai/gpt-5.6-luna` | Algorithm design, invariants, and mathematical correctness. |
| **how explorer / why** | `opencode/deepseek-v4-pro` | `deepseek/deepseek-v4-flash` | Subsystem exploration and runtime behavior analysis. |
| **adversarial panel** | `claude-sonnet-4-6`, `gpt-5.5`, `deepseek-v4-pro` | `openai/gpt-5.6-luna`, `gemini-3.6-flash`, `deepseek-v4-flash` | Parallel review across divergent model families. |

The table pins the OpenCode and ModelHitch lanes. The `hf` lane resolves the same
roles from the HuggingFace filter instead, per tier: on `low-med` it buys the cheap
flash builds, and from `med-high` up it pins the current flagship for coding and
reasoning with a flash build for fast exploration, exactly as the Zen and Go lanes
do. Run `zstack hf` against your own gateway to see the roles this machine resolves.

---

## Local Git work

Start `zstack serve` and open **GitHub repos** to sync your catalogue and set
each repo's local clone path. Authentication uses `GITHUB_TOKEN` or `GH_TOKEN`
from the environment, then the server's `.env`, then `gh auth token`. Run
`gh auth login` first if using the CLI fallback. The fallback result, including
failure, is cached until the server restarts. Tokens are never sent to the browser.

Cloned repo rows and run pages with a recorded workspace offer:

- **Status** shows the current branch, tracking branch, ahead/behind counts and changes.
- **Pull** runs `git pull --ff-only --no-rebase`. Divergence is refused.
- **Merge** takes a local branch or `origin/branch`. Remote branches fetch origin
  first. A failed merge is aborted so conflicts are not left in the working tree.
- **Commit entire tree** stages all changes, including untracked files and edits
  unrelated to the run, then commits with your message. This is not a run-only commit.

Pull and merge require a clean tree, including untracked files. Existing conflicts,
merges, rebases and cherry-picks must be resolved in the terminal first. Mutations
are refused while this server has an active run in the same canonical repository.
Operations from repo rows and run pages serialize per repository root, including
subdirectory paths. This does not lock out external Git clients or other servers.
Git must be on PATH and commits need a configured author identity. Git remote
authentication uses your normal Git credentials, separately from catalogue sync.
Nothing pushes, forces, or rewrites history.

## Installation

### Global CLI Installation

Install or link globally using Node.js (>= 18.0.0):

```bash
git clone https://github.com/bobbybacklogs/zstack.git
cd zstack
npm link
```

Verify installation:

```bash
zstack --help
```

### SDK Dependency

Install locally in a project:

```bash
npm install git+https://github.com/bobbybacklogs/zstack.git
```

---

## CLI Usage

### 1. One-Shot Task Execution (Auto-Classified)

Pass any task description. `zstack` analyzes the prompt, identifies the matching playbook, grounds the context in the relevant principles, and routes to the assigned model:

```bash
zstack "Fix unhandled promise rejection in auth retry loop"
```

Confident matches run directly. Ambiguous matches offer guided playbook selection:
the classifier scores every trigger (keyword hits plus a specificity bonus) and a
match is confident only when the top candidate scores >= 1.0 and leads the
runner-up by >= 0.5. Otherwise the CLI prints the top three candidates with
their trigger lines and prompts for a number, a playbook id, or Enter for the
top candidate (`--playbook <id>` always bypasses; non-interactive shells fall
back to the top candidate with a warning). When the keyword match is ambiguous
and the ModelHitch gateway is reachable, an embedding-based semantic router
(`classifyPromptSemantic` in `src/router.mjs`, cached in
`verification/playbook-embeddings.json`) refines the choice; otherwise the
keyword result stands unchanged.

### 2. Task with Explicit Playbook and File Attachments

Specify a playbook explicitly and attach local source files for bounded context:

```bash
zstack task feature "Add token bucket rate limiting to refresh route" --files src/auth.ts,src/server.ts
```

Attached files pass through the context budgeter (default 12000 tokens, `~4
chars/token` estimate). Over budget, file bodies truncate with explicit
`[... omitted lines X-Y ...]` markers and trailing principles drop with a note;
`--no-prune` aborts instead of trimming, and `--context-budget <tokens>` sets a
custom budget.

### 3. Agentic Execution (The Tool Loop)

A plain prompt makes **one** model call and prints the reply. That call cannot
read a file, run a command, or change anything, so asking it to "look over this
project and fix it" produces a plausible plan and no work.

Adding `--agent`, `--apply`, or `--project` instead runs the ModelHitch harness:
the model receives tools, its calls execute, and the results feed back until the
task is done or `--max-turns` is reached. zstack still owns classification,
playbook and principle injection, and lane routing; ModelHitch owns the loop,
the approval gate, and snapshots.

```bash
zstack "Add an events API and rename Chronos to OddEvents" --project --apply --go
```

Every turn and tool call streams as it happens:

```
[>] Task classified as [feature] (playbook: playbooks/feature.md)
[>] Agentic run (apply, max 8 turns) in /repo
[>] Agent run: opencode-go/deepseek-v4-pro in /repo
    │ I'll inspect the file before changing it.
[1] turn 1 (4650 tokens)
    ! approval bash: approved
    ! bash ls -la && cat app.js  [error, 54ms]
    · grep_search VERSION  [ok, 1ms]
[2] turn 2 (4849 tokens)
    · read app.js  [ok, 3ms]
[3] turn 3 (5153 tokens)
    ! approval write: approved
    · write app.js  [ok, 11ms]
[4] turn 4 (5321 tokens)
    · read app.js  [ok, 184ms]
    · bash node -e "…"  [ok, 1ms]

[✓] Model: opencode/deepseek-v4-pro | Role: feature, refactoring | apply (4 turns | 5 tool calls | 19113 tokens | 8294ms)
[✓] Changed 1 file:
    ~ app.js  (write)
    diff: +1/-0 across 1 mutation
```

**Read-only is the default.** Without `--apply`, the harness risk-classifies each
mutating call and runs only the ones it calls safe, so `ls`, `cat`, and `grep`
work while a command that could write or open a port is declined and reported.
`--apply` approves mutating calls so the agent can change files.

Because tool attribution only covers the harness's own writer tools, an `--apply`
run also reports `git status` when the workspace is a repository. A model that
writes through `node -e fs.writeFileSync(...)` or a shell redirect changes the
tree with no attributable call, and git is the artifact that does not care how
the bytes were written.

`--max-turns <n>` bounds the loop and `--review` runs the read-only reviewer over
the change afterwards.

Nobody knows how many turns a task needs, including the model, so zstack picks a
starting size rather than making you guess one: 25 turns, against the harness's
own 8. The size is where the run starts, not where it stops.

**A run that reaches its size is continued, not cut off.** Stopping there throws
away everything the model was holding mid-task, so zstack resumes the harness
session and the run carries on: one run, one page, one growing body. A run may
use at most 500 turns in total before zstack stops extending for real. When that
ceiling is hit, the run page says so and offers to continue from the saved
session.

**Runs can be paused and resumed.** Pause asks the run to stop at the end of the
turn in flight, which is the only place it can stop without losing work: the
harness writes its session when its loop ends, so a pause that killed the process
would leave nothing to resume from. That is what Stop does, and why Stop cannot
be undone while Pause can. Resuming continues the same run from where it stopped,
as often as you like.

```bash
zstack "Refactor the retry logic" --max-turns 60     # decide the starting size
zstack "carry on and finish the refactor" --continue # resume a run that stopped
```

`--continue` resumes the most recent run that saved a session. It is for the runs
pause cannot save: ones you stopped, or that errored.

`--max-turns` and `--review` imply `--agent`, because a size or a reviewer only
means something if the loop actually runs. They used to be accepted and ignored
on a single completion.

In the UI the size is the "How much work" picker: Quick look (8), Standard (25),
Deep (60), Marathon (200), or a custom number. The label is the question you can
actually answer. A project can carry its own default, which pre-fills the
composer. A running run's page offers Pause and Stop side by side, and a paused
one offers Resume.

### 4. Adversarial Multi-Family Panel Review

Dispatch an architecture question or proposed diff to a multi-model panel:

```bash
zstack panel "Should we use optimistic concurrency or distributed locks for ledger balances?"
```

### 5. Principle Grading

Grade a proposed diff against the 20 principles with structured verdicts
(`pass` / `warn` / `fail` plus rationale and evidence lines):

```bash
zstack grade --file diff.patch
```

Oversized diffs chunk by file hunk (merged verdicts marked chunked); unparseable
model output retries once and is reported as a parse error, never fabricated.

### 6. Rule Synchronization

Inspect active ModelHitch providers and generate or update Cursor rules:

```bash
# Update global rule (~/.cursor/rules/zstack-models.mdc)
zstack sync

# Update project-level rule (.cursor/rules/zstack-models.mdc)
zstack sync --project
```

### 7. Upstream Synchronization

Check the canonical `pstack` repository (`cursor/plugins/tree/main/pstack`) on demand for new commits, playbooks, or principle updates:

```bash
# Check upstream for changes (interactive prompt to record checkpoint)
zstack update

# Automatically record and sync the latest upstream checkpoint
zstack update --apply

# Check upstream status without prompting
zstack update --check
```

### 8. Introspection & Health

```bash
# Display system overview, tenets, and package metadata
zstack --about

# Check ModelHitch bridge connectivity and active role mappings
zstack status

# Report what the HuggingFace lane's filter admits, rejects, and would pin
zstack hf

# List all available playbooks and their triggers
zstack playbooks

# List all 20 principles and when to apply them
zstack principles
```

### 9. Scripting Output

`status`, `playbooks`, `principles`, `budget`, `task`, `prompt`, and `panel`
accept a global `--json` flag emitting a single JSON document on stdout
(diagnostics go to stderr). Exit codes: 0 success, 1 failure, 2 usage error,
3 gateway unreachable, 4 partial panel failure. `--json` disables interactive
prompts and uses defaults.

```bash
zstack status --json
zstack budget max --source catalog --json  # preview only; add --confirm to apply
```

### 10. Interactive Shell

A persistent session with sticky playbook, files, role, model, and JSON mode:

```bash
zstack shell  # alias: zstack repl
```

Each line runs the one-shot path (classification, guided selection, task).
Session commands: `/playbook <id>`, `/files <a,b>`, `/role <role>`,
`/model <m>`, `/json on|off`, `/context <tokens>`, `/status`, `/help`, `/exit`.

### 11. Failure Triage

Turn test output, stack traces, or logs into a ranked playbook decision:

```bash
zstack triage --file failure.log [--json] [--no-live]
```

Heuristic keyword scoring ranks up to 3 candidates with literal `zstack`
follow-ups; when the gateway is reachable a strict-JSON model pass refines the
choice, otherwise output is marked `[!] heuristic only`. Stdin is accepted when
piped.

### 12. Context Offload Search

Delegate bulk file reads to a throwaway subagent that returns only a distilled
report (raw bodies never enter the parent context):

```bash
zstack explore "where is context budget trimming implemented" --paths src,tests --json
```

### 13. Run History

One JSON line per task/prompt/panel run in `~/.zstack/history.jsonl`
(`ZSTACK_HISTORY_PATH` overrides; previews cap at 200 chars):

```bash
zstack history --limit 10 [--json]
zstack history --steps              # expand what each agentic run actually did
zstack history --last --rerun [--yes]  # --yes required when the preview was truncated
```

An agentic run records its progression, not just the invocation: turns, tool
calls, outcomes, approvals, and the files that changed. `--steps` renders them.

```bash
$ zstack history --steps --limit 1
  2026-01-01T00:00:00.000Z  [ok] agent:feature | opencode-go/deepseek-v4-pro
    prompt (40 chars): Add a footer comment to main.js
    agent: 4 turns | 4 tool calls | 1 failed | applied | /repo
    changed 1 file: main.js
    steps:
      run started: opencode-go/deepseek-v4-pro in /repo
      turn 1 (4562 tokens)
      · turn 1: read main.js  [ok, 3ms]
      turn 2 (4659 tokens)
      ! approval bash: approved
      · turn 2: bash node -e "…"  [ok, 162ms]
```

Stored steps cap at 200 per run; `stepsTruncated: true` marks a capped list so a
partial progression is never mistaken for the whole run.

Every record carries an `id`. Appending a run never renumbers the ones already
there, so an address stays valid: a run opened in the UI keeps the same URL in
history tomorrow.

### 14. Local UI

Browse, watch, and start runs in a browser. Runs render as pages: properties at
the top, an ordered body of blocks below. One renderer serves both an archived
run read from `history.jsonl` and a live run streaming off the harness, so the
page you watch during a run is the page you open next week.

```bash
zstack serve                        # http://127.0.0.1:4141
zstack serve --port 4300 --open     # pick a port and open a browser
zstack serve --json                 # prints { ok, url } once the socket is bound
```

What it does:

- Opens on a dashboard: how many runs are going, how many failed today, one
  row per project with its latest activity, and the newest runs. Every row is
  a link to the page it summarizes. The full list lives one click down.
- Lists runs newest first, merging runs still in flight with archived ones.
- Opens any run as a page: turns, tool calls with outcomes and durations,
  approvals, the model's own words, and the files that changed.
- Streams a run in progress token by token, patching the page in place.
- Starts a run with controls for playbook, provider lane, workspace, max turns,
  and approval policy, plus an Optimize button that rewrites the prompt in the
  composer into a clearer task prompt (with Undo) before you send it.
- Chats with one pinned model, kept on the server and listed in the sidebar:
  pick any model the bridge serves, free ones included, and talk turn by turn
  with the reply streaming in as it is written. A chat is a plain conversation,
  so it carries no playbook, no tools, and no workspace, and it never lands in
  run history. Each conversation is stored at `~/.zstack/chats.json` and can be
  re-opened from any browser, renamed, re-pinned, or deleted.
- Shows bridge health, the active lane, and the resolved role-to-model mapping,
  and lets you change the budget tier, source, and lane.
- Organizes runs into projects: a project is a name plus the directory it owns,
  listed in the sidebar, opened as a page of its own runs, and picked in the
  composer so the run executes there.

Projects are stored in `~/.zstack/projects.json` next to history, deliberately
as plain JSON: a human creates a handful of them by pointing at folders, not a
database's worth. Creating one needs a name and an existing directory.
Renaming never changes the id its runs refer to, and deleting one never deletes
work — the runs stay in history and keep rendering, listed under no project
until re-attached. Starting a run under a project takes the directory from the
stored project, never from the request, so a stored area cannot be talked into
executing somewhere else.

A project can also set a default playbook and policy. The composer pre-selects
them when a run starts there, but an explicit choice always wins — a default
that overrode the reader would be a trap. A default naming something the server
has never loaded faults with the project's name, so the fix lands where the
preference lives. A run page names its project next to the status chip and
links back to the project page; a run whose project was deleted shows no link
rather than one that leads nowhere.

A run page also offers Rename, Move to project, and Delete run. A rename sets
a custom title — empty restores the derived one — and the prompt preview stays
in the body, so renaming never destroys the record of what was asked. A move
re-attaches the run to another project, or detaches it entirely. Delete hides
the run from every list without rewriting history: the record stays, and the
page still resolves by id, so the action never produces a 404 for itself. All
three write a sidecar file (`~/.zstack/run-overrides.json`) keyed by run id,
because history is append-only and editing its lines in place would break the
trust every reader places in it.

Two honest limits:

**Approval is run-level, not per-call.** `runHarnessTask` pipes the prompt on
stdin and passes `--yes` or `--auto-approve-safe`; under a non-interactive stdin
the harness declines rather than blocking on a question. So the composer offers
three policies instead of approve/deny buttons that could not work:

| Policy | What runs |
| :--- | :--- |
| `read-only` (default) | Read-only calls the risk classifier calls safe. A write or a listening port is declined. |
| `apply` | Mutating calls run without asking. |
| `strict` | Nothing is auto-approved, not even a safe read. |

**It binds loopback only.** This process starts agent runs, so the default is
`127.0.0.1` and `--host` warns before exposing it. A `Host` header naming a host
the server does not answer for is refused, which is what stops a page on another
site from reaching it through DNS rebinding.

No build step, no dependency: the client is vanilla ES modules and one
stylesheet served straight from `web/`.

### 15. Workfolk Integration

Inspect the Workfolk worker roster and dispatch asynchronous tasks to specialist teammates (`@coordinator`, `@developer`, `@researcher`, `@infra`, etc.) via the local Workfolk gateway (`http://127.0.0.1:3000` or `WORKFOLK_URL`):

```bash
zstack workfolk status                      # verify connection and authorization
zstack workfolk list [--include-retired]    # view active workers and declared capabilities
zstack workfolk dispatch @researcher "Analyze memory leak trends across nodes"
zstack workfolk dispatch @developer "Add rate-limiting to auth endpoint" --wait
zstack workfolk job <job-id>                # check result of a dispatched task
```

`--wait` blocks and polls until the task reaches a terminal state (`completed`, `failed`, `cancelled`, or `expired`), streaming the final result to stdout. In the web interface, a dedicated **Workfolk** view lists the live roster and session jobs, and chat conversations provide a 1-click **Hand off to Workfolk** action.

## Gateway Reliability

Per-request timeout defaults to 30000ms (`--timeout <ms>` or
`MODELHITCH_TIMEOUT`). Idempotent GETs (health, config, models) retry up to 3
times with exponential backoff (250ms base, 2000ms cap), honoring `Retry-After`
on 429 and retrying 502/503/504 — never 400/401/403/404/422, and never POSTs.
Failures are structured `{ kind, status, message, baseUrl, attempts }` with
kinds `unreachable`/`timeout` (exit 3), `http`/`parse` (exit 1).

### Tool Calls

The gateway normalizes provider tool-call behavior so clients never handle
vendor wire quirks.

- **Tool-call markup recovery.** DeepSeek V4 models sometimes write their
  tool-call syntax into the text channel instead of populating `tool_calls`,
  which ships raw markup to the caller. Two spellings occur, and both are
  recovered. The canonical one carries the model's internal marker
  (`<｜DSML｜function_calls>`); the bare one has the marker tokens stripped
  entirely by decoding and arrives as `<tool_calls>` / `<invoke name="...">` /
  `<parameter name="...">`. The gateway parses either form, returns real
  `tool_calls`, and strips the markup from `content`. Recovery runs on streaming
  and non-streaming paths, and only when the provider returned no genuine tool
  calls, so quoted markup in ordinary prose is left alone. Bare-form detection
  requires a closed `<invoke>…</invoke>` block, which is what keeps prose that
  merely names the tags from being rewritten. Named parameters map directly;
  positional parameters map onto the declared tool schema's properties in order.
- **Session headers.** Requests carry a per-conversation session id, taken from
  the client's session header when present and derived from the conversation
  otherwise. OpenCode Go requires `x-opencode-session` and rejects requests
  without it (`MissingSessionID`, HTTP 400), so the OpenCode provider always
  sends it on every wire; Zen uses the same id for routing and cache affinity.


## Document Contract

Every playbook and principle ships with a leading `---` frontmatter block (`id`,
`title`, `applyWhen`, `keywords`/`requires` arrays, `version`), parsed without
dependencies by `src/manifest.mjs`. Frontmatter is the contract, not a nicety:
it is what supplies the `applyWhen` trigger text and the keyword set that
classification scores against, so a document without it silently degrades
routing. Missing frontmatter falls back to legacy extraction and reports the
affected files in a single aggregated warning rather than one line per document.
The SDK strips frontmatter before dispatch, so a playbook or principle fetched
through `getPlaybook`/`getPrinciple` is model-ready body text. Mismatched ids,
duplicate ids, and non-array `keywords` are validation errors.

## Provider Lanes

A lane pins which provider family role models resolve from, so you can choose
between OpenCode's pay-per-use catalog, its flat-rate Go subscription, plain
ModelHitch routing, or HuggingFace's router without editing role mappings by hand.

| Lane | Prefix | Description |
| --- | --- | --- |
| `auto` | — | Zen when an OpenCode key is active, otherwise hitch |
| `zen` | `opencode/` | OpenCode Zen pay-per-use models |
| `go` | `opencode-go/` | OpenCode Go and Go Plus flat-rate models |
| `hitch` | — | No OpenCode preference; active ModelHitch providers and config default |
| `hf` | `huggingface/` | HuggingFace router models, filtered for quality before pinning |

```bash
zstack budget med-high --source catalog --lane go --confirm
zstack --go "Fix the flaky retry test"        # one-shot override
zstack --zen "Refactor the parser"            # aliases: --zen, --go, --hitch, --hf
zstack --lane hitch "Investigate the timeout"
zstack --hf "Add a health check to the server"
```

Lane resolution applies whenever the source is `catalog`. With
`--source config` your ModelHitch policy pins the models, so the lane is recorded
but not applied and the mapping reports `laneApplied: false`. The stored lane
survives a tier-only update. Every lane is validated against the live catalog, so
a resolved model the gateway does not serve is never selected.

### The HuggingFace lane filters before it pins

HuggingFace's router serves models published by anyone, from frontier labs to
anonymous fine-tuners, so this lane cannot pin hand-written ladders the way `zen`
and `go` do: a hand-written ladder over a churning open catalogue rots silently.
It filters first and pins from what survived. Two layers, so it degrades honestly:

- **Capability gates** use the router's public model listing to drop anything
  that cannot do the work: no tool calling (the agent loop needs it), a context
  window under 32k, no live provider, or no text output. This layer needs the
  network once per cache window, and an unfetched fact is reported as
  `unavailable` rather than assumed good.
- **Curation gates** use the model id alone, so they always run, offline
  included: safety classifiers, translation, speech, embedding and vision
  builds, previews, on-device toys, community roleplay fine-tunes, publishers
  outside the trusted list, base checkpoints that have an instruction-tuned
  sibling, quantized and dated duplicates of a model already listed, and the
  tiny tail below the tier's size floor.

Survivors are ranked per role by size, recency, context, cost, and speed, with
cost mattering more on the cheap tiers and not at all on `max`. The lane needs no
token of its own: inference rides the ModelHitch gateway, which holds the
HuggingFace key, exactly like every other lane. HuggingFace is never chosen by
`auto`, because a large, cheap, variable-quality catalogue should be an explicit
choice.

Nothing is hidden: `zstack hf` prints what the filter admitted, what it rejected,
counts by rule, and the roles it would pin.

```bash
zstack hf                    # filter report for the stored tier
zstack hf --tier max         # report as the Max tier would filter it
zstack hf --all --json       # every rejection with its reason, as one JSON doc
zstack hf --refresh          # refetch capability metadata instead of the cache
```

Capability metadata is cached at `~/.zstack/hf-capabilities.json` (`ZSTACK_HF_CAPABILITIES_PATH`
overrides) and expires after 12 hours. A machine with no HuggingFace key fetches
nothing at all.

---

## HTTP API

`zstack serve` exposes a small, documented HTTP API for external callers and automation to establish, stream, and observe agent runs by reusing server internals.

### Authentication & Access

The server binds loopback (`127.0.0.1:4141`) by default and checks the `Host` header to defend against DNS rebinding.

When the environment variable `ZSTACK_API_TOKEN` is set, all routes require the shared token and return `401 Unauthorized` if it is missing or invalid. Pass the token via:
- `Authorization: Bearer <token>`
- `x-api-token: <token>`

### Error Format

Errors return structured JSON with standard HTTP status codes (`400`, `401`, `404`, `409`):

```json
{
  "ok": false,
  "error": "Short description",
  "detail": "Detailed explanation of the problem"
}
```

- `400`: Invalid request payload, empty prompt, unknown playbook or lane, or workspace outside the named project.
- `401`: Missing or invalid `ZSTACK_API_TOKEN`.
- `404`: Unknown run or project ID.
- `409`: A run is already active in the same canonical git repository.

### Endpoints

#### 1. `GET /api/health`

Health check and ModelHitch gateway connectivity status.

**Response (`200 OK`):**
```json
{
  "ok": true,
  "bridge": {
    "ok": true,
    "baseUrl": "http://127.0.0.1:3939",
    "providers": ["opencode"],
    "mode": "catalog"
  }
}
```

#### 2. `POST /api/runs`

Starts an agent run. Returns `201 Created` with the run ID so callers can poll or stream.

**Request Body:**
```json
{
  "prompt": "Fix race condition in session cleanup",
  "project": "proj-xyz",
  "playbook": "bug-fix",
  "lane": "auto",
  "policy": "read-only",
  "maxTurns": 25,
  "workspace": "/path/to/repo"
}
```

- `prompt` (*string, required*): The task prompt (non-empty).
- `project` (*string, optional*): Project ID. When named, the workspace is resolved strictly from the stored project's directory (never client-supplied paths); a request for a workspace outside the named project is refused with 400.
- `playbook` (*string, optional*): Task playbook ID (e.g. `feature`, `bug-fix`, `refactor`). Rejected with 400 if not loaded by the server.
- `lane` (*string, optional*): Provider lane (`auto`, `zen`, `go`, `hitch`). Rejected with 400 if unknown.
- `policy` (*string, optional*): Execution policy (`read-only`, `apply`, `strict`). Defaults to `read-only`.
- `maxTurns` (*number or string preset, optional*): Turn budget preset (`quick`, `standard`, `deep`, `marathon`) or integer.
- `workspace` (*string, optional*): Workspace path when not specifying a project.
- `requester` (*string, optional*): Caller identity, retained on run pages and history (for example `workfolk:job_<id>`).
- `idempotencyKey` (*string, optional*): Retry key, up to 256 characters. The first accepted request reserves the key on disk before execution. Identical retries return the same run ID with `200 OK` and `replayed: true`, including after a server restart. A different normalized request using that key returns `409 Conflict`. If an interrupted server never persisted the accepted run in history, retries return `409` with its original ID rather than starting duplicate work. Keys are stored beside history by default; `ZSTACK_IDEMPOTENCY_PATH` or the server's `idempotencyPath` option can isolate the index.

**Response (`201 Created`):**
```json
{
  "ok": true,
  "id": "run-abcdef123",
  "page": { ... }
}
```

#### 3. `GET /api/runs/:id`

Retrieves the run record (the same record rendered by the web run page).

**Response (`200 OK`):**
```json
{
  "ok": true,
  "id": "run-abcdef123",
  "status": "completed",
  "turns": 3,
  "toolCalls": 5,
  "outcomes": [
    { "name": "read_file", "target": "src/auth.mjs", "outcome": "ok", "tone": "ok" }
  ],
  "fileChanges": [
    { "path": "src/auth.mjs", "tool": "edit_file" }
  ],
  "projectId": "proj-xyz",
  "workspace": "/path/to/repo"
}
```

Returns `404 Not Found` if `:id` is unknown.

#### 4. `GET /api/runs/:id/events`

Server-Sent Events (SSE) stream for live runs. Replays event backlog and streams real-time updates until the terminal event (`end`). Client disconnection closes cleanly without cancelling the active run.

#### 5. `GET /api/budget`

Reads current budget settings (`tier`, `source`, `lane`), validates them against the live ModelHitch catalog, and returns the resolved role-to-model mapping and `laneApplied` flag without mutating state.

**Response (`200 OK`):**
```json
{
  "ok": true,
  "budget": {
    "tier": "med-high",
    "source": "catalog",
    "lane": "auto",
    "lastUpdated": "2026-10-04T12:00:00.000Z"
  },
  "tier": "med-high",
  "source": "catalog",
  "lane": "auto",
  "models": {
    "feature, refactoring": "opencode/deepseek-v4-pro",
    "judgment and prose": "opencode/claude-opus-5-5",
    "deep reasoning": "opencode/gpt-6-sol"
  },
  "laneApplied": true,
  "panel": ["opencode/claude-opus-5-5", "opencode/gpt-6-sol"],
  "mode": "opencode-zen",
  "effectiveFor": "subsequently started runs",
  "note": null
}
```

If the ModelHitch bridge is unreachable, returns `502 Bad Gateway` (or `504 Gateway Timeout`) with structured details `{ "ok": false, "error": "...", "kind": "unreachable" }`.

#### 6. `POST /api/budget`

Previews or updates the zstack budget configuration.

**Request Body:**
```json
{
  "tier": "high",
  "source": "catalog",
  "lane": "go",
  "confirm": true
}
```

- `tier` (*string, optional*): Budget tier (`low-med`, `med-high`, `high`, `max`). Preserves current stored tier if omitted.
- `source` (*string, optional*): Model selection source (`catalog`, `config`). Preserves current stored source if omitted. When `source` is `config`, models are pinned by ModelHitch policy and `laneApplied` is returned as `false`.
- `lane` (*string, optional*): Provider lane (`auto`, `zen`, `go`, `hitch`). Preserves current stored lane if omitted.
- `confirm` (*boolean, optional*): When `true`, writes the new configuration atomically to disk. When omitted or `false`, behaves as a **preview** returning the prospective mapping without modifying disk.

Strict body validation rejects any unknown fields (e.g. `workspace`, `prompt`) with `400 Bad Request`. Every prospective lane is validated against the live ModelHitch catalog before writing; if the gateway is unreachable, returns `502`/`504` and preserves stored configuration without writing.

Writes are whole-file and atomic (temporary file write then atomic rename), and concurrent requests are serialized safely. A budget change takes effect for subsequently started runs; runs already in flight are unaffected.

#### 7. `GET /api/schedules`

Lists all stored routine schedules, their configured cron expressions, policy, status, and last/next execution times.

#### 8. `POST /api/schedules`

Creates a new routine schedule.

**Request Body:**
```json
{
  "prompt": "Check git status and run tests",
  "cron": "0 9 * * 1-5",
  "name": "Daily test run",
  "policy": "read-only",
  "projectId": "proj-xyz",
  "lane": "auto",
  "enabled": true
}
```

#### 9. `POST /api/schedules/infer`

Infers routine schedule and cron expression from natural language text (e.g. "every morning at 9am check...").

**Request Body:**
```json
{
  "prompt": "every morning at 9am check git status and run tests"
}
```

**Response (`200 OK`):**
```json
{
  "ok": true,
  "inferred": {
    "matched": true,
    "cron": "0 9 * * *",
    "humanCadence": "Every morning at 09:00",
    "cleanedPrompt": "Check git status and run tests"
  }
}
```

#### 10. `POST /api/schedules/:id/run`

Triggers immediate execution of a scheduled routine.

#### 11. `GET /api/workfolk/status`

Inspects connectivity and authentication status with the local Workfolk gateway.

**Response (`200 OK`):**
```json
{
  "ok": true,
  "gatewayUrl": "http://127.0.0.1:3000",
  "hasToken": true,
  "authValid": true,
  "workersCount": 9
}
```

#### 12. `GET /api/workfolk/workers`

Lists the active specialist workers registered in the Workfolk swarm, their roles, and capabilities.

**Query Parameters:**
- `includeRetired` (*boolean, optional*): Include retired workers when `true`. Defaults to `false`.

**Response (`200 OK`):**
```json
{
  "ok": true,
  "workers": [
    {
      "tag": "developer",
      "name": "Developer",
      "role": "Senior Full-Stack Engineer",
      "description": "Writes production-ready code, implements features, and runs tests",
      "tools": ["terminal", "editor", "git", "browser"],
      "status": "active"
    }
  ]
}
```

#### 13. `POST /api/workfolk/dispatch`

Submits an asynchronous work order to a specialist Workfolk worker.

**Request Body:**
```json
{
  "worker_tag": "@developer",
  "task": "Add exponential backoff retry logic to HTTP client",
  "wait": false
}
```

- `worker_tag` (*string, required*): The target worker tag (with or without leading `@`).
- `task` (*string, required*): The task description (1..16000 characters).
- `wait` (*boolean, optional*): When `true`, long-polls the gateway until the job reaches a terminal state before returning.

**Response (`202 Accepted` or `200 OK` when `wait: true`):**
```json
{
  "ok": true,
  "job_id": "job_550e8400-e29b-41d4-a716-446655440000",
  "status": "queued"
}
```

#### 14. `GET /api/workfolk/jobs/:id`

Retrieves the current status and output for a dispatched Workfolk job.

**Response (`200 OK`):**
```json
{
  "ok": true,
  "job_id": "job_550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "result": "Successfully added exponential backoff retry logic with jitter."
}
```

---

## Schedules & Unattended Routines

zstack includes a zero-dependency scheduler daemon with natural-language routine inference, cron execution, and unattended safety guards. Your agents work while you sleep.

### Routine Inference from Chat
Workfolk frequently ask agents to perform recurring tasks using everyday language ("every morning...", "every weekday at 9am...", "nightly at midnight...").
In the web chat interface, every user message and conversation header provides a 1-click **Save as routine** action. The server automatically parses the cadence into standard 5-part cron syntax and strips schedule boilerplate to produce a clean task prompt.

### Unattended Safety
- **Safe defaults**: Scheduled runs default to `policy: "read-only"`. Mutating actions require explicit `policy: "apply"`.
- **Repo concurrency guard**: If a routine fires while a developer or another agent has an active run in the same git repository, the scheduler skips the execution cleanly (`status: "skipped-busy"`) rather than interleaving git mutations or corrupting working trees.
- **Audit trail**: Scheduled runs record `trigger: "schedule"` in history with the routine's ID and name.

### CLI Usage

```bash
# List all routines
zstack schedule list [--json]

# Add a routine with automatic natural-language cadence inference
zstack schedule add "every weekday at 9am run daily checks and verify build"

# Add a routine with explicit cron and mutating policy
zstack schedule add "clean stale build artifacts" --cron "0 2 * * *" --policy apply

# Infer cron cadence from text
zstack schedule infer "every 2 hours review open PRs"

# Pause, resume, trigger, or delete routines
zstack schedule disable <id>
zstack schedule enable <id>
zstack schedule run <id>
zstack schedule delete <id>
```

---

## Workfolk ↔ zstack Bridge

zstack and Workfolk (`gateway_workers`) form a bidirectional agent mesh:

1. **zstack → Workfolk (Task Dispatch & Team Delegation)**
   - zstack discovers available Workfolk specialists via `GET /api/workers` (`@coordinator`, `@developer`, `@researcher`, `@infra`, etc.).
   - Dispatches autonomous work orders via `POST /api/dispatch` using the trusted bearer token (`WORKFOLK_TOKEN` or `GATEWAY_WORKERS_TOKEN`).
   - Polls job progression via `GET /api/jobs/:id` with zero external dependencies.
   - Web UI integrates a 1-click **Hand off to Workfolk** button directly on chat messages and conversation headers.

2. **Workfolk → zstack (Playbook Execution & Sibling Lane)**
   - Workfolk's swarm registry registers `@zstack` as an autonomous playbook executor.
   - Workfolk advertises `zstack: true` in `siblingAgentLanesOffered`.
   - Workfolk routes external agent handoffs to zstack's HTTP API (`POST /api/runs`).

### Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `WORKFOLK_URL` | `http://127.0.0.1:3000` | Base URL of the Workfolk gateway server. |
| `WORKFOLK_TOKEN` | — | Bearer token for authenticating task dispatch and polling (`GATEWAY_WORKERS_TOKEN` also accepted). |

---

## TypeScript SDK Reference

### Basic Usage

```typescript
import { ZStack } from 'zstack';

const z = new ZStack({
  baseUrl: 'http://127.0.0.1:3939' // Optional: defaults to MODELHITCH_BASE_URL
});

// Run a task with automatic classification and playbook grounding
const result = await z.task({
  prompt: 'Fix memory leak in websocket event listeners',
  files: ['src/socket.ts'],
  playbook: 'perf-issue' // Optional: auto-classified if omitted
});

console.log(result.content);
console.log(`Executed by ${result.model} (${result.durationMs}ms)`);
console.log(`Tokens used: ${result.usage.total_tokens}`);
```

### Agentic Runs

`task()` returns text from one completion. `agent()` runs the tool loop, so the
model can read the workspace, run commands, and change files:

```typescript
const run = await z.agent({
  prompt: 'Add an events API and rename Chronos to OddEvents',
  workspaceDir: process.cwd(),
  apply: true,       // without this, mutating calls are declined
  maxTurns: 12,
  onEvent: (event) => {
    // Same records the CLI renders; stream them into your own UI.
    if (event.type === 'tool') console.log(`${event.name} -> ${event.outcome}`);
  }
});

console.log(run.applied, run.turns, run.toolCalls);
console.log(run.fileChanges);   // [{ path, tool, turn }]
console.log(run.declinedTools); // calls the gate refused
console.log(run.content);       // the model's closing message
console.log(run.narrative);     // everything it said, across all turns
```

`run.ok` is false when the harness exits non-zero, and `run.malformedEvents`
counts stream lines that could not be parsed, so a consumer can tell a clean run
from a degraded one. Requires the ModelHitch harness on `PATH` (`mhh`), a
sibling ModelHitch checkout, or `ZSTACK_HARNESS_BIN` pointing at
`dist/harness-cli.js`.

### Provider Lanes

```typescript
// Pin the lane for one call without touching stored settings
const result = await z.task({
  prompt: 'Fix the flaky retry test',
  lane: 'go' // auto | zen | go | hitch
});

// Persist a lane, then read back the resolved mapping
const budget = await z.setBudget('med-high', 'catalog', 'go');
console.log(budget.laneApplied); // false when source=config pins models
for (const [role, model] of Object.entries(budget.models)) {
  console.log(`${role} -> ${model}`);
}
```

### Parallel Adversarial Panel Review

```typescript
const critiques = await z.panel(
  'Evaluate proposed transaction serialization boundary'
);

for (const c of critiques) {
  if (c.ok) {
    console.log(`Model: ${c.model} (${c.durationMs}ms)`);
    console.log(c.content);
  }
}
```

### Direct Role Dispatch

```typescript
const response = await z.runRole(
  'judgment and prose',
  'Write architecture note explaining the token lifecycle'
);

console.log(response.content);
```

### Prompt Classification

```typescript
const info = z.classifyPrompt('Why is memory growing during batch imports?');
console.log(info.type); // "perf-issue"
console.log(info.playbookFile); // "playbooks/perf-issue.md"
console.log(info.principles); // ["fix-root-causes", "build-the-lever", "prove-it-works"]
```

---

## Execution Playbooks

Standard Operating Procedures located in `playbooks/`:

| Playbook | Trigger |
| :--- | :--- |
| `feature.md` | Implementing new user-facing functionality, API routes, or subsystems. |
| `bug-fix.md` | Resolving bugs, failing tests, crashes, or reported regressions. |
| `refactoring.md` | Restructuring or simplifying code without altering external behavior. |
| `perf-issue.md` | Diagnosing latency bottlenecks, memory growth, or throughput limits. |
| `prototype.md` | Exploring unproven approaches or settling design feasibility questions. |
| `investigation.md` | Answering architectural questions or tracing unknown execution paths. |
| `runtime-forensics.md` | Investigating process crashes, hangs, deadlocks, or socket leaks. |
| `trace-forensics.md` | Diagnosing distributed tracing spans, timeouts, or network delays. |
| `opening-a-pr.md` | Structuring commits, writing diff summaries, and preparing PRs. |
| `eval.md` | Measuring model accuracy, benchmark deltas, or regression thresholds. |
| `visual-parity.md` | Aligning user interfaces with visual mockups or design specifications. |
| `pause-safely.md` | Creating auditable checkpoints before pausing an active session. |
| `session-pickup.md` | Resuming work from prior checkpoints or interrupted branches. |
| `autonomous-run.md` | Running long-running unattended agent loops with progress gates. |
| `authoring-a-skill.md` | Packaging verified workflows into reusable agent skills. |

---

## Core Engineering Principles

Twenty principles located in `principles/`:

- **Laziness Protocol** (`laziness-protocol.md`): Delete before writing. Reject premature abstractions.
- **Foundational Thinking** (`foundational-thinking.md`): Define core data types and invariants before business logic.
- **Redesign from First Principles** (`redesign-from-first-principles.md`): Redesign foundational boundaries when adding major requirements.
- **Subtract Before You Add** (`subtract-before-you-add.md`): Remove dead code before adding features on top of debt.
- **Minimize Reader Load** (`minimize-reader-load.md`): Collapse unnecessary indirection and shrink mutable scope.
- **Outcome-Oriented Execution** (`outcome-oriented-execution.md`): Converge to target state without leaving orphaned shims.
- **Experience First** (`experience-first.md`): Prioritize caller ergonomics over internal implementation ease.
- **Exhaust the Design Space** (`exhaust-the-design-space.md`): Explore multiple candidate solutions before committing.
- **Build the Lever** (`build-the-lever.md`): Automate repetitive tasks into reusable scripts and harnesses.
- **Boundary Discipline** (`boundary-discipline.md`): Validate strictly at inputs; trust verified internal types.
- **Type System Discipline** (`type-system-discipline.md`): Make illegal states unrepresentable with tagged unions.
- **Make Operations Idempotent** (`make-operations-idempotent.md`): Ensure handlers converge safely on repeated execution.
- **Migrate Callers Then Delete Legacy APIs** (`migrate-callers-then-delete-legacy-apis.md`): Remove deprecated paths in one clean migration.
- **Separate Before Serializing Shared State** (`separate-before-serializing-shared-state.md`): Partition ownership before introducing locks.
- **Prove It Works** (`prove-it-works.md`): Verify against live processes and real artifacts, not mocks.
- **Fix Root Causes** (`fix-root-causes.md`): Reproduce failures and trace to source rather than masking symptoms.
- **Sequence Verifiable Units** (`sequence-verifiable-units.md`): Decompose work into independently testable commits.
- **Guard the Context Window** (`guard-the-context-window.md`): Offload bulk file reads and searches to targeted subagents.
- **Never Block on the Human** (`never-block-on-the-human.md`): Formulate prototypes on reversible decisions autonomously.
- **Encode Lessons in Structure** (`encode-lessons-in-structure.md`): Institutionalize fixes via linters, types, or tests.

---

## Editor & Agent Integration

Install the `zstack` skill across your local agent environments via ModelHitch:

```bash
modelhitch setup zstack
```

Supported environments:
- **Cursor**: `~/.cursor/skills/zstack` and `~/.cursor/rules/zstack-models.mdc`
- **Claude Code**: `~/.claude/skills/zstack`
- **OpenAI Codex**: `~/.codex/skills/zstack`
- **GitHub Copilot / VS Code**: `~/.copilot/skills/zstack`
- **Google Antigravity**: `~/.gemini/config/skills/zstack`

In chat or editor prompts, prefix multi-step tasks with `/z-mode`:

```text
/z-mode Build idempotent webhook receiver with replay verification
```

---

## Verification & Testing

Run the automated test suite:

```bash
npm test
```

Tests validate:
1. ModelHitch bridge health check on `127.0.0.1:3939`.
2. Catalog and active provider discovery.
3. Role mapping resolution across all 15 engineering roles.
4. Live prompt execution via the local bridge.
5. SDK playbook and principle index resolution.
6. Prompt classification accuracy.
7. Task execution with contextual playbook grounding.

---

## License

MIT License. Copyright (c) 2026 genoventures-labs.
