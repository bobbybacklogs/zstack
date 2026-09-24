# Playbook: Authoring a Skill

> **Trigger:** Distilling a successful multi-step workflow into a reusable agent skill or slash command.

Package engineering SOPs into durable, composable skills that future agents can invoke automatically.

---

## Step 1: Identify the Trigger & Value
- When should this skill activate?
- What problem does it prevent, or what manual multi-step procedure does it automate?

## Step 2: Structure the Skill Document
Every skill requires:
1. **YAML Frontmatter:** `name` and clear `description` explaining the exact trigger conditions.
2. **Non-Negotiables:** Essential rules that cannot be bypassed.
3. **Step-by-Step Procedure:** Actionable, verifiable sequence of steps.
4. **Verification Gate:** How to verify the skill achieved its goal.

## Step 3: Test with Real Agent Runs
- Execute a task under the new skill.
- Check whether the agent followed the steps without hallucinating extra commands or dropping constraints.
- Refine the wording to eliminate ambiguity.
