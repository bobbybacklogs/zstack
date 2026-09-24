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

### 2. Task with Explicit Playbook and File Attachments

Specify a playbook explicitly and attach local source files for bounded context:

```bash
zstack task feature "Add token bucket rate limiting to refresh route" --files src/auth.ts,src/server.ts
```

### 3. Adversarial Multi-Family Panel Review

Dispatch an architecture question or proposed diff to a multi-model panel:

```bash
zstack panel "Should we use optimistic concurrency or distributed locks for ledger balances?"
```

### 4. Rule Synchronization

Inspect active ModelHitch providers and generate or update Cursor rules:

```bash
# Update global rule (~/.cursor/rules/zstack-models.mdc)
zstack sync

# Update project-level rule (.cursor/rules/zstack-models.mdc)
zstack sync --project
```

### 5. Upstream Synchronization

Check the canonical `pstack` repository (`cursor/plugins/tree/main/pstack`) on demand for new commits, playbooks, or principle updates:

```bash
# Check upstream for changes (interactive prompt to record checkpoint)
zstack update

# Automatically record and sync the latest upstream checkpoint
zstack update --apply

# Check upstream status without prompting
zstack update --check
```

### 6. Introspection & Health

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
