# Make Operations Idempotent

> **Apply when:** Designing CLI commands, deployment scripts, migration loops, API endpoints, or retry logic.

Ensure executing an operation multiple times produces the exact same end state without corrupting data or creating duplicates.

## Core Rules

1. **Declarative target state.** Design operations around "ensure X is in state Y" rather than "append X". If a file or database row already exists with the desired state, the operation should succeed cleanly.
2. **Crash-safe retries.** Assume any network call, file write, or subagent task can crash midway. Use unique idempotency keys, atomic file renames (`fs.rename`), or database transactions so partial failures do not leave corrupt partial states.
3. **Safe re-runs.** Re-running a setup script, playbook step, or migration should never fail or duplicate resources.
