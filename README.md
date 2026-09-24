# zstack

> **An Agent Operating System for Rigorous Engineering.**  
> Powered by OpenCode Zen & Go models via the [ModelHitch](https://github.com/bobbybacklogs/ModelHitch) BYOK local gateway (`127.0.0.1:3939`).

`zstack` is an opinionated, verification-first operating system for AI coding agents. Inspired by Lauren Tan's `pstack` / `poteto-mode`, `zstack` strips away chatty, unverified code generation in favor of:

1. **Task-Specific Playbooks**: Standard Operating Procedures (SOPs) for features, bug-fixes, refactors, prototypes, and forensics.
2. **Durable Principles**: 20 core engineering principles (laziness protocol, prove-it-works, subtract-before-you-add, boundary discipline, etc.) cited against actual decisions.
3. **Workload-Specific Model Routing**: Matching tasks to the best OpenCode Zen and Go models (fast coding vs. deep architectural judgment vs. multi-family adversarial panels).
4. **ModelHitch Integration**: Solving OpenCode Zen's multi-wire endpoint fragmentation by routing all agent traffic through a unified, resilient local proxy on `http://127.0.0.1:3939/v1`.

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
|   Router: /z-mode                                                               |
|   ├── Task Classification (Feature, Bug-fix, Refactor, Investigation, etc.)     |
|   ├── Principles Index (Laziness Protocol, Prove-It-Works, Guard Context, etc.) |
|   └── Task Playbooks (playbooks/*.md)                                           |
+---------------------------------------------------------------------------------+
                                          |
             Role Assignment: Fast Coder | Architect / Judgment | Review Panels
                                          v
+---------------------------------------------------------------------------------+
| ModelHitch Bridge (http://127.0.0.1:3939/v1)                                   |
|                                                                                 |
|   - Multi-wire normalization (/responses, /messages, /chat/completions, /models)|
|   - Automatic failover & circuit-breaking (429 / 5xx)                           |
|   - Local token, cost, and latency analytics (modelhitch-usage.db)              |
+---------------------------------------------------------------------------------+
                         /                |               \
                        /                 |                \
                       v                  v                 v
            +--------------------+ +---------------+ +-----------------------+
            | OpenCode Go        | | OpenCode Zen  | | Fallbacks / Free      |
            | (Flat Rate Sub)    | | (Pay-per-use) | | (Local Ollama, etc.)  |
            |                    | |               | |                       |
            | - deepseek-v4-pro  | | - claude-son- | | - deepseek-v4-flash   |
            | - kimi-k2.7-code   | |   net-4-6     | | - big-pickle          |
            | - glm-5.1          | | - gpt-5.5     | | - mimo-v2.6-flash     |
            |                    | | - qwen3.7-max | |                       |
            +--------------------+ +---------------+ +-----------------------+
```

---

## Model Roles & Routing Matrix

`zstack` separates the engineering role from the model. Using the OpenCode catalog routed via ModelHitch:

| Role | Default Model | Upstream Service | Rationale |
| :--- | :--- | :--- | :--- |
| **Fast Coder / Implementation** | `deepseek-v4-pro` | OpenCode Go | High-throughput, precise code generation under flat-rate subscription. |
| **Alternative Coder** | `kimi-k2.7-code` | OpenCode Go | Specialized coding agent for long-context refactors. |
| **Rapid Exploration / Forensics** | `deepseek-v4-flash` | OpenCode Zen | Extreme speed & cost efficiency ($0.14 / 1M input) for throwaway probes. |
| **Architect / Judgment / Prose** | `claude-sonnet-4-6` | OpenCode Zen | Frontier reasoning for architecture decisions, diff reviews, and Diátaxis docs. |
| **Deep Reasoning Alternative** | `gpt-5.5` | OpenCode Zen | High-rigor frontier model for complex mathematical or algorithm design. |
| **Adversarial Review Panel** (`/arena`, `/interrogate`, `critics`) | Multi-family ensemble:<br>1. `claude-sonnet-4-6`<br>2. `gpt-5.5`<br>3. `deepseek-v4-pro`<br>4. `qwen3.7-max` | OpenCode Zen & Go | Cross-family ensemble prevents shared blind spots during adversarial reviews. |

---

## Directory Structure

```
zstack/
├── skills/
│   ├── z-mode/                   # Primary task router and orchestrator
│   └── setup-zstack/             # Interactive role-to-model configuration
├── principles/                   # 20 core engineering principles
│   ├── laziness-protocol.md
│   ├── foundational-thinking.md
│   ├── subtract-before-you-add.md
│   ├── prove-it-works.md
│   ├── fix-root-causes.md
│   ├── guard-the-context-window.md
│   ├── never-block-on-the-human.md
│   ├── build-the-lever.md
│   ├── boundary-discipline.md
│   ├── type-system-discipline.md
│   ├── make-operations-idempotent.md
│   ├── migrate-callers-then-delete-legacy-apis.md
│   ├── separate-before-serializing-shared-state.md
│   ├── sequence-verifiable-units.md
│   ├── redesign-from-first-principles.md
│   ├── minimize-reader-load.md
│   ├── outcome-oriented-execution.md
│   ├── experience-first.md
│   ├── exhaust-the-design-space.md
│   └── encode-lessons-in-structure.md
├── playbooks/                    # 16 task-specific execution playbooks
│   ├── feature.md
│   ├── bug-fix.md
│   ├── prototype.md
│   ├── refactoring.md
│   ├── investigation.md
│   ├── perf-issue.md
│   ├── runtime-forensics.md
│   ├── trace-forensics.md
│   ├── opening-a-pr.md
│   ├── pause-safely.md
│   ├── session-pickup.md
│   ├── autonomous-run.md
│   ├── eval.md
│   ├── visual-parity.md
│   └── authoring-a-skill.md
├── verification/                 # Verification infrastructure templates
│   ├── feature-map.template.md
│   ├── evidence-schema.json
│   └── README.md
└── docs/
    └── refs/                     # Reference documents & OpenCode Zen cheatsheet
```

---

## Quickstart

### 1. Ensure ModelHitch is Running
ModelHitch runs locally on port 3939 as your multi-wire bridge:
```bash
modelhitch status
# or to start in background:
modelhitch bridge --background
```

### 2. Configure Model Roles
Run the setup command or inspect `setup-zstack`:
```
/setup-zstack
```
This generates your local rule file configuring role-to-model mappings directed at your ModelHitch bridge.

### 3. Enter zstack Mode
In your AI editor / agent prompt, prefix multi-step tasks with:
```
/z-mode Build the authentication token refresh loop with rotation evidence
```

The router classifies your task, reads the applicable principles, selects the matching playbook, writes a verifiable todolist, delegates sub-tasks through ModelHitch, and verifies the final result before reporting done.
