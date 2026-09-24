# Sequence Work into Verifiable Units

> **Apply when:** Planning multi-file features, broad migrations, or complex system overhauls.

Break large tasks down into small, self-contained units where each unit ends with an automated, verifiable check.

## Core Rules

1. **Verify at every step.** A plan consisting of 8 code changes followed by 1 giant test run at the very end is fragile. Structure tasks so step 1 can be tested, verified, and committed before moving to step 2.
2. **Order delivery so the sequence proves itself.** Implement the dependency before the dependent; implement the storage schema before the API route; implement the API route before the UI form.
3. **Atomic commits.** Every step should leave the repository in a compiling, passing, deployable state.
