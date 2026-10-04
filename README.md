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
between OpenCode's pay-per-use catalog, its flat-rate Go subscription, or plain
ModelHitch routing without editing role mappings by hand.

| Lane | Prefix | Description |
| --- | --- | --- |
| `auto` | — | Zen when an OpenCode key is active, otherwise hitch |
| `zen` | `opencode/` | OpenCode Zen pay-per-use models |
| `go` | `opencode-go/` | OpenCode Go and Go Plus flat-rate models |
| `hitch` | — | No OpenCode preference; active ModelHitch providers and config default |

```bash
zstack budget med-high --source catalog --lane go --confirm
zstack --go "Fix the flaky retry test"        # one-shot override
zstack --zen "Refactor the parser"            # aliases: --zen, --go, --hitch
zstack --lane hitch "Investigate the timeout"
```

Lane resolution applies whenever the source is `catalog`. With
`--source config` your ModelHitch policy pins the models, so the lane is recorded
but not applied and the mapping reports `laneApplied: false`. The stored lane
survives a tier-only update. Every lane is validated against the live catalog, so
a resolved model the gateway does not serve is never selected.

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
