# Subtract Before You Add

> **Apply when:** Sequencing a feature addition, refactor, or subsystem rewrite.

Remove dead weight and simplify the existing system before adding new capabilities.

## Core Rules

1. **Clean the ground first.** Building a new feature on top of deprecated routes, obsolete state variables, or redundant helpers compounds complexity. Delete the legacy code first.
2. **Two-phase PR sequencing.** When a feature requires refactoring existing code, separate the cleanup from the feature addition into sequential commits or pull requests. A pure refactor PR should have zero behavior changes; a feature PR should build cleanly on the polished foundation.
3. **Dead code is a liability.** Unused functions, commented-out code, and obsolete feature flags obscure system behavior and confuse future agents. Prune aggressively.
