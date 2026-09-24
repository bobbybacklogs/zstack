# Encode Lessons in Structure

> **Apply when:** Catching yourself writing the same guideline, warning, or manual instruction a second time.

Encode hard-won lessons into automated linters, type checks, runtime assertions, or build scripts rather than relying on human memory or documentation notes.

## Core Rules

1. **Automation over admonition.** Telling engineers or agents "please remember not to do X" fails reliably. Add an ESLint rule, a custom pre-commit hook, or a TypeScript type constraint that prevents X at compile time.
2. **Structural guardrails.** If an invariant is critical, enforce it at runtime with a schema or assertion that throws on violation.
3. **Compound resilience.** Every lesson converted into an automated test or linter permanently hardens the codebase against future regressions.
