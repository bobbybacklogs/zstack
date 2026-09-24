# Playbook: Pause Safely

> **Trigger:** Ending an agent turn, pausing work for human review, or stepping away mid-task.

Leave the workspace in an auditable, easily resumable state with zero ambiguous loose ends.

---

## Step 1: Check Working Tree Status
- Run `git status` to identify all modified, untracked, or staged files.
- Commit clean progress or ensure uncommitted changes are cleanly stashed or documented.

## Step 2: Record Current Verification State
- Note whether tests are currently passing, failing, or partially verified.
- Never claim work is complete when stepping away from a broken test run.

## Step 3: Write the Resume Handoff
Record a concise handoff note specifying:
1. **Current Milestone:** Exactly what was completed and verified this turn.
2. **Next Action:** The single immediate next step the next agent or human should execute.
3. **Pending Blockers:** Any open question or prerequisite requiring human input.
