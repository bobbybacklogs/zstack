# Playbook: Session Pickup

> **Trigger:** Resuming development from a previously paused session, handoff note, or existing branch.

Re-anchor context from concrete repository state rather than stale conversational memory.

---

## Step 1: Inspect Repository State Directly
- Run `git status` and `git log -n 5 --oneline` to establish the exact branch condition.
- Review recent diffs (`git diff HEAD~1`) to understand the latest code changes directly.

## Step 2: Verify Process & Infrastructure Health
- Check that local daemons and background services are running:
  - Verify ModelHitch: `curl http://127.0.0.1:3939/v1/models`
  - Verify local databases or compilers if applicable.

## Step 3: Run the Verification Baseline
- Execute the test suite or project build to verify whether the codebase is currently green before making edits.

## Step 4: Resume Execution
- Pick up the next immediate action identified in the previous handoff.
- Proceed under the appropriate task playbook (`playbooks/feature.md`, `playbooks/bug-fix.md`, etc.).
