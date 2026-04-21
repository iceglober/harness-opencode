# Plan with plan-state fence OUTSIDE the Acceptance criteria section

## Goal
The fence is in the wrong section — should be ignored.

```plan-state
- [ ] id: wrong-place
  intent: ignored
  tests:
    - no.sh::"no"
  verify: no
```

## Acceptance criteria
- [ ] Legacy-style criterion without a fence.
