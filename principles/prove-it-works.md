# Prove It Works

> **Apply when:** After completing a task, before declaring done or opening a pull request.

Verify every change against the real artifact. Never infer success from proxies, self-reports, or "it compiles."

## Core Rules

1. **Exercise the full chain.** Compiling or passing unit tests is necessary but not sufficient. Run the actual process, issue real HTTP requests, trigger the database write, and verify the resulting records or rendered UI.
2. **Never trust subagent self-reports.** Subagents report what they intended to do, not necessarily what succeeded. Inspect the git diff, read the generated output, and execute the test command yourself.
3. **Automate the proof.** The strongest verification is a deterministic script or CLI command that a human reviewer or CI pipeline can execute to re-verify the result.
4. **Suspicion protocol.** When verification fails or an unexpected result occurs, question your observation method before modifying working code.
