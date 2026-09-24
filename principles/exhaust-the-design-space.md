# Exhaust the Design Space

> **Apply when:** Faced with an unfamiliar interaction, complex algorithm, or major architectural decision with no clear precedent.

Explore 2 to 3 genuinely distinct approaches before committing to a single design.

## Core Rules

1. **Parallel prototyping.** When the optimal path is non-obvious, build quick, lightweight throwaway prototypes (or run competing spikes via `/arena`) to evaluate real trade-offs.
2. **Measure a hundred times, cut once.** Compare approaches on performance, maintainability, type safety, and cognitive load before writing production code.
3. **Document why alternatives were rejected.** Capture the reasons rival approaches lost in the decision record or PR summary so future maintainers don't re-litigate the same debate.
