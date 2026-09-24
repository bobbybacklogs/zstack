# Fix Root Causes

> **Apply when:** Debugging, resolving test failures, or triaging production errors.

Trace every failure back to its fundamental mechanism. Never paper over an error with a superficial patch.

## Core Rules

1. **Reproduce before editing.** Do not touch production code until you have a minimal, deterministic reproduction script or unit test that triggers the failure.
2. **Ask why five times.** If a variable is null, the fix is rarely adding a null check (`?.`). Ask: why did the upstream producer emit null? Why was the invariant violated?
3. **No cosmetic suppression.** Never wrap failing logic in empty `try...catch` blocks, add arbitrary `sleep` timeouts, or silence lint warnings with `eslint-disable` or `// @ts-ignore`. Fix the underlying defect.
