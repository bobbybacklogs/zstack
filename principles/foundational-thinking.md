# Foundational Thinking

> **Apply when:** Before writing business logic, designing data models, or sequencing multi-component changes.

Core data structures, lifecycle invariants, and concurrent state ownership must be established before writing feature code.

## Core Rules

1. **Name the data shape first.** Before writing a single function or UI component, define the TypeScript interface, schema, or relational model. When the data structures are correct, the algorithms become obvious.
2. **Clarify state ownership.** Explicitly identify which component or process owns the single source of truth. If two actors must coordinate, decide which one writes and which one subscribes.
3. **Scaffold before implementation.** Sequence changes so that foundational primitives (types, base errors, migrations) exist and are tested before building consumer features on top of them.
