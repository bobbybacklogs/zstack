# Migrate Callers Then Delete Legacy APIs

> **Apply when:** Replacing an internal API, function signature, or data contract.

Migrate all callers and delete the old API in one unified initiative. Never allow zombie APIs to linger.

## Core Rules

1. **No indefinite deprecation internally.** Within a private repository or monolith, there is no need for prolonged deprecation cycles. Update callers across the codebase and immediately delete the deprecated function or interface.
2. **Eliminate dual paths.** Maintaining two ways to do the same thing doubles cognitive load for future developers and confuses coding agents.
3. **Clean git history.** Keep the migration and the deletion together in the same PR or atomic series so the transition is obvious in code reviews.
