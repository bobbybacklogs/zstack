# Playbook: Evaluation & Benchmarking

> **Trigger:** Evaluating model quality, prompt changes, classification accuracy, or agent regression suites.

Measure agent capabilities with reproducible datasets and deterministic scoring rubrics.

---

## Step 1: Curate the Golden Benchmark Dataset
- Assemble representative, hardened evaluation cases with known expected outputs.
- Store cases in a versioned fixture directory (e.g. `tests/fixtures/eval/`).

## Step 2: Define the Scoring Rubric
- Avoid subjective grading. Use deterministic criteria: exact string/JSON schema match, compile checks, execution exit codes, or AST assertions.
- When LLM-as-a-judge is necessary, use multi-model consensus across OpenCode Zen families (`claude-sonnet-4-6` and `gpt-5.5`).

## Step 3: Run Baseline and Candidate Sweeps
- Execute the eval runner across all cases.
- Record pass rate, total token spend, and latency per case via ModelHitch analytics.

## Step 4: Compare Deltas
- Produce a comparative matrix showing regressions, fixes, and net improvement.
- Require positive net delta with zero regressions on critical security or correctness cases.
