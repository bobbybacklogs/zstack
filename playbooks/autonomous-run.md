# Playbook: Autonomous Run

> **Trigger:** Multi-hour, overnight, or unattended batch agent loops ("run until done", "/loop").

Maintain control, prevent runaway regressions, and build an auditable trail during long autonomous execution.

---

## Step 1: Establish Strict Checkpoint Gates
- Define atomic milestone increments.
- Require each milestone to end in an automated test pass before advancing to the next milestone (`principles/sequence-verifiable-units.md`).

## Step 2: Circuit Breakers for Failure Loops
- If an agent hits 3 consecutive test or compilation failures on the same unit, abort the branch immediately. Never cycle endlessly in error loops.
- Revert the working tree back to the last green milestone before investigating.

## Step 3: Record the Decision Trail
- Keep an auditable record of choices made, tests run, and options rejected (e.g. `docs/decisions/run-<timestamp>.md`).
- Ensure the developer can review the complete narrative upon return.
