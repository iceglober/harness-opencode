# Rule 4 — `touches:` scope tightness

**Globs must be the tightest set that lets the task succeed. `**` is a smell.**

The `touches:` list is the agent's leash. After verify passes, the worker computes `git diff --name-only` against the worktree's pre-task SHA; any path NOT matched by `touches:` is a violation and the task fails.

This catches:

- Agents that "helpfully" reformat unrelated files.
- Agents that modify a test in a far-away module to make verify pass.
- Agents that drift into copilot-style imports of unrelated utils.

Tight scopes also let v0.3's parallel scheduler safely run two tasks at once — if their touches don't intersect, they can't conflict.

## Heuristics

- **One module = one glob.** `src/api/**` and `test/api/**` for an API task. Not `src/**`.
- **Exact files when you know them.** `src/auth/login.ts` is better than `src/auth/**` if the task is just "edit login.ts".
- **Test files belong with their source files.** A task that adds source code almost always adds or edits a test. Both go in `touches:`.
- **Lock files: rarely.** `package.json` / `bun.lock` / `Cargo.lock` should appear ONLY when the task explicitly says "add a dependency". Don't include them speculatively.
- **Config files: rarely.** `tsconfig.json`, `.eslintrc`, `package.json` scripts — only if the task is about config.

## When `**` IS reasonable

- The task is a global rename / rewrite (across the whole repo).
- The task is "fix every TODO in the codebase" — touches everything by intent.
- The task explicitly says "this is a sweeping change".

In these cases, `**` is fine; the AGENT'S diligence becomes the constraint instead of the touches enforcement.

## What `touches: []` means

An empty `touches` list means the task **must NOT edit any files**. Use this for:

- Verify-only tasks (e.g., "confirm the existing tests still pass after a deps update was made by an upstream task").
- Probing tasks (e.g., "run benchmarks and report results" — though pilot doesn't yet have a "report results" mechanism, so this is rare).

If the verify commands would FAIL without edits, an empty `touches` is a STOP — the task is contradictory.

## Common mistakes

- **`touches: ["**/*.ts"]`** — too loose. Better: list the actual modules.
- **Forgetting tests.** Source-only `touches:` makes the task fail when the agent (correctly) edits the test file.
- **Forgetting docs.** If the task explicitly says "update README", README must be in `touches:`.
- **Including the migrations dir for a non-migration task.** Tight scope.

When in doubt, write the tightest possible scope first. If the task fails verify with "touches violation: src/X.ts", the worker shows you which file got touched — broaden then.
