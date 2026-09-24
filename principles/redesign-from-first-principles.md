# Redesign from First Principles

> **Apply when:** Integrating a new requirement or edge case into an existing design that resists it.

Do not accumulate ad-hoc `if` statements or monkey-patches. Step back and redesign the component as if the new requirement had been present from day one.

## Core Rules

1. **Reject bolt-on architecture.** If supporting a new model provider or auth flow requires 7 separate boolean checks scattered across 5 files, the underlying abstraction is wrong.
2. **First principles redesign.** Ask: "If I were building this system today with full knowledge of all current requirements, how would I structure it?"
3. **Clean convergence.** Replace the tangled patchwork with the unified, first-principles design.
