# Task context

Every non-trivial task in a pilot plan carries a `context:` field — a markdown block that preloads the builder agent with the narrative it needs to work confidently without re-discovering the problem from scratch.

The builder gets a fresh opencode session per task. No carry-over from the planning conversation. No memory of which files the planner inspected. Just: title, touches, verify, context (if present), and the prompt directive. If `context:` is empty, the builder starts from the directive alone — fine for a one-line task ("add a CHANGELOG entry for version 1.2.3"), but painful for anything else.

## What belongs in context

- **The user-facing outcome.** In one sentence, what changes from a user's perspective when this task lands? Why should anyone care it got done?
- **The rationale / why this task exists.** What problem is this task solving? Why is it broken out as a separate task rather than rolled into a sibling? The planner had reasons; write them down.
- **Code pointers.** The specific files / functions / types the builder should read BEFORE editing. Name them with paths the builder can `read` directly. E.g., "Start by reading `src/pilot/cli/build.ts:resolvePlanPath` (lines 350-370) — the three-step fallback lives there." Saves 3-10 minutes of the builder re-grepping the repo.
- **Acceptance shorthand.** What "done" looks like from the human's view — a sentence or two that complements the machine-checkable `verify:` list. Verify says "tests pass"; context says "the user can now type `pilot build plan-name` without the full path."
- **Gotchas / constraints.** Anything the builder would trip over that `prompt:` shouldn't carry as a directive. "The schema is `.strict()` — don't add unknown keys." "Downstream tools parse stdout; keep streaming logs on stderr."

## What does NOT belong in context

- **The directive itself.** "Add a function that …" is `prompt:` territory. Keep context for grounding, prompt for the imperative.
- **Implementation plans.** Don't pre-decide how the builder should write the code. `touches:` constrains the scope; the builder picks the structure within it. If you find yourself writing "first add X, then update Y, then rename Z," either the task is too big (split it) or you're over-specifying (trust the builder).
- **Copy-pasted architecture diagrams.** If it's longer than ~40 lines, it probably belongs in a doc file the builder can read via `touches`, not inline in the plan.
- **Tutorials.** The builder already knows how to write TypeScript / run tests / use `edit`. Don't explain the fundamentals; link to the specific non-obvious convention in the repo (AGENTS.md, CLAUDE.md).

## Length guidance

- **Trivial task** (one-line prompt, ≤1 file, ≤10 LOC): `context:` optional; omit is fine.
- **Standard task** (3-5 files, non-trivial logic): one paragraph minimum, 3-5 sentences covering outcome, rationale, and the 2-3 most relevant code pointers.
- **Complex task** (many files, architectural change): several paragraphs, organized under headers (`### Outcome`, `### Rationale`, `### Code pointers`, `### Acceptance`). If you're writing more than ~60 lines of context, reconsider: is this really one task, or should it be split?

## Relationship to other fields

- **`prompt:`** is the directive. It says "do X." Keep it crisp — one to three short paragraphs max. If you're tempted to put narrative in `prompt:`, move it to `context:`.
- **`verify:`** is the machine contract. Binary, scripted, precise.
- **`touches:`** is the scope ceiling. Lists every file the builder is allowed to edit.
- **`context:`** is the human narrative. Read by the builder once at kickoff; helps the builder understand WHICH files inside `touches:` to read first and WHAT the end user will perceive.

The four work together: `context:` orients, `touches:` bounds, `prompt:` directs, `verify:` confirms.

## Emission

The kickoff prompt sent to the builder renders `context:` as a `## Context` section between the scope/verify block and the final `## Task` directive. Reading order: hard rules → allowed scope → verify commands → **context (grounding)** → task (act). The builder reads context right before the directive so the directive is the last, most salient framing when it starts making edits.

Empty `context:` → no `## Context` section emitted. No penalty for omission on trivial tasks.

## Anti-pattern: copying the user's original request

Don't just paste the Linear ticket description or the user's chat message into `context:`. That defeats the point of planning — you're supposed to have DIGESTED the request into task-shaped outcomes, not forwarded it verbatim. If the context reads like the ticket, the planning didn't do its job.

Good context is specific to *this task*, referencing *this task's* files, *this task's* verify commands, *this task's* narrow success criterion. Plan-wide or epic-wide context belongs at the plan level (the top-of-file `name:` and `branch_prefix:`), not duplicated into every task.
