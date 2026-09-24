# Guard the Context Window

> **Apply when:** Handling large files, reading logs, searching codebases, or planning parallel agent sweeps.

Protect your main conversation context. High-volume, raw text degrades agent reasoning and wastes tokens.

## Core Rules

1. **Offload bulk scans to subagents.** Never dump entire directory trees, thousands of lines of logs, or large raw JSON responses into the primary context. Delegate targeted research subagents to read and summarize.
2. **Pass pointers, not payloads.** Share file paths and specific line number ranges (`src/core/router.ts#L45-L60`) rather than inlining 500 lines of source code.
3. **Consolidate state before resuming.** When picking up after multiple subagents, summarize the verified conclusions and discard raw conversational chatter. Keep only actionable facts in the primary context.
