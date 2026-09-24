# Build the Lever

> **Apply when:** Performing non-trivial, multi-file, or recurring tasks.

Build the tool that does or proves the work (codemod, CLI command, generator script) instead of performing edits manually.

## Core Rules

1. **The script is the proof.** A manual 40-file find-and-replace is brittle and error-prone. A small AST script or deterministic shell command can be re-run by reviewers and CI.
2. **Project-local test CLIs.** For complex systems, construct a lightweight local CLI or test harness script that can seed state, drive user flows, and emit structured JSON evidence.
3. **Compound leverage.** Every tool or verification script you build during a task becomes permanent infrastructure that accelerates all subsequent agent sessions.
