# Valid fenced plan

## Goal
Demonstrate a plan with a correct three-field fence.

## Acceptance criteria

```plan-state
- [ ] id: v1
  intent: When foo does X, bar returns Y.
  tests:
    - test/valid.sh::"v1 passes"
  verify: bash test/valid.sh

- [x] id: v2
  intent: When baz does Q, qux returns R.
  tests:
    - test/valid.sh::"v2 passes"
  verify: bash test/valid.sh
```

## File-level changes

### test/valid.sh
- Change: new.
- Why: covers v1 and v2.
- Risk: none.
