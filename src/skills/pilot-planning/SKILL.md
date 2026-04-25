---
name: pilot-planning
description: Methodology for producing a pilot.yaml plan that the pilot-builder agent can execute unattended. Use when the pilot-planner agent receives a feature request — covers task decomposition, verify-command design, scope tightness, DAG shape, and self-review. Auto-loaded by the pilot-planner agent.
---

# Pilot Planning Skill

You are producing a `pilot.yaml` plan: a list of tasks the pilot-builder agent can execute one at a time, fully unattended. The cost of a bad plan is high — the builder will fail tasks confusingly, the cascade-fail will block downstream work, and the human pilot operator has to clean up worktrees and re-plan.

A good plan trades a planning-session's worth of patient thought for hours of unsupervised builder time. Take the patient thought.

## Workflow

Apply these seven rules in order. Each rule has its own file in `rules/` for the full text:

1. [`first-principles.md`](rules/first-principles.md) — Frame the task FROM the user's intent, not from a templated checklist. Ask "what does the user actually want done?" before "what files might change?"

2. [`decomposition.md`](rules/decomposition.md) — Break the work into right-sized tasks (10-30 minutes of agent time, ≤3 attempts). Too big = unbounded work; too small = orchestration overhead drowns the value.

3. [`verify-design.md`](rules/verify-design.md) — Each task's `verify:` commands must succeed iff the task is correctly done. No `echo done`. No `test -f file.ts`. Real assertions only.

4. [`touches-scope.md`](rules/touches-scope.md) — `touches:` globs must be the tightest set that lets the task succeed. Default to "specific file paths"; `**` is a smell.

5. [`dag-shape.md`](rules/dag-shape.md) — Tasks depend on each other only when there's a real semantic dependency (B reads what A produces). False dependencies make the run sequential when it could parallel; missing dependencies cause subtle race-on-state bugs.

6. [`milestones.md`](rules/milestones.md) — Optional grouping. Use when several tasks share a "is this batch done?" check (e.g. integration tests after a chunk of unit-test work).

7. [`self-review.md`](rules/self-review.md) — Before declaring the plan ready, run through a 7-question checklist. Find the holes yourself; the validator only catches schema errors.

## After applying the rules

1. Save the YAML to the path returned by `bunx @glrs-dev/harness-opencode pilot plan-dir`.
2. Run `bunx @glrs-dev/harness-opencode pilot validate <path>` and fix every error / warning.
3. Hand off to the user with: `Plan saved to <path>. Next: bunx @glrs-dev/harness-opencode pilot build`.

Do NOT summarize the plan in chat. The user can read the YAML.

## When to refuse

If, after applying the methodology, you cannot produce a plan with at least:

- 2 tasks
- Each with non-trivial verify
- Each with tight `touches`
- A coherent DAG

…tell the user the work isn't ready for pilot. Suggest they break it down themselves first, or use the regular `/plan` agent (markdown plans, human-driven execution). It is far better to refuse than to ship a bad plan.
