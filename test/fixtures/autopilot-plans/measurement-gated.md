# Tighten EDI retry policy (GEN-1201)

## Goal

Reduce transient-failure retry churn on the EDI outbound path. Single-branch, single-service change.

## Acceptance criteria

- [ ] Exponential backoff configured in `retry.ts`.
- [ ] Max attempts raised from 3 to 5.
- [ ] Success rate reaches 65% over a 7-day production window.

## File-level changes

### src/edi/retry.ts
- Change: tune backoff coefficients.
- Why: current linear retry amplifies downstream pressure.
- Risk: medium
