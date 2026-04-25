# Rule 6 — Milestones (optional)

**Use milestones to attach extra verify when a logical batch finishes.**

Milestones are an optional grouping. They serve two purposes:

1. **Status output** — `pilot status` groups tasks by milestone. Easier to read for big plans.
2. **Milestone-level verify** — extra verify commands that run when the LAST task in the milestone completes.

If neither of those is useful, don't add milestones. Plain task lists are simpler.

## Schema

```yaml
milestones:
  - name: M1
    description: Foundation
    verify:
      - bun run integration-test:foundation
  - name: M2
    description: API layer
    verify:
      - bun run integration-test:api

tasks:
  - id: T1
    title: schema
    milestone: M1
  - id: T2
    title: db
    milestone: M1
  - id: T3
    title: endpoint
    milestone: M2
```

Each task has an optional `milestone:` label. The label must match a `milestones[].name` (the validator catches typos).

## When milestone verify fires

Milestone-level verify runs **after the last task in that milestone completes successfully**. "Last" = last in topological order among tasks with that label. If any task in the milestone fails or gets blocked, the milestone verify does NOT run (the cascade-fail will block downstream work anyway).

## When to use them

- **Multi-layer features** where you want an integration test after each layer (schema, API, UI).
- **Long plans** (8+ tasks) where the user wants visible progress markers.
- **Mixed-domain plans** where milestones group related work for status readability.

## When NOT to use them

- Simple plans (≤5 tasks). Just list the tasks; status output is fine without grouping.
- Plans where every "milestone" has only one task. Use task verify instead.
- Plans where the milestone verify is "the same as the last task's verify". Redundant.

## Don't conflate milestone with dep

Milestones are a presentation/verify-grouping concept; they do NOT change scheduling. If T3 needs T2 done before it can start, that's a `depends_on: [T2]`, not a `milestone:` label. The DAG and milestones are independent axes.
