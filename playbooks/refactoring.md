# Playbook: Refactoring

> **Trigger:** Restructuring, cleaning, or optimizing code without changing observable external behavior.

Refactor with discipline: lock in baseline tests first, shrink lines of code, and prove behavioral parity.

---

## Step 1: Establish Characterization Tests
- Before changing any internal code, verify you have tests covering current behavior.
- If coverage is missing, write characterization tests capturing existing inputs and outputs before altering any implementation.

## Step 2: Subtract Dead Weight
- Delete obsolete comments, unused parameters, dead branches, and redundant helper functions first (`principles/subtract-before-you-add.md`).
- A clean canvas makes structural refactoring simpler.

## Step 3: Execute in Atomic Steps
- Apply one structural refactoring at a time (e.g. inline function, extract interface, rename symbol).
- Run the test suite after each atomic step to guarantee zero regressions.
- Collapse one-caller indirection and shrink mutable scope (`principles/minimize-reader-load.md`).

## Step 4: Prove Behavioral Parity
- Re-run characterization tests and existing project test suites (`principles/prove-it-works.md`).
- Compare git diff to verify that only internal structures changed and public contracts remained untouched.
- Verify negative or near-neutral line count delta (`principles/laziness-protocol.md`).
