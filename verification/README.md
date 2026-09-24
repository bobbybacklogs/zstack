# Verification Infrastructure

> **Rule:** Prove it works against the real artifact, not a proxy or self-report.

In `zstack`, verification is not an afterthought; it is the core lever that enables fearless parallelism and autonomous execution.

---

## 1. The Project-Local Verification CLI

Every repository adopting `zstack` should maintain a lightweight, local verification tool or script (e.g. `bin/verify`, `npm run verify`, or `scripts/verify.ts`).

### Core Responsibilities of a Verification CLI:
1. **Drive the Real Application:** Seed test state, boot local server/containers, and execute end-to-end paths.
2. **Handle Test Authentication:** Generate or mock ephemeral auth credentials without exposing production secrets.
3. **Emit Structured Evidence:** Output machine-readable JSON matching `evidence-schema.json` so agents can parse pass/fail state deterministically.

---

## 2. Feature Maps

A **Feature Map** (`feature-map.md`) is a living catalog of all capabilities, routes, invariants, and corresponding verification commands for the repository.

See [`feature-map.template.md`](./feature-map.template.md) for the standard template.
