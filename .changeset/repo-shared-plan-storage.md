---
"@glrs-dev/harness-opencode": minor
---

**Plans are now repo-shared instead of per-worktree.** Agent-written plans move from `$WORKTREE/.agent/plans/<slug>.md` to `~/.glorious/opencode/<repo-folder>/plans/<slug>.md` — visible from every worktree of the same repo, survive `/fresh`, no longer entangled with the transient worktree they happened to be drafted in.

## Why

A plan describes work against a codebase, not against a worktree. Tying plan storage to the transient worktree wasted the plan when the worktree rotated and fragmented visibility across terminal tabs. If you drafted a plan in tab A and later switched to tab B (same repo, different worktree), the plan was invisible. If tab A ran `/fresh`, the plan vanished. This change fixes both.

## What moved

- **Storage location:** `$WORKTREE/.agent/plans/<slug>.md` → `~/.glorious/opencode/<repo-folder>/plans/<slug>.md`.
- **`<repo-folder>` derivation:** `git rev-parse --git-common-dir` → `basename(dirname(...))`. Two worktrees of the same repo produce the same key, so plans are truly repo-scoped.
- **Env override:** `$GLORIOUS_PLAN_DIR` overrides the base (default `~/.glorious/opencode`), matching the existing `$GLORIOUS_COST_TRACKER_DIR` precedent. Leading `~` tilde-expands via `os.homedir()`.

## Migration

On the first invocation of `bunx @glrs-dev/harness-opencode plan-dir` inside a given worktree (which the plan agent runs at plan-write time), any existing `.agent/plans/*.md` files are automatically moved to the new location. A `.migrated` marker is written to prevent re-runs. Collisions are handled safely — identical content is deduped (source removed), differing content leaves the source in place with a stderr warning so you can resolve manually.

No manual action required for users on floating semver; next `bun update` picks up the new behavior, and the first plan-related command in each worktree completes the migration.

## Backward compatibility

Legacy `.agent/plans/<slug>.md` references in older chat transcripts continue to work. The autopilot plugin's `findPlanPath` regex matches both shapes, and the runtime reader uses `path.isAbsolute` to anchor relative paths against the worktree (legacy) or pass absolute paths through as-is (new). The prior `/autopilot` / `/ship` invocations on older references still resolve correctly.

## New CLI subcommand

```
bunx @glrs-dev/harness-opencode plan-dir
```

Prints the absolute resolved plan directory for the current working directory, creates it if missing, runs one-shot migration if needed, exits 0. Prompts now use this to resolve the repo-specific storage path at runtime:

```bash
PLAN_DIR="$(bunx @glrs-dev/harness-opencode plan-dir)"
echo "$PLAN_DIR/my-slug.md"
```

The plan agent's permission block is narrowed to allow exactly this command (`*` → deny, `bunx @glrs-dev/harness-opencode plan-dir*` → allow). Every other bash invocation from the plan agent is still denied — the "plan agent writes only plan files" invariant is preserved.

## New permission allowlist entry

`~/.glorious/opencode/**` is added to the `external_directory` allowlist so agents can read/write plans outside the worktree without OpenCode prompting on every access. User values in `opencode.json` continue to win.

## Tests

47 new tests:
- 21 for `src/plan-paths.ts` helpers — `getRepoFolder` (canonical / worktree / non-git / bare / whitespace), `getPlanDir` (default / env / tilde / create / idempotent), `migratePlans` (no-op / move / idempotent / collision-same / collision-differ / partial / non-markdown), plus 4 for the CLI subcommand.
- 9 for autopilot regex + integration — 5 regex coverage, 3 absolute-path integration (including a regression guard for the `path.isAbsolute` reader bug), plus 1 legacy-path backward-compat assertion.
- 3 for agent prompt content + the new plan-dir permission shape.
- 1 for the `external_directory` allowlist entry + its user-wins case.
- 3 for the fallback-string templates in `AUTOPILOT_VERIFICATION_PROMPT` and `AUTOPILOT_COMPLETE_MESSAGE`.
- 1 CI guard blocking future prompt regressions that would re-introduce `.agent/plans` references.

Full suite: 209/209 pass. Typecheck clean. Build clean.

## Dog-food proof

The plan describing this migration was written to the old location (`.agent/plans/plans-repo-shared-storage.md`), then migrated to the new location (`~/.glorious/opencode/glorious-opencode/plans/plans-repo-shared-storage.md`) by the CLI it defines, during final verification. The plan ate its own tail.
