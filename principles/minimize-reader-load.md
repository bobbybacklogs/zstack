# Minimize Reader Load

> **Apply when:** Reviewing, authoring, or refactoring code that feels dense, convoluted, or hard to trace.

Reduce the cognitive burden on the next human engineer or AI agent reading this code.

## Core Rules

1. **Collapse one-caller wrappers.** A 3-line function called by only one site does not simplify anything; it forces the reader to jump between contexts. Inline it until multiple callers justify extraction.
2. **Flatten nested pyramids.** Use early returns and guard clauses to keep the happy path left-aligned and free of deep indentation.
3. **Minimize mutable scope.** Declare variables as close as possible to where they are used. Prefer `const` and immutability over variables mutated 50 lines later.
