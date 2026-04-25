# Rule 3 — Verify-command design

**Each task's `verify:` commands must succeed iff the task is correctly done.**

The verify list is the contract between the planner and the builder. It is the ONLY signal pilot uses to decide "did this task work?". A weak verify means you're shipping work the run thinks is fine but really isn't.

## What a good verify looks like

- `bun test test/api.test.ts` (assertion)
- `bun run typecheck` (semantic check, catches real failures)
- `bun run lint` (style, but only when style is the work)
- `node scripts/check-schema.ts` (your own probe — write it as part of the task)
- `curl -fsS http://localhost:3000/health | jq .ok` (integration probe)

## What's not OK

- `echo done` — proves nothing
- `test -f src/foo.ts` — file existence is necessary but rarely sufficient
- `bun run build` ALONE — build success without tests means "TypeScript was happy"; insufficient for behavior tasks
- `grep -q 'newFunction' src/file.ts` — proves text presence, not behavior
- `git diff --name-only | grep src/api` — proves edits happened, not that they're correct

## Two-tier verify

Use BOTH a per-task verify and `defaults.verify_after_each`:

```yaml
defaults:
  verify_after_each:
    - bun run typecheck     # always must pass
tasks:
  - id: T1
    verify:
      - bun test test/api/specific.test.ts   # task-specific
```

`verify_after_each` catches global breakage (a syntax error in a file the task didn't even touch); per-task verify catches task-specific behavior.

## Touches and verify must agree

If the task `touches: src/api/**` but the verify command runs `bun test test/web/`, you almost certainly have a wrong scope. The verify that would actually catch task failure must exercise files in the touched scope.

## Verify must be deterministic

- No `sleep` to wait for a service that may not start in CI.
- No `docker run` unless the task is explicitly about containers.
- No external network calls that could flake — mock or skip.

If a verify command flakes, three retries will exhaust attempts and the task fails for environmental reasons. Pilot has no way to distinguish "real failure" from "flake".

## Always include a "before" check

For non-trivial tasks, write a verify that would HAVE FAILED before the task ran. This makes the task's value observable. If the verify passed before AND passes after, the task didn't actually move the system.
