# Feature Map Template

Use this template in your project root as `feature-map.md` to catalog features and their verification commands.

---

## Subsystem: [Subsystem Name]

### Feature: [Feature Name]
- **Description:** [What the feature does and who uses it]
- **Key Files:**
  - Contract: `src/types/[feature].ts`
  - Implementation: `src/services/[feature].ts`
  - Integration: `src/api/[feature].ts`
- **Invariants:**
  1. [Invariant 1, e.g. "Tokens expire after 3600 seconds"]
  2. [Invariant 2, e.g. "Concurrent refresh requests deduplicate to a single upstream call"]
- **Verification Command:**
  ```bash
  npm run verify:feature -- [feature-name]
  ```
- **Expected Artifact:** [e.g. "HTTP 200 with JSON payload containing token and expiration timestamp"]
