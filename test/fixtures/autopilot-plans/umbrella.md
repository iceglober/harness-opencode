# EDI success rate to 70%

## Goal

Raise the end-to-end EDI transmission success rate from the current ~50% to ≥ 70% within one quarter. This is a roadmap spanning multiple Linear tickets and several service boundaries.

## Chunks

### Chunk A — retry policy (GEN-1201)
Tighten retry windows on transient failures.

### Chunk B — dead-letter routing (GEN-1202)
Stand up a dead-letter queue for non-retryable errors.

### Chunk C — observability (GEN-1203)
Add per-partner success-rate dashboards.

## Acceptance criteria

- [ ] GEN-1201 retry policy shipped
- [ ] GEN-1202 dead-letter queue deployed
- [ ] GEN-1203 dashboards live
- [ ] Overall success rate ≥ 70% over a 7-day production window

## Notes

This is an umbrella plan. Each chunk should spawn its own unit plan and branch.
