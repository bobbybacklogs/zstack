# Playbook: Prototype / Spike

> **Trigger:** Exploring an unproven library, settling a design dispute, or testing performance feasibility.

Build throwaway spikes to convert subjective debates into observable empirical facts.

---

## Step 1: Define the Question to Settle
- State the exact question or hypothesis in one clear sentence (e.g. "Can ModelHitch stream Anthropic messages with sub-50ms TTFT?").
- Define the observable metric or criterion that determines success.

## Step 2: Build the Minimal Throwaway Spike
- Write the smallest possible script or scratch file (`scratch/spike.ts`).
- Bypass formal architectural layers, database setups, and full type coverage. The spike is meant to explore feasibility rapidly.
- Route requests to cheap, high-speed exploration models (`deepseek-v4-flash` via ModelHitch).

## Step 3: Observe and Record Empirical Results
- Run the prototype and capture real logs, timing metrics, and error rates.
- Never settle design questions by guessing when a 30-second script can observe the truth.

## Step 4: Decide: Discard or Graduate
- If the spike failed: Record the findings, delete the scratch files, and pursue an alternative approach (`principles/exhaust-the-design-space.md`).
- If the spike succeeded: Extract the validated pattern and implement it properly under `playbooks/feature.md`. Do not copy-paste raw spike code into production without proper typing and error boundaries.
