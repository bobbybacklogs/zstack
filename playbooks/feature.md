# Playbook: New Feature

> **Trigger:** Implementing new user-facing functionality, API routes, or a new subsystem.

Follow this standard procedure to ensure features are robust, well-typed, and verifiable from day one.

---

## Step 1: Clarify the Consumer & Maintainer Value
Before writing code, define:
1. **Who is the consumer?** (An end user, another engineer calling this module, or an external API client).
2. **What observable capability changes for them?**
3. **What does the next maintainer inherit?**

## Step 2: Define Data Shapes & Boundaries
- Name the core data types in TypeScript or schema definitions (`principles/foundational-thinking.md`).
- Define boundary validation schemas (e.g. Zod, TypeBox) for all external inputs (`principles/boundary-discipline.md`).
- Make illegal states unrepresentable with tagged unions (`principles/type-system-discipline.md`).

## Step 3: Build the Verification Harness First
- Identify how you will prove this feature works once built (`principles/prove-it-works.md`).
- Write an automated test, integration script, or local CLI command before implementing the internals (`principles/build-the-lever.md`).

## Step 4: Implement in Small Verifiable Units
- Sequence work so each commit leaves the repository compiling and passing tests (`principles/sequence-verifiable-units.md`).
- Route coding loops to high-throughput OpenCode models (e.g., `deepseek-v4-pro` or `kimi-k2.7-code` via ModelHitch).

## Step 5: Verify Against the Real Artifact
- Execute the real feature end-to-end. Do not rely solely on unit mocks.
- Check actual HTTP responses, database records, CLI exit codes, or UI render states.

## Step 6: Review & Final Report
- Inspect your own `git diff`. Ensure no dead code or debugging statements linger (`principles/laziness-protocol.md`).
- Report the outcome in unslopped declarative prose:
  - What was added and who it benefits.
  - Which principles influenced key decisions.
  - The concrete verification command used to prove it works.
