# Playbook: Investigation

> **Trigger:** Researching code architecture, diagnosing an unknown issue, or answering "how/why does X work?"

Produce an evidence-based, cited technical synthesis without modifying production source code.

---

## Step 1: Formulate Precise Questions
- State what needs to be answered (e.g. "Where is the ModelHitch bridge session state persisted?", "How are tool calls converted across wire formats?").

## Step 2: Gather Direct Evidence
- Read source files directly using line ranges (`src/server.ts#L40-L75`).
- Trace runtime flows and inspect real configuration files (`~/.modelhitch/config.json`).
- If investigating runtime behavior, execute probe commands or inspect live process state (`principles/prove-it-works.md`).

## Step 3: Synthesize Findings
- Answer with short, declarative sentences.
- Cite exact file paths and line numbers for every claim.
- Disclose any unknowns, ambiguities, or unverifiable assumptions.
