# Laziness Protocol

> **Apply when:** Refactoring, sizing a diff, or tempted to add abstractions, layers, helper utilities, or indirection.

Bias heavily toward deletion and the smallest surgical change that solves the problem.

## Core Rules

1. **Delete before you write.** The best diff is negative lines of code. Dead features, obsolete flags, and unused parameters must be removed, not preserved "just in case."
2. **Reject premature abstractions.** Do not create generic factories, manager classes, or multi-tiered wrappers for code called in only one place. Inline logic until three distinct call sites demand a shared helper.
3. **Keep the diff footprint small.** Solve the specific problem in front of you. Do not refactor adjacent files unless required for correctness. Keep commits focused and easy for human maintainers to review.
4. **Question every dependency.** Do not pull in a third-party package for a task achievable with 10 lines of standard library code.
