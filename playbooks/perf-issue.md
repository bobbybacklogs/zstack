# Playbook: Performance Issue

> **Trigger:** Diagnosing slow queries, high latency, memory bloat, or throughput degradation.

Hillclimb performance with empirical profiling rather than speculative optimizations.

---

## Step 1: Establish a Baseline Metric
- Never optimize without a benchmark. Measure current latency (p50, p95, p99), memory footprint, or operations per second.
- Capture the baseline measurement in structured numbers.

## Step 2: Profile to Find the Dominant Bottleneck
- Use a profiler or trace logs to locate where 80%+ of time or memory is consumed.
- Common culprits: redundant serialization/deserialization, synchronous I/O in loops, missing database indexes, unbatched API calls.

## Step 3: Apply Targeted Optimization
- Optimize only the verified bottleneck.
- Keep the change minimal and focused (`principles/laziness-protocol.md`).

## Step 4: Measure the Delta
- Re-run the exact benchmark under the same conditions.
- Prove the performance improvement with before-and-after numbers (`principles/prove-it-works.md`).
- Ensure no correctness or memory leak regressions were introduced.
