# Rule 5 — DAG shape

**Tasks depend on each other only when there's a real semantic dependency.**

The `depends_on` edges in the plan determine run order. False edges serialize work that could parallelize (v0.3); missing edges let a downstream task run against a state where its prerequisite hasn't committed yet.

## What a real dependency looks like

- **Reads code that the dep produces.** T2 imports a function T1 introduced.
- **Reads schema that the dep modifies.** T2 calls an endpoint T1 added.
- **Tests behavior the dep implements.** T2's verify runs a test T1's code makes pass.

## What ISN'T a real dependency

- "T1 should run first because it's foundational." If T2 doesn't use T1's output, the order doesn't matter for correctness — and forcing it costs you parallelism.
- "Both touch `src/api/`." Touch overlap is a worktree-pool concern (v0.3), not a logical dependency. Capture it via `touches:` if at all.
- "I want T1 to be done before I review T2." That's a human-review concern, not a pilot DAG concern. The pilot run completes; you review afterward.

## Common shapes

**Linear** — T1 → T2 → T3:

Each task is the next layer. Use when each layer literally builds on the previous.

**Diamond** — T1 fans out to T2, T3; both reconverge into T4:

T1 = "introduce module skeleton"; T2, T3 = "fill in submodule X / Y" (parallelizable on disjoint scopes); T4 = "wire up everything and run integration tests".

**Disconnected** — Two independent components in the same plan:

`auth-1`, `auth-2` are one chain; `billing-1`, `billing-2` are another. Use when the plan covers multiple unrelated improvements.

**Hub-and-spoke** — Many tasks all depend on T1 but not on each other:

T1 = "add the typed client"; T2-Tn each = "use the typed client in module M". All Tn parallelize.

## Cycle detection

The validator catches cycles. If you accidentally write `T1 → T2 → T1`, validate will tell you. Most cycles arise from copy-paste in `depends_on` lists; check yours before saving.

## Self-loops

`T1: depends_on: [T1]` is a self-loop, also caught by validate. Always a typo.

## "I want everything serial"

Sometimes the right answer IS a fully linear DAG (e.g., a refactor where each step's diff would conflict with the next). Don't be afraid to chain everything if that's the truth — but don't pretend it's the truth when it isn't.
