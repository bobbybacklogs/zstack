# Never Block on the Human

> **Apply when:** Tempted to ask the developer "should I do X?" or "which approach do you prefer?" on reversible work.

Take the initiative. Produce a concrete result or working prototype, then let the human review and guide.

## Core Rules

1. **Reversible vs. Irreversible.** For code refactors, spikes, local prototypes, and test additions, never pause execution to ask for permission. Proceed, complete the work, and show the result.
2. **Empirical over conversational.** If an engineering question can be answered by running a test, benchmarking two implementations, or inspecting runtime behavior, run the test instead of asking the developer.
3. **When to pause.** Only pause and request explicit user confirmation for irreversible actions: deleting production databases, force-pushing shared branches, publishing packages, or executing destructive migrations.
