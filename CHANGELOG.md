# Changelog

## 0.4.0

### Minor Changes

- [#58](https://github.com/iceglober/harness-opencode/pull/58) [`9f650b9`](https://github.com/iceglober/harness-opencode/commit/9f650b95e4300da0b09251d538cf08d99fcd1898) Thanks [@iceglober](https://github.com/iceglober)! - Cut qa-reviewer latency on typical diffs and preserve thorough review as an explicit opt-in. Four user-visible changes:

  - **qa-reviewer dropped to Sonnet + trust-recent-green.** `qa-reviewer` now runs on `anthropic/claude-sonnet-4-6` (was Opus) and trusts the orchestrator's recent green test/lint/typecheck output within the session when the diff hasn't changed since. Semantic verification and scope-creep checks are unchanged. The trust-recent-green heuristic keys on three literal phrases the orchestrator now emits in its delegation prompt: `tests passed at <timestamp>`, `lint passed at <timestamp>`, `typecheck passed at <timestamp>`. Missing any of the three → qa-reviewer re-runs that specific command itself.

  - **New `qa-thorough` subagent for high-risk cases.** Identical-shape permission block, Opus model, re-runs the full lint/test/typecheck suite unconditionally — i.e., the old qa-reviewer behavior. The orchestrator picks this variant automatically for diffs touching >10 files, >500 lines, any file marked `Risk: high` in the plan, or security/auth/crypto/billing/migration paths.

  - **Orchestrator packages session-green timestamps into the qa-reviewer delegation prompt.** This is the load-bearing signal qa-reviewer's trust-recent-green heuristic keys on — without it, qa-reviewer re-runs everything. The orchestrator also now picks between fast and thorough variants deterministically via a documented heuristic in Phase 4 "Verify".

  - **Orchestrator hard rule: log confirmed pre-existing failures to the plan's `## Open questions` section** via the `edit` tool before proceeding. Bullet format: `- Pre-existing failure confirmed in <file>::<test-name> — not introduced by this change. Recommend separate cleanup.` Prevents the finding from dying with the session and the next qa run re-investigating the same failure.

  Plus strengthened scope-creep rules on BOTH qa variants: `git status` untracked files not in the plan must be verified via `git log --oneline -- <file>` (orchestrator's verbal "pre-existing" claim is not accepted), and modified files not in the plan's `## File-level changes` are AUTO-FAIL regardless of how "implicit" the coverage is.

  13 new tests in `test/agents.test.ts` lock the load-bearing phrases on both sides of the contract (qa-reviewer, qa-thorough, orchestrator) so the two prompts cannot drift apart without test failure.

## 0.3.0

### Minor Changes

- [#52](https://github.com/iceglober/harness-opencode/pull/52) [`62fbbda`](https://github.com/iceglober/harness-opencode/commit/62fbbda1f767b41ef97c926f7d6dc43c0502025f) Thanks [@iceglober](https://github.com/iceglober)! - Harden the autopilot loop against the class of bug where it pressures the orchestrator into user-defying behavior. Introduces the **continuation-guard**: a per-session terminal-exit latch (`exited_reason`) fronted by a single short-circuit at the top of the idle handler, with five independent detectors that can fire it.

  **The five detectors:**

  - **shipped-probe** — `git merge-base --is-ancestor HEAD origin/main` then `gh pr list --head <branch> --state merged`. Detects when the underlying work has already landed via a different branch / merged PR. Cached 60 s per session; 2 s `AbortController` timeout per subprocess; ENOENT / timeout / invalid JSON collapse to `"unknown"`. Originally motivated by a session where the loop kept firing "Plan has 22 unchecked acceptance criteria" nudges _after_ the work shipped, pressuring the orchestrator into ticking checkboxes on a stale local file to silence the plugin.
  - **user-stop** — `chat.message` handler scans the latest user message for explicit stop signals: uppercase bare `STOP` / `HALT`, plus case-insensitive phrases `stop autopilot` / `kill autopilot` / `disable autopilot` / `exit autopilot`. User-stop always wins.
  - **orchestrator-EXIT sentinel** — `<autopilot>EXIT</autopilot>` on its own line, emitted by the orchestrator when it recognizes the loop is wrong. Cooperative self-cancel. Detected by `AUTOPILOT_EXIT_RE`; wins over `<promise>DONE</promise>` when both appear.
  - **max-iterations** — 20-iteration budget. Funneled through the same exit latch so subsequent idles don't silently re-enter the legacy nudge branch at iteration 0 (a subtle re-entry bug in the prior implementation).
  - **stagnation** — snapshots the substrate (`git rev-parse HEAD` ⊕ `git status --porcelain`) on each idle. If the substrate hash is unchanged across 5 consecutive nudges, exits with `"stagnation"`. Catches the failure mode that shipped-probe misses (loop firing but nothing landing on disk) and that plan-checkbox-counting misses (boxes ticked without code changing). Snapshot failure (no git, not a repo, timeout) resets the counter rather than accumulating false stagnation evidence.

  The `/autopilot` slash-command prompt gains **Rule 9 — Autopilot exit**, teaching the orchestrator to emit `<autopilot>EXIT</autopilot>` when the loop is wrong (plan targets shipped work, user said stop, or the nudge is pressuring a scope violation) — rather than rationalizing "it's just a local gitignored file, ticking boxes is reversible" to silence the plugin.

  **Naming:** the original draft borrowed the omo marketing term "IntentGate" for this work. After researching the actual omo source (the term turns out to have no implementation behind it; omo's real hooks are `todo-continuation-enforcer` and `stop-continuation-guard`), this PR uses the indigenous **continuation-guard** vocabulary throughout — matching omo's documented `-guard` suffix convention and our codebase's existing hyphenated-plain-English style (`target-agent guard`, `fresh-transition`, `Phase 0: Bootstrap probe`).

  No migration required — the new `exited_reason`, `last_shipped_check_at`, `last_shipped_check_result`, `last_substrate_hash`, and `consecutive_stagnant_iterations` fields are optional additions to `SessionAutopilot`. Existing `.agent/autopilot-state.json` files continue to work unchanged. `/fresh` re-keys clear all five fields so a new task starts from a clean slate even after a terminal exit.

### Patch Changes

- [#55](https://github.com/iceglober/harness-opencode/pull/55) [`c518169`](https://github.com/iceglober/harness-opencode/commit/c518169aa9b4a7b26fdaebbcb3c7567fc589eaa3) Thanks [@iceglober](https://github.com/iceglober)! - Close a self-activation loophole in autopilot mode. The orchestrator was occasionally emitting `<promise>DONE</promise>` and delegating to `@autopilot-verifier` in sessions that were NOT invoked via `/autopilot` — symptoms of the orchestrator self-diagnosing into autopilot mode from ambient text (descriptive references to `/autopilot` or `AUTOPILOT mode` in prompt files, plan files, PR descriptions, etc.).

  Two-layer fix:

  - **Orchestrator prompt (primary)** — `src/agents/prompts/orchestrator.md` § `# Autopilot mode` rewritten. The activation clause is narrowed from "incoming message body contains the phrase" to "the session's FIRST user message was `/autopilot <args>` or contains the literal marker `AUTOPILOT mode` that the `/autopilot` command injects." An explicit non-trigger list enumerates the false-positive sources (reading prompt files, plan files, PR descriptions, session transcripts of other sessions, prior assistant messages, documents that mention the marker descriptively). A new self-check principle states: _"If you are unsure whether you are in autopilot mode, you are not."_ A new hard rule at the top of `# Hard rules` forbids emitting `<promise>DONE</promise>`, `<autopilot>EXIT</autopilot>`, or delegating to `@autopilot-verifier` outside a user-invoked `/autopilot` session. The Phase 4 description gains a clarifying negation so the `[PASS]` → `<promise>DONE</promise>` + verifier delegation path is explicitly gated on autopilot mode being active.

  - **Plugin (defense in depth)** — `src/plugins/autopilot.ts` `detectActivation` Signal 1 is tightened to check ONLY the first user message in the session for the activation marker, rather than scanning every user message. A marker appearing in a later user message is treated as either quoted context, a subsequent turn in an already-activated session (handled by the monotonic `enabled` flag), or a prompt-injection attempt — none of which should retroactively activate a non-`/autopilot`-initiated session. Signal 2 (fresh-handoff transition via `/plan-loop`) is unchanged; it's independent of user-message content.

  No migration required — the `/autopilot` slash command always lands in the first user message, so legitimate autopilot sessions are unaffected. Sessions that were wrongly self-activating now proceed through the normal five-phase workflow without firing completion-promise + verifier rituals. 6 new tests lock in the tightened gate (`test/autopilot-plugin.test.js`, 110 total tests now pass).

- [#56](https://github.com/iceglober/harness-opencode/pull/56) [`05c1feb`](https://github.com/iceglober/harness-opencode/commit/05c1feba0501e2d04911a3c93cf2148ecc391d1b) Thanks [@iceglober](https://github.com/iceglober)! - Fix two P0 bugs in `/fresh` reported in [#54](https://github.com/iceglober/harness-opencode/issues/54):

  - **Rendered prompt coherence.** OpenCode substitutes `$ARGUMENTS` into slash-command prompts wherever the token appears. Our prompts embedded it multiple times as self-reference ("Parse `$ARGUMENTS`", "If `$ARGUMENTS` is empty"), which turned long inputs (URLs, full sentences) into gibberish in the rendered prompt body. Rewrote `fresh.md`, `ship.md`, `autopilot.md`, `review.md`, and `costs.md` to substitute `$ARGUMENTS` exactly once at the top of each file and use semantic referents ("the user's input", "the plan path") everywhere else. Matches the pattern already used in `research.md` and `init-deep.md`. New CI test (`test/prompts-no-dangling-paths.test.ts`) enforces `$ARGUMENTS` occurs at most once per command prompt.
  - **`/fresh` unblocked under default permissions.** Orchestrator permissions now `allow` `git clean *` and `git reset --hard*` (previously `deny` and `ask`). `/fresh`'s destructive-reset step couldn't complete because `git clean` was hard-denied; and `git reset --hard` double-confirmed on top of `/fresh`'s own `question`-tool gate. Both permission-layer prompts were redundant noise for an orchestrator-scoped invocation. Global bash permissions (for user-typed commands) and build-agent permissions are unchanged — the relaxation is orchestrator-scoped.

- [#57](https://github.com/iceglober/harness-opencode/pull/57) [`e5ffb7c`](https://github.com/iceglober/harness-opencode/commit/e5ffb7ccea3be3a089948009c5a8ab0511cd1acc) Thanks [@iceglober](https://github.com/iceglober)! - Fix two permission-layer bugs that caused friction during subagent-delegated work (notably `/qa` runs hitting prompts on `git log`, `git merge-base`, `git diff --name-only`, `git branch --show-current`, and `/tmp/*`):

  - **Subagent permissions are now actually wired up.** The nested `permission:` YAML blocks declared in subagent prompt frontmatter (`src/agents/prompts/*.md`) were silently dropped by the flat frontmatter parser, and `agentFromPrompt` never read them. Subagents including `qa-reviewer`, `autopilot-verifier`, `plan-reviewer`, `gap-analyzer`, `code-searcher`, `architecture-advisor`, `lib-reader`, and `agents-md-writer` ran with no declared permissions, falling back to session defaults that prompt on read-only git operations. Fix: per-subagent permission constants (`QA_REVIEWER_PERMISSIONS`, `AUTOPILOT_VERIFIER_PERMISSIONS`, etc.) now live in `src/agents/index.ts` and are passed via the existing `overrides` arg on `agentFromPrompt()` — the same mechanism primary agents use. The dead `permission:` blocks have been stripped from the `.md` files so there's one source of truth.

  - **Scratch and XDG directories no longer prompt by default.** Added six paths to the plugin's `external_directory` defaults: `/tmp/**`, `/private/tmp/**` (macOS `/tmp` symlink target), `/var/folders/**/T/**` (macOS `$TMPDIR` expansion), `~/.config/opencode/**` (OpenCode's own config dir — agents read it to inspect current config), `~/.cache/**` (XDG cache; npm/pip/bun write here), and `~/.local/share/**` (XDG data; Linear MCP cache, etc.). Agents read these paths routinely with no security upside to prompting (the user already has access). User values in `opencode.json` still win — set e.g. `"/tmp/**": "deny"` or `"~/.cache/**": "deny"` to clamp any of them back down.

  `applyConfig` is now exported from `src/index.ts` to enable direct test coverage of the merge semantics. No behavior change to the `config` hook path. 9 new tests (`test/agents.test.ts` + new `test/external-directory.test.ts`) lock in the permission shape, regression-test read-only git commands in qa-reviewer, and verify user-wins precedence on `external_directory`.

- [#51](https://github.com/iceglober/harness-opencode/pull/51) [`9c5a152`](https://github.com/iceglober/harness-opencode/commit/9c5a1522cf6db842e8b3ce00b5535266b1479c06) Thanks [@iceglober](https://github.com/iceglober)! - `/ship` now executes end-to-end without firing OS-notification approval prompts at commit, squash, push, or PR creation. Only the declared Stop conditions (non-fast-forward push, pre-commit/pre-push hook failure, unknown working-tree shape, unstaged changes unrelated to the plan) still surface a `question` prompt.

  Root cause was a contradiction in the orchestrator prompt, which had a carve-out stating `/ship`'s per-step prompts were "legitimate and stay" — directly overriding ship.md's "no confirmation prompts, just do it" instruction. The carve-out and a related commit-message-review bullet are rewritten to match ship.md's actual contract. ship.md's top-of-file rule also now explicitly suspends the global "YOU MUST use the `question` tool" orchestrator rule for the duration of the command.

  Closes [#21](https://github.com/iceglober/harness-opencode/issues/21).

## 0.2.0

### Minor Changes

- [#44](https://github.com/iceglober/harness-opencode/pull/44) [`950d638`](https://github.com/iceglober/harness-opencode/commit/950d6380958459c5565f4dbbd9b65524db39e4ea) Thanks [@iceglober](https://github.com/iceglober)! - **BREAKING (hook authors only):** `/fresh` no longer runs its built-in reset flow when `.glorious/hooks/fresh-reset` is present and executable. The hook now OWNS the reset strategy end-to-end (discard working tree, switch branch, run project-specific cleanup). Previously the hook was an augment that ran _after_ the built-in flow. Hooks that relied on the built-in flow running first must update to do their own `git reset --hard`, `git clean -fdx`, and `git checkout -b origin/<base>` — or users can pass `--skip-hook` on a case-by-case basis to force the built-in flow. Env-var inputs (`OLD_BRANCH`, `NEW_BRANCH`, `BASE_BRANCH`, `WORKTREE_DIR`, `WORKTREE_NAME`, `FRESH_PASSTHROUGH_ARGS`), pass-through positional args, exit-code semantics, and stdout-JSON-tail-for-enrichment convention are unchanged.

  Additional changes that ride along:

  - `/fresh` hook invocation now respects the hook's shebang (previously forced `bash <path>` even for hooks with `#!/usr/bin/env python3`, `#!/usr/bin/env zsh`, etc.). This was a latent bug; non-bash hooks now run correctly.
  - `/fresh` `--skip-hook` semantics: "bypass the hook and use the built-in reset." Functionally equivalent for users who only relied on augment-mode hooks (both skip the hook; built-in runs either way). Mental-model rename, not a behavior break for that case.
  - Non-executable `.glorious/hooks/fresh-reset` (hook file present, `+x` bit unset) now emits a WARN in the `/fresh` summary and handoff brief and falls back to the built-in flow. Previously the hook was silently skipped, surprising users who `chmod -x`'d their hook as a kill-switch but got no visible feedback.
  - `/fresh` command description rewritten to reflect actual behavior (re-keys an existing worktree, does not create one, does not require `gsag`).
  - Removed dangling reference to `docs/fresh.md` in `src/commands/prompts/fresh.md` (the doc was deleted in v0.1.0 rename but the reference in the prompt survived).

### Patch Changes

- [#41](https://github.com/iceglober/harness-opencode/pull/41) [`d53c9bb`](https://github.com/iceglober/harness-opencode/commit/d53c9bbc37eacd3ce8e397d4b6c5342077ab4b2c) Thanks [@iceglober](https://github.com/iceglober)! - Automate releases with Changesets. Every PR now declares its version impact via `bunx changeset`; merges to `main` open a "Version Packages" PR that aggregates pending changesets; merging that PR auto-publishes to npm with provenance. No runtime behavior change for end users.

All notable changes to `@glrs-dev/harness-opencode` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-04-21

### Fixed

- **Plugin failed to load in production.** When tsup bundles `src/agents/shared/index.ts`, `src/agents/index.ts`, `src/commands/index.ts`, and `src/bin/plan-check.ts` into `dist/index.js`, `import.meta.url` resolves to `dist/` — not the original module's subdirectory. All `readFileSync`-based path resolution was looking for `dist/prompts/<file>` instead of `dist/agents/prompts/<file>`, causing `Could not find shared file: workflow-mechanics.md` on every session start. Agents, commands, and plan-check all failed to load; only `plan` and `build` (which come from OpenCode's built-in agents, not our plugin) were visible.
- **Migration docs used GNU-only `find -xtype l`** which fails on macOS's BSD `find`. Replaced with portable `find -type l ! -exec test -e {} \; -print -delete`.

## [0.1.1] — 2026-04-21

### Changed

- Version bump to exercise the release CI pipeline end-to-end. No functional changes from 0.1.0.

## [0.1.0] — 2026-04-21

### Added

- Initial npm release. Pivoted from the clone+symlink installer model to an npm-delivered OpenCode plugin.
- 12 agents (3 primary + 9 subagents) registered via the plugin `config` hook.
- 7 slash commands: `/ship`, `/autopilot`, `/review`, `/init-deep`, `/research`, `/fresh`, `/costs`.
- 5 custom tools: `ast_grep`, `tsc_check`, `eslint_check`, `todo_scan`, `comment_check`.
- 4 bundled skills: `review-plan`, `web-design-guidelines`, `vercel-react-best-practices`, `vercel-composition-patterns`.
- MCP server wiring for `serena`, `memory`, `git` (enabled), `playwright`, `linear` (disabled by default).
- Bundled sub-plugins: `notify` (OS notifications), `autopilot` (completion-tag loop), `cost-tracker` (LLM spend tracking).
- CLI: `bunx @glrs-dev/harness-opencode install`, `uninstall`, `doctor`, `plan-check`.

### Migration from clone+symlink install

See [MIGRATION.md](./MIGRATION.md) and [docs/migration-from-clone-install.md](./docs/migration-from-clone-install.md).
The last pre-pivot state is tagged `v0-legacy-clone-install` with the retired installer scripts attached as release assets.
