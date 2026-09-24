# Outcome-Oriented Execution

> **Apply when:** Executing multi-phase migrations, refactors, or capability replacements.

Drive relentlessly toward the final target state. Do not invent throwaway intermediate compatibility layers that linger permanently.

## Core Rules

1. **Avoid the intermediate trap.** Engineering efforts often stall in temporary transition states (e.g. supporting both old and new paradigms simultaneously) that end up persisting for years. Define clear phase milestones and finish the migration.
2. **Burn the ships.** Once the new implementation is proven, decommission and delete the old pathway immediately.
3. **Evidence-driven completion.** A migration is not done when the code compiles; it is done when all traffic has shifted, legacy code is deleted, and verification confirms zero regressions.
