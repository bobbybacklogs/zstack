# Playbook: Opening a PR

> **Trigger:** Packaging completed, verified work into a clean commit series and pull request.

Deliver clean, reviewable pull requests with evidence of verification.

---

## Step 1: Review the Complete Diff Yourself
- Run `git diff main...HEAD` and inspect every line.
- Strip temporary debugging logs, unused imports, scratch files, and unintended whitespace changes (`principles/laziness-protocol.md`).

## Step 2: Run Full Project Quality Gates
- Execute the build: `npm run build` or equivalent.
- Execute the typecheck: `tsc --noEmit` or equivalent.
- Execute unit and integration tests: `npm test` or equivalent.
- Verify 100% pass rate before opening the PR.

## Step 3: Write an Unslopped PR Summary
Structure the pull request description with clarity:
1. **Summary:** 2-3 short declarative sentences stating what changed and why.
2. **Consumer Impact:** What changes for end users or calling systems.
3. **Maintainer Impact:** What the next engineer inherits.
4. **Verification Evidence:** The exact commands executed and output proving correctness (`principles/prove-it-works.md`).
5. **Principles Applied:** Key architectural principles that guided the decisions.
