# Rule 2 — Decomposition

**Right-sized tasks: 10-30 minutes of agent time, ≤3 attempts to pass verify.**

A "right-sized" pilot task is one the pilot-builder can complete in a single session within the default `max_turns: 50` budget. Empirically, that's about 10-30 minutes of agent wall time and 1-3 attempts.

## Sizing heuristics

**Too big (split it):**

- The verify command exercises >3 distinct code paths.
- The task touches >5 files.
- The prompt has >10 numbered steps.
- The task says "and also" / "while you're at it" — a sign of conjoined work.

**Too small (merge it):**

- The task touches a single file with <30 lines added/changed.
- The verify command would also pass before the task ran.
- Splitting added a `depends_on` edge that just moves work around.

## Splitting patterns

- **Layer-by-layer**: schema → DB accessors → API → wiring. Each layer has its own tests; each is a task.
- **Read → Write**: T1 = "add a function that returns the data", T2 = "add an endpoint that calls it". T2 depends on T1.
- **Skeleton → Detail**: T1 = "introduce the module structure with stubs", T2-Tn = "fill in each stub with logic+tests". The stubs let downstream tasks parallelize.

## Anti-patterns

- **Refactor as one task.** "Refactor X" is a feature, not a task. Decompose into `extract Y`, `inline Z`, `rename W`, each with its own verify.
- **Setup-only tasks.** "Install lodash" is not a pilot task — the next task can install it as part of its own scope. Avoid tasks that don't deliver an observable check.
- **Cleanup-only tasks.** "Remove dead code". The verify is "tests still pass" — but tests passing was already the contract on the previous task. If there's nothing new to assert, this isn't a task.

## When you can't decompose

If the work genuinely doesn't decompose (e.g., a 200-line algorithm that has to land atomically), it might not be a fit for pilot. Tell the user; they may want to run it as a regular `/build` task instead.
