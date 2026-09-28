# zstack

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-9%20passed-brightgreen.svg)](tests/connector.test.mjs)
[![Gateway](https://img.shields.io/badge/gateway-ModelHitch%203939-orange.svg)](https://github.com/bobbybacklogs/ModelHitch)

An opinionated Agent Operating System, TypeScript SDK, and CLI for rigorous software engineering.

`zstack` decouples high-level engineering tasks from individual models. It structures development through task-specific playbooks, enforces twenty non-negotiable engineering principles, and routes operations to specialized language models via [ModelHitch](https://github.com/bobbybacklogs/ModelHitch) (`127.0.0.1:3939`).

---

## Key Capabilities

- **15 Standard Operating Playbooks**: Structured execution recipes for features, bug fixes, refactoring, performance forensics, and pull requests.
- **20 Durable Principles**: Non-negotiable engineering rules (laziness protocol, root cause remediation, boundary discipline, context preservation) cited against concrete code changes.
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

`--max-turns <n>` bounds the loop (harness default 8) and `--review` runs the
read-only reviewer over the change afterwards.

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
