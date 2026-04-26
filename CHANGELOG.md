# Changelog

## 0.16.0

### Minor Changes

- [#124](https://github.com/iceglober/harness-opencode/pull/124) [`fafe250`](https://github.com/iceglober/harness-opencode/commit/fafe25009a584f2110a2f6b2fd907649bbf95ed8) Thanks [@iceglober](https://github.com/iceglober)! - Pivot the installer's provider/model data source from Catwalk (`catwalk.charm.land`) to Models.dev (`models.dev/api.json`), matching what OpenCode's runtime uses to validate model IDs.

  Previously, the installer emitted provider IDs from Catwalk's registry (`bedrock/anthropic.claude-opus-4-6`, `vertexai/claude-opus-4-6@20250610`) that OpenCode's runtime rejects at agent invocation with `Agent <name>'s configured model <id> is not valid`. Models.dev uses different provider IDs (`amazon-bedrock`, `google-vertex-anthropic`) for the same providers. The AWS Bedrock and Google Vertex presets have been broken out of the box since this ID schism was introduced upstream; only the Anthropic preset happened to work because its provider ID is identical in both registries.

  The Bedrock preset now emits `amazon-bedrock/global.anthropic.claude-*` IDs (using AWS CRIS global cross-region inference for the broadest availability). The Vertex preset now emits `google-vertex-anthropic/claude-*@default` IDs. The Anthropic preset is unchanged.

  The plugin's runtime validator (`src/model-validator.ts`) now flags any model override starting with `bedrock/` or `vertex(ai)/` as invalid and suggests the Models.dev-valid replacement. If you hit `ProviderModelNotFoundError` or `Agent ... configured model ... is not valid` after a recent OpenCode upgrade, run `bunx @glrs-dev/harness-opencode doctor` — it enumerates the bad overrides and the correct Models.dev IDs.

  **Note for existing installations:** your opencode.json is never auto-rewritten. The doctor tells you the exact line to change. If you had a working `anthropic/*` or `amazon-bedrock/*` config, nothing changes. If you had a Catwalk-style `bedrock/anthropic.*` or `vertexai/claude-*@<date>` config, you will now see warnings until you update it — those configs never actually worked at runtime against current OpenCode versions.

### Patch Changes

- [#122](https://github.com/iceglober/harness-opencode/pull/122) [`d433060`](https://github.com/iceglober/harness-opencode/commit/d433060149bdde3134ce1ad07deb8ea7d0536ee5) Thanks [@iceglober](https://github.com/iceglober)! - fix(pilot): prevent `git worktree add -B` collision between runs of the same plan.

  Previously, every `pilot build` of the same plan constructed identical per-task branch names (`pilot/<slug>/<taskId>`). An aborted or failed prior run left `preserveOnFailure` worktrees alive (by design — so users can inspect), but those worktrees held the branch refs. The next `pilot build` tripped on `fatal: '<branch>' is already used by worktree at <prior-run-dir>`, failing T1 and cascade-blocking every downstream task.

  Branch names now include the runId: `pilot/<slug>/<runId>/<taskId>`. Runs of the same plan no longer share a branch namespace; preserved worktrees from prior runs stay on disk for inspection but don't block new runs.

  **Note on existing branches:** branches created by earlier pilot versions (without the runId segment) remain on disk as orphans. They won't be touched or reused by new runs. To clean up manually: `git branch --list 'pilot/*' | xargs -n1 git branch -D` (after confirming nothing valuable lives under those refs, and pruning any orphan worktrees with `git worktree prune`).

## 0.15.0

### Minor Changes

- [#121](https://github.com/iceglober/harness-opencode/pull/121) [`6089f8e`](https://github.com/iceglober/harness-opencode/commit/6089f8e1b84875aca549b2e1ce64c7beeeefcab5) Thanks [@iceglober](https://github.com/iceglober)! - Pilot UX overhaul: interactive plan picker, positional path resolution, and streaming progress.

  - **`pilot build` plan selection** now accepts a positional arg that resolves smartly: absolute path, cwd-relative, plans-dir-relative (with or without `.yaml`/`.yml` suffix). When no arg is given and stdin is a TTY, an `@inquirer/prompts` `select()` picker lists plans from the plans dir sorted by mtime (newest first), labelled with filename + plan name + relative time. `--plan <path>` still works for scripts. Non-TTY with no args falls back to "newest in plans dir" (unchanged v0.1 behavior).
  - **Streaming per-task progress** on stderr during `pilot build`. Lines like `[HH:MM:SS] task.started T1`, `task.verify.passed T1`, `task.succeeded T1 in 42s`, `run.progress 2/7 succeeded`. Suppressed by `--quiet`. Chatty kinds (`task.session.created`, `task.attempt`) stay in the DB; `pilot logs --run` surfaces them. stdout stays clean for the final summary.
  - **Task-level `context:` field** on `pilot.yaml` tasks — optional rich markdown block rendered into the builder's kickoff as a `## Context` section between verify and the task directive. Planner skill gets a new rule (`rules/task-context.md`) and pilot-planner.md tells the planner to populate it for non-trivial tasks. Cover outcome, rationale, code pointers, acceptance shorthand.
  - Exit code change: missing plan via `--plan <path>` now exits 2 (resolution surface) instead of 1 (generic error). Consistent with schema-invalid plans.

### Patch Changes

- [#115](https://github.com/iceglober/harness-opencode/pull/115) [`4d537c0`](https://github.com/iceglober/harness-opencode/commit/4d537c0184a08fdef03f6255d5922f28fb302e08) Thanks [@iceglober](https://github.com/iceglober)! - Security & OSS hygiene — PR1 of a 3-part remediation (follow-ups tracked in [#113](https://github.com/iceglober/harness-opencode/issues/113) and [#114](https://github.com/iceglober/harness-opencode/issues/114)):

  - Add `SECURITY.md` with private disclosure channel, response SLA, scope statement, and safe-harbor clause.
  - Validate Catwalk model-catalog responses with a zod schema before any value reaches `opencode.json`; malformed responses fail closed and the installer falls back to built-in presets.
  - Document the threat boundary, outbound network calls, and the explicit "agent bash deny-list is not a sandbox" limit in the README.
  - Add npm provenance verification instructions (`npm audit signatures`) to the README.
  - Declare `engines.node >= 20.10` in `package.json` and add a runtime guard at the top of the CLI binary so users on unsupported runtimes get an actionable error instead of a cryptic stack trace.
  - Include `SECURITY.md` in the published tarball.

## 0.14.0

### Minor Changes

- [#109](https://github.com/iceglober/harness-opencode/pull/109) [`10c5a82`](https://github.com/iceglober/harness-opencode/commit/10c5a8218cff54a458c5b6adf3bf8562e437f5d4) Thanks [@iceglober](https://github.com/iceglober)! - Add `agent-estimation` bundled skill. Teaches agents to estimate task effort in tool-call rounds first (with a structured module-breakdown table and risk coefficients) and convert to human wallclock only at the final step. Avoids the systematic overestimation that happens when agents anchor to human-developer timelines absorbed from training data. Adapted from https://openclawlaunch.com/skills/agent-estimation.

### Patch Changes

- [#110](https://github.com/iceglober/harness-opencode/pull/110) [`467df1d`](https://github.com/iceglober/harness-opencode/commit/467df1d4fcdecdc34830ca85b8530ea5272a9be5) Thanks [@iceglober](https://github.com/iceglober)! - Detect pre-[#100](https://github.com/iceglober/harness-opencode/issues/100) legacy model-override IDs at runtime and in `doctor`.

  Before PR [#100](https://github.com/iceglober/harness-opencode/issues/100), the installer suggested stale model IDs like `bedrock/claude-opus-4` (no `anthropic.` subpath, no minor-version digit). These IDs never resolved in OpenCode, so any user who kept their pre-[#100](https://github.com/iceglober/harness-opencode/issues/100) `options.models` block saw agents crash with `ProviderModelNotFoundError` at the first subagent invocation — most visibly on `pilot-planner` and `qa-reviewer`, whose tier overrides get stomped first.

  The plugin now runs a conservative offline pattern validator on every override it applies in `resolveHarnessModels()`. On invalid IDs it emits a single-line warn (deduped per unique bad value) naming the offending key (`models.deep`, `models.pilot-planner`, etc.) and suggesting the Catwalk-canonical replacement. The user's config is never auto-rewritten.

  `bunx @glrs-dev/harness-opencode doctor` now includes a model-overrides check: it reads both `plugin options.models` and legacy `harness.models`, prints a red-X line with the full remediation hint for each invalid entry, and a green check when everything resolves cleanly.

  Unknown or CRIS-prefixed IDs (`global.anthropic.*`, `openai/*`, etc.) stay silent — the validator flags only the specific pre-[#100](https://github.com/iceglober/harness-opencode/issues/100) legacy pattern. No behavior change to the happy path.

- [#112](https://github.com/iceglober/harness-opencode/pull/112) [`8e89895`](https://github.com/iceglober/harness-opencode/commit/8e898955ea0cb1a30c15a82983b508e35cdd4071) Thanks [@iceglober](https://github.com/iceglober)! - Make tool-output truncation per-tool-shape-aware and widen the permission allowlist to cover the plugin's own spill path.

  Before this change, every `bash`/`read`/`glob`/`grep` output over 2000 chars was truncated to a 300-char head + 200-char tail with the full text spilled to `~/.local/state/harness-opencode/tool-output/<callID>.txt` — but that spill path was not in the external_directory allowlist, so the PRIME hit a permission prompt on every recovery read. The recovery read then re-truncated, compounding. On any file >~50 lines or grep with >~15 matches, a session spent 3-5 turns ping-ponging between truncation and permission prompts.

  **Allowlist:** `~/.local/state/**` and `~/.config/crush/**` are now in the default `permission.external_directory` map (before `...existingExtDir`, so user overrides still win).

  **Truncation:** raised the base threshold from 2000 → 6000 chars (~150 lines of code) and added per-tool shapes:

  - `read`: `"skip"` — Read's own `limit`/`offset` is the single bound.
  - `glob`: `"skip"` — path lists aren't useful when middle-truncated.
  - `bash`: `"tail"` (default 4000 chars) — failures and exit codes are at the end; keeping head loses signal.
  - `grep`: `"head-with-count"` — first 20 match blocks verbatim + `"... N more matches — full output at <path>"` footer. Middle-truncation breaks match blocks.

  The bash-failure bypass (`looksLikeBashFailure`) is preserved as the first check among truncation paths. A new recovery-read bypass skips truncation entirely when Read is targeting a file under the spill dir. Users can override per-tool shape/threshold/head/tail/grepHeadMatches via `toolHooks.backpressure.perTool.<tool>` in `opencode.json`; user values always win.

## 0.13.3

### Patch Changes

- [#106](https://github.com/iceglober/harness-opencode/pull/106) [`a95bf9f`](https://github.com/iceglober/harness-opencode/commit/a95bf9f289b396e3e4067fd811acc42a98c22ba7) Thanks [@iceglober](https://github.com/iceglober)! - Stop auto-defaulting model selections in the installer. Users now pick models per tier (deep/mid/fast) from the provider's model list, with the default choice set to "Keep defaults (no model config)" so no paid models are configured without explicit user action.

## 0.13.2

### Patch Changes

- [#103](https://github.com/iceglober/harness-opencode/pull/103) [`0990a03`](https://github.com/iceglober/harness-opencode/commit/0990a0326c3b9b098aab2ce49cd7a1086af8cf55) Thanks [@iceglober](https://github.com/iceglober)! - Add "Reconfigure models?" prompt to installer when models are already configured, so users can update their provider/model selection without hand-editing opencode.json.

- [#105](https://github.com/iceglober/harness-opencode/pull/105) [`f68fa3f`](https://github.com/iceglober/harness-opencode/commit/f68fa3f6d6f301d4dfef18e55438e888a34e298d) Thanks [@iceglober](https://github.com/iceglober)! - Check for plugin updates on every OpenCode session start instead of rate-limiting to once per 24 hours. The file-based rate limit caused same-day publishes to go undetected until the next day, delaying auto-update of the plugin cache.

## 0.13.1

### Patch Changes

- [#101](https://github.com/iceglober/harness-opencode/pull/101) [`db74676`](https://github.com/iceglober/harness-opencode/commit/db746761906a725a3d70496c1b5ba0f58bd84b61) Thanks [@iceglober](https://github.com/iceglober)! - Fix agent config and installer model IDs

  - Rename remaining "orchestrator" references to "PRIME" in the PRIME agent prompt.
  - Demote pilot-builder and pilot-planner from primary to subagent mode so they no longer appear as tab-selectable agents.
  - Fix docs-maintainer model from bare "sonnet" to "anthropic/claude-sonnet-4-6".
  - Correct Bedrock and Vertex model IDs in installer presets to match Crush's Catwalk registry (e.g. bedrock/claude-opus-4 → bedrock/anthropic.claude-opus-4-6).
  - Add Catwalk API client that fetches live providers during install with graceful fallback to hardcoded presets when offline.

## 0.13.0

### Minor Changes

- [#99](https://github.com/iceglober/harness-opencode/pull/99) [`0a9e824`](https://github.com/iceglober/harness-opencode/commit/0a9e824b294c84c4ddb6d676db4e4150a1327d59) Thanks [@iceglober](https://github.com/iceglober)! - Add anonymous, opt-out usage telemetry via Aptabase. Tracks tool invocation counts, durations, file extensions, and success/failure rates — no file paths, code, prompts, or identifying information. Disabled automatically in CI and via `HARNESS_OPENCODE_TELEMETRY=0` or `DO_NOT_TRACK=1`.

### Patch Changes

- [#97](https://github.com/iceglober/harness-opencode/pull/97) [`d497c80`](https://github.com/iceglober/harness-opencode/commit/d497c80cd503fd1468301d6541ecec91bb8ecc61) Thanks [@iceglober](https://github.com/iceglober)! - Fix auto-update leaving plugin cache without node_modules. The cache refresh deleted node_modules and assumed OpenCode would reinstall on next start — it doesn't. Now runs `npm install` after rewriting the pin so the new version is immediately available.

## 0.12.1

### Patch Changes

- [#95](https://github.com/iceglober/harness-opencode/pull/95) [`238cf5c`](https://github.com/iceglober/harness-opencode/commit/238cf5cbb8fbcae12380b25351d5f4930484e6ff) Thanks [@iceglober](https://github.com/iceglober)! - Fix OpenCode startup crash caused by unrecognized `harness` top-level key in opencode.json. Move plugin config (model tiers, toolHooks) into the SDK plugin options tuple form. Auto-migrate legacy config on install. Replace readline number-input prompts with @inquirer/prompts (arrow-key select, checkbox, confirm). Fix plugin detection to handle tuple entries in install/uninstall/doctor.

## 0.12.0

### Minor Changes

- [#93](https://github.com/iceglober/harness-opencode/pull/93) [`c70f525`](https://github.com/iceglober/harness-opencode/commit/c70f5258788f8bd720b115060c052b9f009e18a5) Thanks [@iceglober](https://github.com/iceglober)! - Add tool-hooks sub-plugin with four context-saving optimizations: output backpressure (truncate successful tool output above threshold, write full to disk), post-edit verification loop (auto-run tsc after TS/JS edits), loop detection (warn after N edits to same file), and read deduplication (skip re-reads of unchanged files). Add context firewall section to orchestrator prompt mandating sub-agent delegation for high-output operations.

### Patch Changes

- [#93](https://github.com/iceglober/harness-opencode/pull/93) [`c70f525`](https://github.com/iceglober/harness-opencode/commit/c70f5258788f8bd720b115060c052b9f009e18a5) Thanks [@iceglober](https://github.com/iceglober)! - Fix OpenCode startup crash caused by unrecognized `harness` top-level key in opencode.json. Move plugin config (model tiers, toolHooks) into the SDK plugin options tuple form. Auto-migrate legacy config on install. Replace readline number-input prompts with @inquirer/prompts (arrow-key select, checkbox, confirm). Fix plugin detection to handle tuple entries in install/uninstall/doctor.

## 0.11.0

### Minor Changes

- [#88](https://github.com/iceglober/harness-opencode/pull/88) [`f79857c`](https://github.com/iceglober/harness-opencode/commit/f79857c2ccb2afac33e4c7307145f0d9d0239659) Thanks [@iceglober](https://github.com/iceglober)! - feat: interactive `install-plugin` with model provider and MCP prompts

  `glrs-oc install-plugin` now walks users through model provider selection (Anthropic direct, AWS Bedrock, Google Vertex, or keep defaults) and optional MCP toggles (Playwright, Linear). Choices are written to `opencode.json` via non-destructive merge. Non-interactive terminals skip prompts and use defaults.

  Also adds `promptChoice` and `promptMulti` helpers to `plugin-check.ts`, and updates the README with progressive disclosure (quick start → workflow examples → detailed reference).

## 0.10.1

### Patch Changes

- [#85](https://github.com/iceglober/harness-opencode/pull/85) [`a4e5709`](https://github.com/iceglober/harness-opencode/commit/a4e5709abbe24c385d788c4a9598847b2846103d) Thanks [@iceglober](https://github.com/iceglober)! - fix: change CLI shebang from `node` to `bun` to fix ERR_UNSUPPORTED_ESM_URL_SCHEME

  The CLI binary (`dist/cli.js`) used `#!/usr/bin/env node`, causing `bunx` and global installs to spawn Node.js instead of Bun. Node.js cannot resolve `bun:sqlite` imports used by the pilot subsystem, producing `ERR_UNSUPPORTED_ESM_URL_SCHEME` on every CLI invocation — including commands that don't touch SQLite (`install`, `doctor`, etc.) because ESM evaluates all static imports eagerly.

## 0.10.0

### Minor Changes

- [#83](https://github.com/iceglober/harness-opencode/pull/83) [`fb5b7c9`](https://github.com/iceglober/harness-opencode/commit/fb5b7c9f9ed27097d7617415b769a44b46a2a9c4) Thanks [@iceglober](https://github.com/iceglober)! - feat: add `glrs-oc` CLI alias for global install usage

  Adds a second `bin` entry (`glrs-oc`) alongside the existing `harness-opencode`, both pointing to `dist/cli.js`. After `bun add -g @glrs-dev/harness-opencode`, users can invoke the CLI as `glrs-oc install`, `glrs-oc doctor`, `glrs-oc pilot plan`, etc. — shorter than `bunx @glrs-dev/harness-opencode ...` and avoids the Node.js runtime mismatch that `bunx` can trigger.

  Permission maps for CORE_BASH_ALLOW_LIST, PLAN_PERMISSIONS, and PILOT_PLANNER_PERMISSIONS now also allow `glrs-oc *` variants so agents can invoke the short-name CLI.

## 0.9.0

### Minor Changes

- [#80](https://github.com/iceglober/harness-opencode/pull/80) [`6b3f9f6`](https://github.com/iceglober/harness-opencode/commit/6b3f9f69bb24abd41908f7c3c8f439d9a8c1b494) Thanks [@iceglober](https://github.com/iceglober)! - Add the pilot subsystem (v0.1+v0.2) — autonomous task execution from a YAML plan.

  **New CLI surface**: `bunx @glrs-dev/harness-opencode pilot <verb>` with verbs `validate`, `plan`, `build`, `status`, `resume`, `retry`, `logs`, `worktrees`, `cost`, and `plan-dir`. Migrated the entire CLI to `cmd-ts` for declarative argument parsing and auto-generated `--help`.

  **Two new agents** registered via `createAgents()`:

  - **`pilot-builder`** (mid tier, `claude-sonnet-4-6`): unattended task executor. Runs one task at a time inside a per-task git worktree. Permission map denies `git commit/push/tag/branch/checkout/switch/restore/reset` and `gh pr/release` so the worker — not the agent — owns commits. Also denies the `question` tool (unattended invariant). Uses the STOP protocol when blocked.

  - **`pilot-planner`** (deep tier, `claude-opus-4-7`): interactive planner. Decomposes a Linear ticket / GitHub issue / free-form description into a `pilot.yaml` task DAG. Edits restricted to the pilot plans directory by both the agent's permission map and the new `pilot-plugin` runtime hook (belt-and-suspenders).

  **One new skill** (`src/skills/pilot-planning/`): SKILL.md + 7 rules covering first-principles task framing, decomposition, verify-command design, touches-scope tightness, DAG shape, milestone grouping, and self-review.

  **One new sub-plugin** (`src/plugins/pilot-plugin.ts`): hooks `tool.execute.before` to enforce builder/planner invariants at runtime. Classifies sessions by title prefix (`pilot/<runId>/<taskId>`) and working directory; non-pilot sessions pass through unchanged.

  **Persistent state** lives under `~/.glorious/opencode/<repo>/pilot/` (NOT in `~/.config/opencode/`) — SQLite state DB, git worktrees, JSONL worker logs, YAML plan artifacts. Per-repo derivation matches `src/plan-paths.ts`.

  **Doctor** (`bunx @glrs-dev/harness-opencode doctor`) now reports git/bash availability and pilot agent registration status.

  **Tested**: 740+ tests, all green. Pre-implementation spikes documented under `docs/pilot/spikes/`.

  **Known limitations** (deferred to v0.3+):

  - Single-worker only (`--workers >1` clamps to 1 with a warning).
  - No PR creation (pilot stops at committed branches; use `/ship` separately).
  - No cost-cap preemption (cost is reporting-only).
  - No Slack notifications, no Ink TUI for `pilot status --watch`.

## 0.8.0

### Minor Changes

- [#79](https://github.com/iceglober/harness-opencode/pull/79) [`e05bfe8`](https://github.com/iceglober/harness-opencode/commit/e05bfe802a9ad5fca1d68c2954b55c547e998eaf) Thanks [@iceglober](https://github.com/iceglober)! - Add dotenv loader plugin for MCP config interpolation

  Loads `.env` and `.env.local` into `process.env` at plugin-init time so `{env:VAR}` references in MCP server config resolve project-local secrets without a shell-side `source .env` ritual. Shell exports still win (never overwritten), `.env.local` overrides `.env`, missing files silently skipped. Zero external dependencies — inline parser only.

- [#79](https://github.com/iceglober/harness-opencode/pull/79) [`e05bfe8`](https://github.com/iceglober/harness-opencode/commit/e05bfe802a9ad5fca1d68c2954b55c547e998eaf) Thanks [@iceglober](https://github.com/iceglober)! - Add `harness.models` config for tier-based and per-agent model overrides

  Introduces a `harness.models` key in `opencode.json` that lets users override which LLM model each agent uses, either by tier (`deep`, `mid`, `fast`) or per-agent name. Tier assignments cover all 12 agents; per-agent overrides win over tier. No change for users who don't set the key — all agents keep their plugin defaults.

### Patch Changes

- [#75](https://github.com/iceglober/harness-opencode/pull/75) [`01dd824`](https://github.com/iceglober/harness-opencode/commit/01dd82470f24ac542467b1624d0250fd90f12ed5) Thanks [@iceglober](https://github.com/iceglober)! - Autopilot hardening: silent circuit breakers against umbrella plans, wrong-branch work, and stuck loops

  The autopilot plugin previously nudged on every unchecked `- [ ]` in `## Acceptance criteria` regardless of plan shape. When pointed at an umbrella plan (18 Linear issues across 7+ branches, multi-week roadmap with production-measurement ACs), it would keep nudging past explicit STOP reports until the 20-iteration cap fired. The cap had a quiet bug: if the "stopped, something's stuck" nudge hit the debounce window, `stopped` stayed unset and the cap could be re-tested on the next idle.

  This adds six silent circuit breakers — no user prompts, no permission checks, matching the design rule that autopilot never asks for anything:

  - **Plan-shape classifier.** `classifyPlan()` detects **umbrella** plans (has `## Chunks`/`## Milestones`/`## Workstreams` headers, 3+ distinct Linear IDs, or > 50KB), **measurement-gated** plans (phrases like `7-day`, `post-deploy`, `SLO`, `success rate reaches`, `bake time` in the AC section), and **opt-out** plans (magic comment `<!-- autopilot: skip -->`). Non-unit plans stop the session silently with a shape-specific reason.
  - **Branch/plan alignment.** Extracts the first Linear ID from the plan's `## Goal` and compares (case-insensitive) against `git branch --show-current`. Mismatch → silent stop.
  - **PR-state short-circuit.** Shells out to `gh pr view --json state` for the current branch; `MERGED` → silent stop. Cached for 5 minutes per session. Graceful degrade when `gh` is unavailable.
  - **Kill switch.** File at `.agent/autopilot-disable` → silent stop. `touch .agent/autopilot-disable` from any terminal kills the loop; `rm` to re-enable for future sessions.
  - **STOP-report backoff.** Two consecutive assistant messages matching `^STOP[:.\s—]` → silent stop. Counter resets when the unchecked-box count drops (agent made real progress).
  - **Iteration-cap fix.** `stopped: true` is set unconditionally at the cap, regardless of whether the final nudge was debounced.

  Prompt (`autopilot.md`) now documents the plan-shape contract, the `[~]` (pending) and `[-]` (blocked) AC markers (which `countUnchecked` already ignored but the orchestrator didn't know to write), and the full expanded stop-conditions list.

  New `SessionState` fields: `stopReason`, `consecutiveStops`, `prState`, `prCheckedAt`, `lastUncheckedCount`. All optional; unaffected sessions migrate in place.

  No user-facing workflow changes for well-formed unit plans — they nudge exactly as before.

- [#73](https://github.com/iceglober/harness-opencode/pull/73) [`d35f93d`](https://github.com/iceglober/harness-opencode/commit/d35f93da26859c3b509641170f64bf226cda358e) Thanks [@iceglober](https://github.com/iceglober)! - Fix: silence bash ask-prompts for qa-reviewer, qa-thorough, orchestrator, and build

  Switch the agent-level `permission.bash` from scalar `"allow"` to an object-form map with an enumerated allow-list of non-destructive commands (`pnpm lint *`, `tail *`, `ls *`, `git diff *`, `git merge-base *`, `git log *`, `bunx *`, etc.). Live log evidence (commits c9a288d/3483448 notwithstanding) confirmed an upstream OpenCode layer injects `{bash, *, ask}` that beats our scalar `allow` via last-match-wins in `Permission.evaluate`. Specific-pattern keys sort later in the ruleset and win.

  Destructive-command denies (`rm -rf /`, `chmod`, `chown`, `sudo`, `git push --force`) are preserved; `git push --force-with-lease` remains an explicit re-allow.

  Also ships a gated diagnostic probe: set `HARNESS_OPENCODE_PERM_DEBUG=1` to dump every agent's final permission block to `$XDG_STATE_HOME/harness-opencode/perm-debug.json`. Silent and zero-overhead when unset. Use it to verify the fix on your machine or to diagnose future permission-resolution issues.

## 0.7.0

### Minor Changes

- [#69](https://github.com/iceglober/harness-opencode/pull/69) [`a65f944`](https://github.com/iceglober/harness-opencode/commit/a65f9448d43e733279056b3331032d163e2a7cc0) Thanks [@iceglober](https://github.com/iceglober)! - Simplify `/autopilot` to the canonical Ralph loop. The previous implementation had grown to a 1344-line plugin, a 227-line prompt, a 9-rule orchestrator carve-out, and a 13-field per-session state machine with five independent "exit detectors." A recent failure session showed the plugin fighting the orchestrator for control and firing stale nudges on a non-autopilot session. The architecture had drifted far from the Ralph pattern it was modeled on (`while :; do cat PROMPT.md | claude-code ; done` — one prompt, stateless agent, filesystem is the state).

  This release strips autopilot to what `/autopilot` actually needs to do: detect the slash-command invocation, send one kind of nudge while the plan has unchecked boxes, stop when the boxes are checked or when a max-iterations cap fires.

  **What changed**

  - `src/plugins/autopilot.ts`: 1344 → 292 lines. One activation gate (`/autopilot` or `AUTOPILOT mode` in the session's first user message only), one nudge string, one max-iterations cap, one debounce. Removed the completion-promise sentinel (`<promise>DONE</promise>`), the orchestrator EXIT sentinel (`<autopilot>EXIT</autopilot>`), the verifier-verdict tokens (`[AUTOPILOT_VERIFIED]` / `[AUTOPILOT_UNVERIFIED]`), the `@autopilot-verifier` delegation, the shipped-probe (spawning `git merge-base` + `gh pr list`), the substrate-hash stagnation detector, the user-stop-token detection, and every piece of state that supported them. Stop conditions now come from the plan file on disk: zero unchecked `- [ ]` under `## Acceptance criteria` → silent stop; max iterations → one final "stopped" nudge, then silence; user types anything → iterations reset.
  - `src/commands/prompts/autopilot.md`: 227 → 77 lines. Replaced the 9-rule preamble with a single paragraph describing the contract. Kept issue-ref classification (Linear, GitHub, Jira MCPs), the five-phase handoff, and the guardrails that matter (never ask scoping questions, never commit/push/open-PR, never invoke `/ship` yourself). Removed the sequence-loop-of-issues feature — it was never actually exercised and the queue file (`.agent/autopilot-queue.json`) added more state drift than it solved.
  - `src/agents/prompts/orchestrator.md`: removed the 3-paragraph `# Autopilot mode` self-check section, the Phase 1.5 autopilot carve-out explaining forbidden tokens, the Phase 4 autopilot-conditional completion-promise emission, and the hard rule forbidding self-activation. Replaced with a 2-paragraph section: autopilot activates only via `/autopilot`; idle nudges are "keep going" signals; stop when all boxes are `[x]`.
  - `src/agents/prompts/autopilot-verifier.md`: deleted. The agent was only called from the now-removed completion-promise protocol.
  - `src/agents/index.ts`: dropped the `autopilot-verifier` registration and the `AUTOPILOT_VERIFIER_PERMISSIONS` constant.
  - `src/index.ts`: dropped the dead `chat.params` and `experimental.session.compacting` hook references (the autopilot plugin never actually implemented them).
  - `test/autopilot-plugin.test.js`: 1389 → 469 lines. Rewrote to exercise the new surface: activation gate, idle-nudge firing, plan-done silence, max-iterations cap, debounce, user-message reset, non-target-agent ignore.
  - `test/qa-reviewer-flow.sh`: deleted. The script targeted paths under `home/.claude/agents/` that stopped existing when the repo migrated to the npm plugin layout.
  - `test/agents.test.ts`: updated expected subagent count 13 → 12, dropped `autopilot-verifier`-specific assertions.
  - `README.md`: removed `autopilot-verifier` from the subagent list.

  **Behavior notes**

  - Autopilot activation remains strictly opt-in via `/autopilot`. The `detectActivation` helper still scans only the session's FIRST user message, so pasted transcripts or prose that descriptively mention `/autopilot` or `AUTOPILOT mode` do not retroactively activate a vanilla session.
  - `/ship` stays the human gate. The orchestrator prints "Done. Run `/ship <plan>`" and stops.
  - On stop, the plugin no longer writes acknowledgement nudges to the session. Exits are silent — the signal is the plan's boxes or the single max-iterations message.
  - If you relied on the `<promise>DONE</promise>` sentinel or `@autopilot-verifier` in a custom workflow, that workflow needs rework. They are gone.

- [#71](https://github.com/iceglober/harness-opencode/pull/71) [`154af1a`](https://github.com/iceglober/harness-opencode/commit/154af1ad439ca13d8987f31bb27167fcdf18cf25) Thanks [@iceglober](https://github.com/iceglober)! - **Plans are now repo-shared instead of per-worktree.** Agent-written plans move from `$WORKTREE/.agent/plans/<slug>.md` to `~/.glorious/opencode/<repo-folder>/plans/<slug>.md` — visible from every worktree of the same repo, survive `/fresh`, no longer entangled with the transient worktree they happened to be drafted in.

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

### Patch Changes

- [#72](https://github.com/iceglober/harness-opencode/pull/72) [`e63bcf6`](https://github.com/iceglober/harness-opencode/commit/e63bcf6cd289ea45899e409f197a84cd9f672d09) Thanks [@iceglober](https://github.com/iceglober)! - Orchestrator now recognizes plugin-provided slash commands (`/fresh`, `/ship`, `/review`, `/autopilot`, `/research`, `/init-deep`, `/costs`) when they appear as the first token of the first user message and weren't dispatched by the OpenCode TUI. In that case the orchestrator reads the command template from the bundled plugin cache, substitutes `$ARGUMENTS`, and executes it inline — same as if the TUI had dispatched normally.

  Context: some sessions receive the raw slash-command text as a plain user message (TUI dispatch silently misses for reasons we haven't pinned down — copy-paste, certain keyboard shortcuts, etc.). Without a fallback, the orchestrator would improvise, e.g. interpret `/fresh meeting prep` as "do something fresh-ish" and go hunting for `gs wt` subcommands instead of running `/fresh`. Prompt-only change; no runtime behavior outside the orchestrator prompt itself. Unknown `/<token>` commands and mid-message slashes still fall through to normal Phase 1 — fallback is scoped tightly to the seven shipped commands at start-of-first-message only.

## 0.6.1

### Patch Changes

- [#65](https://github.com/iceglober/harness-opencode/pull/65) [`c59c875`](https://github.com/iceglober/harness-opencode/commit/c59c8757bfca0311d6eb5de146ae6c46bdd8dd8b) Thanks [@iceglober](https://github.com/iceglober)! - Two friction fixes so `/fresh` is actually friction-free, not just nominally so:

  1. **`/fresh` no longer asks to confirm discarding uncommitted changes.** Running `/fresh` is itself the intent to discard; the interactive default has always been "wipe silently" per spec, but the prompt was hedged enough that the agent kept synthesizing a confirmation anyway (notably for untracked non-gitignored files like `.opencode/package-lock.json`). Added a loud top-of-prompt directive enumerating the only two permissible `question`-tool cases (`--confirm` was passed, or the input had no ref) and reinforced the "only under `--confirm`" guard at §3. No behavior change in `--confirm` or `--yes` modes.

  2. **Plugin now self-updates the OpenCode cache instead of asking users to run `bun update`.** Context: OpenCode caches the plugin at `~/.cache/opencode/packages/@glrs-dev/harness-opencode@latest/` with an exact version pin baked into that dir's `package.json` and `package-lock.json` — so `bun update` from anywhere else is a no-op, and users silently drift behind for releases. (Symptom: users on 0.1.2 still hitting the `/tmp/**` external-directory prompts that were fixed in 0.3.0.) The daily update check now rewrites that cache dir's pin to the latest version and removes its `node_modules/`, so the next OpenCode restart re-installs fresh. The toast copy is now "next restart will auto-update" instead of "run bun update." Writes are atomic (tmp + rename), skip non-exact user-managed pins, and require name-match against our package. `HARNESS_OPENCODE_AUTO_UPDATE=0` disables just the rewrite; `HARNESS_OPENCODE_UPDATE_CHECK=0` still disables the whole thing.

  Bonus: fixes a drift bug where `BUNDLED_VERSION` was hardcoded to `"0.1.2"` in source (comment lied — release pipeline never actually patched it). It's now read from `package.json` at module load, so the running version always matches the shipped package.

- [#68](https://github.com/iceglober/harness-opencode/pull/68) [`03d5352`](https://github.com/iceglober/harness-opencode/commit/03d5352ba1ed92d4c69452ed7dc9d01148a9194d) Thanks [@iceglober](https://github.com/iceglober)! - **Fix: OpenCode no longer crashes at startup with `TypeError: undefined is not an object (evaluating 'V[G]' / 'S.auth' / 'M.config')` when the harness plugin is enabled.**

  This has been silently broken since **v0.3.0** (~commit `e5ffb7c`). Users on v0.3.0–v0.6.0 saw one of several minified-variable error shapes depending on OpenCode version:

  - `TypeError: undefined is not an object (evaluating 'V[G]')`
  - `TypeError: undefined is not an object (evaluating 'f.auth')`
  - `TypeError: undefined is not an object (evaluating 'M.config')`

  All the same bug. The `oc` command would refuse to start in any worktree with the plugin enabled via `~/.config/opencode/opencode.json`.

  ## Root cause

  In commit `e5ffb7c` (v0.3.0, "wire subagent permissions via TS overrides + allow scratch/XDG paths"), `applyConfig` in `src/index.ts` was changed from `function applyConfig(...)` to `export function applyConfig(...)` purely so tests could import it directly.

  OpenCode's plugin loader (1.14.x line) probes named exports on the plugin module looking for `PluginModule`-shaped entries (`{ id?, server, tui? }`). When it encountered the plain `applyConfig` function as a named export, the probe crashed inside OpenCode's minified bundle — fatal at plugin-load time, which cascaded into provider init (`S.auth`) and TUI bootstrap failing entirely.

  Bisect walked every published version (v0.1.2 works, v0.2.0 works, v0.3.0 onward crashes) and isolated the crash to the single `export` keyword on line 137 of `src/index.ts`.

  ## Fix

  Moved `applyConfig` into a dedicated module `src/config-hook.ts`. `src/index.ts` now imports it as a runtime internal and has exactly **one** export — the plugin factory `default`. Tests import `applyConfig` from `src/config-hook.ts`.

  ## Regression guard

  New test file `test/plugin-entry-single-default-export.test.ts` enforces three invariants:

  1. `src/index.ts` has no `export function/const/let/var/class/enum/namespace/{...}` — only `export default`.
  2. `src/index.ts` has exactly one `export default`.
  3. The built `dist/index.js` exposes only `default` on its runtime surface (guards against bundler quirks that might re-surface internals).

  Any future commit that adds a named export to `src/index.ts` will fail CI with a message pointing at this changelog entry.

  ## Bonus

  Also hardens the returned `Hooks` object to omit keys whose values are `undefined` (defensive against a separate class of OpenCode-loader edge case observed while bisecting). New test file `test/plugin-hooks-no-undefined.test.ts` locks that in too.

  ## Upgrade path

  Users on floating semver (`bun add @glrs-dev/harness-opencode`) auto-recover on next `bun update`. Users stuck on `@latest` in the OpenCode cache already benefit from the self-update mechanism added in v0.6.0 ([#65](https://github.com/iceglober/harness-opencode/issues/65)) — next OpenCode restart re-installs the fixed version.

  For users who can't wait for the release: edit `~/.config/opencode/opencode.json` and remove the `plugin` array temporarily, then restore it after `bun update` completes. `oc` works without the harness; you just lose the custom agents/skills until the update lands.

- [#67](https://github.com/iceglober/harness-opencode/pull/67) [`3483448`](https://github.com/iceglober/harness-opencode/commit/3483448281f3652d803067dff1bda2687bdace0e) Thanks [@iceglober](https://github.com/iceglober)! - **Fix: reviewers no longer prompt for permission on trivial read-only git commands (`git branch --show-current`, `git status`, etc.).**

  Context: users kept hitting `Permission required` asks inside `qa-reviewer`, `qa-thorough`, and `autopilot-verifier` for commands that were explicitly supposed to be allowed. v0.6.0 (commit `c9a288d`) tried to fix this by simplifying the agent-level `permission.bash` from an object-form rule-map to the scalar `"allow"`, but the prompts kept coming.

  Root cause: OpenCode's permission resolver merges agent-level `permission.bash` with the **global** `permission.bash` from `applyConfig`. When the agent level was scalar `"allow"` and the global was an object-form rule-map (`{"*": "allow", "git push --force*": "deny", ...}`), the global map was still being re-evaluated on each bash invocation and fell through to an ask for some command shapes — even commands as trivial as `git branch --show-current`. The agent-level scalar was not winning the resolution.

  Fix: removed the global `permission.bash` default in `applyConfig` entirely. Subagents that declare `bash: "allow"` now get an unambiguous allow with nothing to fight against. Destructive-command safety is preserved at two surviving layers:

  1. **Primary agents (`orchestrator`, `build`) keep their own object-form bash rule-maps** with explicit denies for `rm -rf`, `sudo`, `chmod`, `chown`, `git push --force`, `git push * main`, `git push * master`. These are the only agents that routinely run shell commands with mutation potential, so the safety net is exactly where it's needed.
  2. **Read-only subagents (`plan-reviewer`, `code-searcher`, `gap-analyzer`, `architecture-advisor`, `lib-reader`) declare `bash: "deny"`** entirely — bash is off for them regardless.

  Reviewers (`qa-reviewer`, `qa-thorough`, `autopilot-verifier`) are read-only by role; their system prompts forbid destructive operations and they never reach for them. The risk surface from dropping the global deny net for them is negligible; the productivity cost of the ask-prompts was severe.

  Also updated: relevant test assertions (`applyConfig — permission.bash behavior` block), and the explanatory comments in `src/index.ts` + `src/agents/index.ts` that referenced the now-removed global layer so future maintainers don't try to re-add it without reading the history.

## 0.6.0

### Minor Changes

- [#64](https://github.com/iceglober/harness-opencode/pull/64) [`e75d75b`](https://github.com/iceglober/harness-opencode/commit/e75d75ba8b694fdd15eeca61befdb958320443fb) Thanks [@iceglober](https://github.com/iceglober)! - Decouple `/fresh` from the autopilot plugin. `/fresh` is now a pure workspace-cleanup command — parse args, clean the tree, create the branch, optionally dispatch to the repo's `.glorious/hooks/fresh-reset`, then continue inline into the orchestrator on the new task. It no longer writes a handoff brief, no longer touches `.agent/autopilot-state.json`, and no longer coordinates with the autopilot plugin in any way.

  This is the architectural fix for the class of "duplicate autopilot nudge" bug where the plugin's `[autopilot] /fresh re-keyed this worktree to a new task...` message fired twice per session — once legitimately after `/fresh`, and once spuriously after the user had already shipped a PR. The `lastNudgedHandoffMtime` idempotency gate (briefly shipped on a dev branch but never released) was hardening code that shouldn't have existed in the first place.

  **Deleted from the plugin (`src/plugins/autopilot.ts`):**

  - `lastHandoffMtime` field on `SessionAutopilot` and its 14 preservation sites across every state-write path
  - `HANDOFF_PATH` constant and `getHandoffMtime` helper
  - Signal 2 (fresh-handoff transition) in `detectActivation` — the function is now a one-line first-user-message scan for the `/autopilot` marker
  - The fresh-transition branch in the `session.idle` handler (~40 lines, including the nudge body that referenced `.agent/fresh-handoff.md`)
  - The first-time-seed branch that populated `lastHandoffMtime` from the brief's mtime on first idle
  - Exit-message `/fresh` references — shipped-exit, user-stop, and stagnation messages now direct the user to open a new session and invoke `/autopilot` instead of suggesting `/fresh` as a re-enable path

  **Deleted from the `/fresh` prompt (`src/commands/prompts/fresh.md`):**

  - §6 "Write the handoff brief" — the entire markdown template, atomic-write semantics, brief-archival-to-tmp fallback
  - §6a "Reset autopilot state" — the `jq` rewrite of `.agent/autopilot-state.json`, the fallback-to-empty-sessions path, the whole rationale about iteration counters
  - The "read the brief you just wrote" circular step in the orchestrator-kickoff section (§7, formerly §8)
  - Every mention of `.agent/fresh-handoff.md`, `handoff brief`, and `autopilot-state.json` across the failure-mode table, the `/autopilot` integration section, and the philosophy statement

  Sections renumbered: old §7 (summary) is now §6; old §8 (orchestrator kickoff) is now §7. `RESET_STATUS` labels now go into the summary instead of the brief. The orchestrator-kickoff step uses the user's original input directly (no brief to re-read).

  **Deleted from the `/autopilot` prompt (`src/commands/prompts/autopilot.md`):**

  - Step 3 of the sequence loop no longer claims `/fresh` writes a brief or resets autopilot state — it now accurately describes `/fresh` as "re-key the worktree and auto-continue into the orchestrator"
  - Step 4 no longer references "the autopilot plugin's continuation nudges now reference the fresh handoff brief" — there are no such nudges

  **Deleted from tests (`test/autopilot-plugin.test.js`, `test/fresh-prompt.test.ts`):**

  - 5 obsolete `detectActivation` tests exercising Signal 2 (fresh-handoff activation)
  - 1 obsolete `session.idle` integration test for the fresh-transition nudge
  - 1 obsolete "fresh-transition after shipped-exit" regression test
  - 2 obsolete handoff-brief-field assertions in the /fresh prompt contract
  - `lastHandoffMtime` preservation assertions in chat.message tests

  **Added:**

  - 2 new /fresh prompt assertions that fail if the coupling is reintroduced: no reference to `.agent/fresh-handoff.md`, and no reference to `.agent/autopilot-state.json`

  **Behavior change for users:**

  - `/fresh` is faster and simpler — one less file write, no jq invocation, no autopilot coordination.
  - The autopilot plugin activates ONLY via explicit `/autopilot` invocation. The fresh-handoff activation path is gone. Users who want autopilot run `/autopilot`; users who want a clean workspace run `/fresh`; the two commands are orthogonal.
  - `/autopilot` sequence mode continues to work — its per-iteration loop already drives everything inline: pop ref → `/fresh --yes <ref>` → orchestrator runs on the new ref → loop. No plugin-mediated handoff was ever actually needed.
  - Terminal exits from autopilot (shipped, user-stop, orchestrator EXIT, max-iter, stagnation) are now truly terminal for the current session. Users open a new session and invoke `/autopilot` to resume — previously the messaging mentioned `/fresh` as a re-enable path, which was misleading (post-[#60](https://github.com/iceglober/harness-opencode/issues/60) `/fresh` would auto-continue into the orchestrator, not the autopilot arc).

  **Backward compatibility:**

  - State files written by older versions with `lastHandoffMtime` keys are still readable — the field is simply ignored (JSON.parse tolerates unknown keys, TypeScript-level shape is structural).
  - Existing handoff-brief files at `.agent/fresh-handoff.md` are left untouched by the new `/fresh`. They're orphaned documentation, safe to delete manually.
  - No migration required.

  Minor bump because the autopilot plugin's activation contract is narrowing (Signal 2 removed). Users who were relying on fresh-handoff-based activation (e.g., a hypothetical `/plan-loop` skill writing the brief as a cross-session signal) would break — but `/plan-loop` does not exist in this repo; the activation path existed only in plugin comments. Patch-adjacent in practice, but the contract narrowing deserves explicit signaling.

  Net diff: −346 lines across plugin, prompts, and tests. Removes a bug class, not just a bug.

### Patch Changes

- [#62](https://github.com/iceglober/harness-opencode/pull/62) [`c9a288d`](https://github.com/iceglober/harness-opencode/commit/c9a288daf1ef023dbfa910dcd138ea4a6c2b66bd) Thanks [@iceglober](https://github.com/iceglober)! - Simplify `bash` permission for `qa-reviewer`, `qa-thorough`, and `autopilot-verifier` to the plain string `"allow"`, removing the agent-level object-form rule-map. Eliminates a recurring permission-ask prompt on read-only pipelined commands (e.g. `git show <ref>:<path> | sed -n 'N,Mp'`) during review runs — the OpenCode runtime was apparently misfiring on pipelined shapes despite the catch-all `"*": "allow"` rule, and the agent-level deny list was defense-in-depth anyway.

  Destructive-command safety is retained at two layers:

  - **Global layer:** the `permission.bash` block in `applyConfig` (src/index.ts) continues to deny `git push --force*`, `rm -rf /*`, `rm -rf ~*`, `chmod *`, `chown *`, `sudo *` for every agent that doesn't override it. A new regression test locks this safety net in place.
  - **Agent-prompt layer:** each read-only reviewer's system prompt explicitly forbids mutating history, force-pushing, or touching the filesystem root.

  Other subagents are unchanged: `plan-reviewer`, `code-searcher`, `gap-analyzer`, `architecture-advisor`, and `lib-reader` keep `bash: "deny"`; `agents-md-writer` keeps `bash: "ask"`; `orchestrator` and `build` (primary agents) keep their object-form bash maps.

  Plan: `.agent/plans/qa-reviewer-bash-allow.md` (7/8 ACs [x] — a8 is this changeset).

## 0.5.0

### Minor Changes

- [#60](https://github.com/iceglober/harness-opencode/pull/60) [`6ece868`](https://github.com/iceglober/harness-opencode/commit/6ece86849bc94d6b7aa716365106b83813217c3b) Thanks [@iceglober](https://github.com/iceglober)! - Make `/fresh` faster and lower-friction. Three user-visible changes:

  - **`/fresh` now wipes by default in interactive mode.** Previously, a dirty working tree triggered a mandatory `question`-tool prompt ("Worktree is dirty. /fresh will hard-discard ALL uncommitted changes. Proceed?") before any reset ran. The new default trusts the human who typed `/fresh` — if you ran the command, you've already decided you want a fresh workspace. The wipe happens silently; the post-hoc summary in §7 lists what was discarded so there's still a visible receipt. `--confirm` is a new flag that restores the old ask-first behavior for paranoid runs. `--yes` (autopilot) semantics are unchanged — it stays strict, aborting on tracked changes or non-gitignored untracked files to protect unattended loops from silent data loss.

  - **`/fresh` auto-continues into the orchestrator on the new task.** New §8 "Kick off the orchestrator on the new task (in the SAME turn)": after printing the summary, `/fresh` reads the handoff brief it just wrote and enters the orchestrator arc inline (Phase 0 → Phase 1 → …) on the new request. You no longer have to type "work on it" after `/fresh`; the re-key and the start-working are one uninterrupted turn. The autopilot plugin's "session idle → nudge to read handoff brief" path becomes a fallback for the interrupted-continuation case rather than the primary mechanism — autopilot loops gain one round-trip saved per issue.

  - **Permission defaults relax for `git reset --hard` and `git clean`.** Shipped defaults in `src/index.ts` now `allow` both patterns (previously `ask` and `deny` respectively). The old defaults blocked `/fresh`'s own built-in reset flow and produced a permission prompt on every `git reset --hard` anywhere — exactly the "answer a question every time" friction that `/fresh` is supposed to eliminate. Destructive-push patterns (`git push --force`, `git push -f`, `rm -rf /`, `sudo`, `chmod`, `chown`) remain denied.

  Existing tests all pass (146 tests, 513 expects). The interactive-default flip is a behavior change for humans at the terminal — if you rely on the old ask-first prompt as a safety gate, add `--confirm` to your `/fresh` invocations or (for the habitual case) alias `/fresh` in your own notes to `/fresh --confirm`.

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
