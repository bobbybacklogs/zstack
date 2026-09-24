# Playbook: Bug Fix

> **Trigger:** Resolving a bug, test failure, crash, regression, or reported defect.

Fix root causes cleanly rather than applying superficial patches.

---

## Step 1: Reproduce Deterministically First
- Do not edit source code until you can reliably trigger the failure.
- Create a minimal reproduction test or standalone script reproducing the exact failure mode (`principles/fix-root-causes.md`).
- Document the exact failing output, stack trace, and unexpected state.

## Step 2: Trace to the Root Cause
- Trace the defect to its fundamental mechanism.
- Ask "why" repeatedly: Why did the upstream emit invalid data? Why did the state transition happen out of order?
- Reject surface patches (e.g. adding `?.` without understanding why the value was null).

## Step 3: Apply the Minimal Surgical Fix
- Make the smallest possible change that fixes the root cause (`principles/laziness-protocol.md`).
- Avoid refactoring surrounding code while fixing a bug. Keep the diff isolated.

## Step 4: Prove the Fix
- Run the reproduction test created in Step 1. Verify that it now passes cleanly.
- Run the full project test suite to verify no regressions were introduced.

## Step 5: Encode the Lesson in Structure
- Commit the reproduction test as a permanent regression test (`principles/encode-lessons-in-structure.md`).
- If applicable, strengthen type constraints or schemas so the bug is unrepresentable at compile time (`principles/type-system-discipline.md`).
