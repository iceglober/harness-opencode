# Pilot v0.1+v0.2 — Implementation Todo

End-to-end checklist for the `pilot` subsystem in `@glrs-dev/harness-opencode`.
Every box must be checked before declaring v0.1+v0.2 done.

**Combined release scope:** planner agent + planning skill + builder agent +
CLI subcommands (`plan`, `build`, `status`, `validate`, `resume`, `retry`,
`logs`, `worktrees`, `cost`). Single-worker only. No PR creation. No Ink TUI.
No Slack notifications. No cost-cap preemption.

**Decisions baked in:**
- State location: `~/.glorious/opencode/<repo>/pilot/`
- No slash commands (CLI-only surface)
- v0.1 + v0.2 ship together
- Picomatch-based glob intersection for conflict detection
- Pilot stops at committed branches; PR creation out of scope
- Pilot agents register via `createAgents()` / `createCommands()`; the
  `pilot-plugin.ts` carries runtime hooks only

---

## Phase 0 — Spikes (de-risk before writing production code)

These produce short notes (committed under `docs/pilot/spikes/`) that the
dependent phases consume. Each spike is timeboxed.

- [x] **S1.** opencode CLI flags spike — TUI flags are `--agent <name>` and `--prompt <text>` (NOT `--message`). See [`docs/pilot/spikes/s1-opencode-cli-flags.md`](docs/pilot/spikes/s1-opencode-cli-flags.md).
- [x] **S2.** opencode SDK session methods spike — confirmed against `@opencode-ai/sdk@1.14.19`. **Plan corrections:** `session.create` takes `{ body: { title? }, query: { directory? } }` (NO `workspaceID`); `session.info` does not exist (use `session.get`). See [`docs/pilot/spikes/s2-sdk-session-methods.md`](docs/pilot/spikes/s2-sdk-session-methods.md).
- [x] **S3.** opencode SSE event shapes spike — `session.idle` is the canonical "done" signal. Also: `message.updated`, `message.part.updated`, `session.error`. See [`docs/pilot/spikes/s3-sse-event-shapes.md`](docs/pilot/spikes/s3-sse-event-shapes.md).
- [x] **S4.** Session resumability — sessions persist server-side under `~/.local/state/opencode/`; reattach via `session.get` works across server restart. **Side-finding:** `?directory=<path>` per-session-scopes a session to a worktree, so v0.1 needs only ONE shared server. See [`docs/pilot/spikes/s4-session-resumability.md`](docs/pilot/spikes/s4-session-resumability.md).
- [x] **S5.** Picomatch glob intersection — probe-based bidirectional matching, all 10 plan-cited cases pass. See [`docs/pilot/spikes/s5-picomatch-globs-conflict.md`](docs/pilot/spikes/s5-picomatch-globs-conflict.md).
- [x] **S6.** opencode `serve` startup line — `opencode server listening on http://<host>:<port>` on stdout. See [`docs/pilot/spikes/s6-serve-startup-line.md`](docs/pilot/spikes/s6-serve-startup-line.md).
- [x] **S7.** Spike notes committed under `docs/pilot/spikes/` and referenced from `PILOT_TODO.md` (this section + [`docs/pilot/spikes/README.md`](docs/pilot/spikes/README.md)).

---

## Phase A — Foundation (plan format & validation)

### A1. `pilot.yaml` schema with Zod

- [x] Add `zod` and `yaml` runtime deps; add `picomatch` for later. (zod pinned to `4.1.8` to dedupe with the version `@opencode-ai/plugin` ships, avoiding TS2742 portability errors in `src/tools/*`.)
- [x] Create `src/pilot/plan/schema.ts` with full Zod schema (plan, defaults, milestones, task).
- [x] Defaults: `branch_prefix = pilot/<slug>` (deferred to loader; schema leaves it optional), `defaults.model = anthropic/claude-sonnet-4-6`, `defaults.agent = pilot-builder`, `defaults.max_turns = 50`, `defaults.max_cost_usd = 5.00`.
- [x] Task ID regex: `^[A-Z][A-Z0-9-]*$`.
- [x] Validate `prompt` non-empty, `touches` array of strings, `verify` array of strings, `depends_on` array of task IDs.
- [x] Test file `test/pilot-plan-schema.test.ts` covering: minimal valid plan, missing required fields, invalid IDs, unknown agent (note: agent name is just a string at schema level — runtime resolution lives in Phase D/E), malformed verify entries.
- [x] **Verify:** 48 tests pass; `bun run typecheck` clean.

### A2. Plan loader + slug derivation

- [x] Create `src/pilot/plan/load.ts`: `loadPlan(absPath)` reads YAML, parses, schema-validates, returns typed `Plan`. Discriminated-union envelope (`fs` / `yaml` / `schema` failure modes).
- [x] Create `src/pilot/plan/slug.ts`: deterministic slug derivation from Linear ID, Linear project (handled as free-form — Linear has no canonical project URL grammar), GitHub URL/issue, or free-form input.
- [x] Slug collision suffixing under the plans dir (`-2`, `-3`, ...) via `resolveUniqueSlug` (pure function — caller passes the existing slug set).
- [x] Test files `test/pilot-plan-load.test.ts` (17 tests) and `test/pilot-plan-slug.test.ts` (33 tests).
- [x] **Verify:** 50 tests pass.

### A3. DAG validation

- [x] Create `src/pilot/plan/dag.ts`: `validateDag(plan)` returns `{ ok: true, topo: string[] } | { ok: false, errors }`.
- [x] Detect cycles (iterative DFS with three-color coloring), self-loops, dangling `depends_on`, duplicate task IDs. Ships `formatDagError` for CLI rendering.
- [x] Test file `test/pilot-plan-dag.test.ts`: cycles (2-cycle, 3-cycle), self-loops, dangling refs, duplicates, valid linear, valid diamond, disconnected components, declaration-order tiebreak.
- [x] **Verify:** 24 tests pass.

### A4. Touches glob intersection

- [x] Create `src/pilot/plan/globs.ts`: `globsConflict(globsA, globsB)`, `validateTouchSet(touches)`, `findTouchConflicts(tasks)`.
- [x] Implementation per S5 spike findings (probe-based bidirectional matching using picomatch with `dot:true`).
- [x] Test file `test/pilot-globs.test.ts`: all 7 PILOT_TODO cases pass plus 19 additional sanity checks.
- [x] **Verify:** 26 tests pass.

### A5. Pilot state directory paths

- [x] Read `src/plan-paths.ts` to mirror its repo-key derivation.
- [x] Create `src/pilot/paths.ts`: `getPilotDir(cwd)`, `getPlansDir`, `getRunDir(runId)`, `getWorktreeDir(runId, n)`, `getStateDbPath(runId)`, `getWorkerJsonlPath(runId, n)`.
- [x] Auto-create on first access; honor `GLORIOUS_PILOT_DIR` env override (with `GLORIOUS_PLAN_DIR` composition fallback).
- [x] Safety check on runId (rejects path-mischief chars like `..`, `/`, leading `.`).
- [x] Test file `test/pilot-paths.test.ts`: derivation determinism, env override, env composition, repo-key match, runId safety.
- [x] **Verify:** 16 tests pass. Total Phase A: 131 tests, all green; full suite 411 tests pass; `bun run typecheck` clean; `bun run build` clean.

---

## Phase B — Persistent state

### B1. SQLite schema + open

- [x] Create `src/pilot/state/db.ts` using `bun:sqlite`. Sets `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL` for file-backed DBs; supports `:memory:` for tests.
- [x] Create `src/pilot/state/migrations.ts` with v1 schema:
  - [x] `runs(id TEXT PK, plan_path, plan_slug, started_at, finished_at, status)` with CHECK constraint on status.
  - [x] `tasks(run_id, task_id, status, attempts, session_id, branch, worktree_path, started_at, finished_at, cost_usd, last_error, PK (run_id, task_id))` with FK to runs (ON DELETE CASCADE) and CHECK on status.
  - [x] `events(id PK AUTOINCREMENT, run_id, task_id, ts, kind, payload)` with FK to runs.
  - [x] `_migrations(version INT PK, applied_at INT)` (also stores description for audit trail).
  - [x] Indexes on `tasks(run_id, status)`, `events(run_id, id)`, `events(run_id, task_id, id)`.
- [x] Migrations applied on open (idempotent). Each migration runs in its own transaction so partial failure doesn't leave a half-state.
- [x] Test file `test/pilot-state-db.test.ts`: schema creation (every column / type / constraint), idempotent reopen, migration tracking, basic CRUD, FK cascade, PRAGMA verification.
- [x] **Verify:** 21 tests pass.

### B2. State accessors

- [x] Create `src/pilot/state/runs.ts`: `createRun(plan)` → run-id (ULID via `ulid` package); `markRunRunning`; `markRunFinished(runId, status)`; `getRun`/`listRuns`/`latestRun`.
- [x] Create `src/pilot/state/tasks.ts`: `upsertFromPlan`, `markReady`, `markRunning`, `markSucceeded`, `markFailed(reason)`, `markBlocked`, `markAborted`, `markPending` (for retry), `setCostUsd`, `readyTasks`, `countByStatus`. Each transition enforces the legal previous-state set.
- [x] Create `src/pilot/state/events.ts`: `appendEvent`, `readEvents`, `readEventsDecoded`. Tolerates non-JSON-serializable payloads with a degraded fallback.
- [x] Status enums for runs (`pending|running|completed|aborted|failed`) and tasks (`pending|ready|running|succeeded|failed|blocked|aborted`) exported from `src/pilot/state/types.ts` so callers don't need a sqlite import.
- [x] Test file `test/pilot-state-accessors.test.ts`: state transitions (legal + illegal), ready-set computation, retry semantics (markPending preserves attempts/cost), event ordering, FK enforcement.
- [x] **Verify:** 31 tests pass.

---

## Phase C — Worktree management

### C1. Worktree pool (single-worker)

- [x] Create `src/pilot/worktree/git.ts`: wrappers around `git -C <path> ...` via `execFile`. Functions: `gitIsAvailable`, `gitWorktreeAdd`, `gitWorktreeRemove` (tolerates pre-deleted dirs), `gitWorktreeList`, `checkoutFreshBranch`, `cleanWorktree`, `commitAll` (with author env vars), `currentBranch` (empty on detached HEAD), `headSha`, `diffNamesSince` (committed + staged + unstaged + untracked, deduped + sorted). 30s default timeout; 16MB stdout buffer; null-byte-safe arg validation.
- [x] Create `src/pilot/worktree/pool.ts`: `WorktreePool` class. v0.1 hard-codes `workerCount=1` (clamps higher with stderr warning). `acquire`, `prepare(slot, taskId, branchPrefix, base)` returns `{sinceSha, branch, path}`, `release`, `preserveOnFailure`, `shutdown({keepPreserved=true})`, `inspect`. Cleans stale dirs from prior crashed runs on first prepare.
- [x] Test file `test/pilot-worktree-git.test.ts` using tmp git repo fixtures; skips when git unavailable. 24 tests covering every wrapper plus an integration smoke for the full add → edit → diff → clean → re-checkout cycle.
- [x] Test file `test/pilot-worktree-pool.test.ts`: 13 tests covering acquire/prepare/release lifecycle, preserve-on-failure, workerCount clamp, stale-dir cleanup, shutdown semantics.
- [x] **Verify:** 24 + 13 = 37 tests pass.

### C2. Touches enforcement

- [x] Create `src/pilot/verify/touches.ts`: `enforceTouches({worktree, sinceSha, allowed})` returns `{ ok: true, changed } | { ok: false, changed, violators }`. Plus `enforceTouchesPure({changed, allowed})` — pure variant for test/worker reuse.
- [x] Empty `allowed` + any diff = violation (every changed file is a violator).
- [x] Test file `test/pilot-touches-enforce.test.ts` with tmp git repo + pure-function suite. 14 tests covering allowed-only edits, violations (untracked, out-of-scope, multi-glob), no-edits ok path, dotfile match.
- [x] **Verify:** 14 tests pass. Total Phase C: 51 tests. Full suite now 514 pass / 0 fail across 28 files; `bun run typecheck` clean; `bun run build` clean.

---

## Phase D — opencode integration

### D1. Server lifecycle

- [x] Create `src/pilot/opencode/server.ts`: `startOpencodeServer({ port?, hostname?, timeoutMs? })`. Wraps the SDK's `createOpencodeServer` + `createOpencodeClient` rather than reinventing them — the SDK already does the spawn-and-parse-listening-line dance per spike S6.
- [x] Pre-checks `opencode` on PATH via `opencode --version` for doctor-friendly errors instead of the SDK's generic spawn failure.
- [x] Resolves timeout via `OPENCODE_SERVER_TIMEOUT_MS` env var with default 30s (the SDK's 5s default is too aggressive for cold starts).
- [x] `shutdown()`: idempotent — calls SDK's `close()` (which sends SIGTERM + grace period); subsequent calls are no-ops.
- [x] Test file `test/pilot-opencode-server.test.ts`: 9 tests covering PATH precheck failure modes, timeout-resolution precedence, env-var validation, plus an `OPENCODE_E2E=1`-gated end-to-end test that spawns a real server.
- [x] **Verify:** 9 tests pass (E2E test skipped without `OPENCODE_E2E=1`).

### D2. Event multiplexer

- [x] Create `src/pilot/opencode/events.ts`: `EventBus` class wrapping one `event.subscribe()` SSE stream.
- [x] `EventBus.on(sessionId, handler)` returns an unsubscribe function. Handler errors don't crash the bus or break fan-out to siblings.
- [x] `EventBus.waitForIdle(sessionId, { stallMs, abortSignal, errorIsFatal })` returns a discriminated union: `{ kind: "idle" | "stall" | "abort" | "session-error" }`. Stall timer is reset on every event activity for that session.
- [x] `EventBus.close()` is idempotent and aborts the underlying SSE subscription via signal.
- [x] Test file `test/pilot-opencode-events.test.ts`: 19 tests with a hand-rolled mock SSE stream (no real opencode needed). Covers fan-out, session filtering, all four `waitForIdle` resolution branches, stall-timer-reset on activity, late-event safety, abort signal handling, and stream-error surfacing.
- [x] **Verify:** 19 tests pass.

### D3. Kickoff and fix prompt templates

- [x] Create `src/pilot/opencode/prompts.ts`: `kickoffPrompt(task, runContext)` and `fixPrompt(task, lastFailure)`.
- [x] Kickoff includes worktree path, branch, plan name, optional milestone, hard rules (no commit/push/PR, no questions, no out-of-scope edits, STOP protocol), allowed scope (touches), full verify list (per-task + plan-default + milestone), repo-conventions reminder, then the task prompt verbatim.
- [x] Fix prompt has two paths: standard verify-failure (quotes command + exit code + output in a code fence) and touches-violation (lists violators, asks for revert, hints about STOP if revert conflicts).
- [x] Test file `test/pilot-opencode-prompts.test.ts`: 24 substring/structure assertions plus determinism checks.
- [x] **Verify:** 24 tests pass.

### D4. Verify runner

- [x] Create `src/pilot/verify/runner.ts`: `runVerify(commands, { cwd, timeoutMs?, outputCapBytes?, onLine?, abortSignal?, env? })` runs each command sequentially via `bash -c`. Plus `runOne` for single-command callers.
- [x] Streams output to buffer + optional `onLine` callback for JSONL piping. Per-command output cap (default 256KB) with truncation sentinel.
- [x] Returns discriminated union; on failure, the result includes `{ command, exitCode, signal, timedOut, aborted, output, durationMs }`.
- [x] Per-command timeout (default 5min) via SIGTERM + 2s grace + SIGKILL. Abort signal supported (mid-run cancellation).
- [x] Test file `test/pilot-verify-runner.test.ts`: 24 tests covering exit codes, stdout/stderr capture, cwd enforcement, env override, timeout, abort (mid-run + pre-aborted), line-streaming (including trailing partial line), output truncation, multi-command short-circuit on first failure.
- [x] **Verify:** 24 tests pass. Total Phase D: 76 tests; full suite 590 pass / 0 fail / 32 files; `bun run typecheck` clean; `bun run build` clean.

---

## Phase E — Worker loop

### E1. Single-worker driver

- [x] Create `src/pilot/worker/stop-detect.ts`: detects assistant messages whose first non-whitespace line matches `^STOP:`. Tracks per-message text accumulation across `message.part.updated` deltas; single-shot semantics; only fires for `role: "assistant"` messages on the target session. Pure `checkStop(text)` helper exported for unit tests.
- [x] Create `src/pilot/worker/worker.ts`: `runWorker(deps)` executes the per-task lifecycle:
  - [x] acquire next task from scheduler; if none, exit.
  - [x] `pool.prepare(task)`; capture `sinceSha`, branch, path.
  - [x] `client.session.create({ body: { title }, query: { directory: wt.path } })` (corrected per spike S2 — no `workspaceID`).
  - [x] `state.markRunning(sessionId, branch, worktreePath)`; `events.append(task.started, task.session.created, task.attempt)`.
  - [x] `client.session.promptAsync({ path: { id }, body: { agent, parts: [...] } })`.
  - [x] `EventBus.waitForIdle(session.id, { stallMs, abortSignal })`.
  - [x] STOP detection (via subscribed `StopDetector`) — if hit, mark failed, preserve worktree, `events.append(task.stopped)`.
  - [x] Verify: `runVerify([...task.verify, ...defaults.verify_after_each, ...(milestone ? milestones.verify : [])])`.
  - [x] On verify fail with attempts remaining: build `fixPrompt` (with `LastFailure`), loop. On no attempts left: mark failed, preserve.
  - [x] On verify pass: `enforceTouches(wt, sinceSha, task.touches)`. Violation → fix-loop with `touchesViolators` set; out of attempts → mark failed, preserve.
  - [x] Clean → `commitAll(wt, "<id>: <title>")`, mark succeeded, `events.append(task.succeeded)`. Verify-only tasks (no diff) succeed without commit.
- [x] Stall handling: `client.session.abort(session.id)`; mark failed; preserve worktree.
- [x] Abort signal: aborts in-flight session, marks task aborted, returns `{ aborted: true }`.
- [x] Cost tracking: `pollCost` reads `session.get` and falls back to `session.messages` aggregate; updates `tasks.cost_usd` (reporting-only, never blocks).
- [x] Max attempts default = 3 (configurable).
- [x] After each task, the worker calls `scheduler.cascadeFail()` to mark dependent tasks blocked when this task ended in `failed`/`aborted`.
- [x] Test file `test/pilot-worker.test.ts` (10 tests) with mocked client/bus + real state-DB + real worktree-pool + real verify-runner: happy path, verify-only task, fix loop reuses session, max-attempts failure preserves worktree, touches violation, STOP path, stall path, cascade-fail propagation, abort signal (mid-run + pre-aborted).
- [x] **Verify:** 10 tests pass.

### E2. Scheduler (single-worker)

- [x] Create `src/pilot/scheduler/ready-set.ts`: `makeScheduler({ db, runId, plan })`. Stateless (queries DB on every call) so multi-worker (v0.3) and `pilot resume` work without coordination.
- [x] `next()` picks the next task in declaration order whose deps are all `succeeded`; marks it `ready` in the DB; returns null when no task is ready.
- [x] `cascadeFail(failedTaskId)`: marks every transitive dependent `blocked` with a reason. Idempotent on already-terminal tasks.
- [x] `isComplete()` for the worker's loop-exit check.
- [x] `planTask(taskId)` lookup helper.
- [x] Test file `test/pilot-scheduler.test.ts` (19 tests): linear + diamond + disconnected DAGs, declaration-order tiebreak, cascade-fail (direct + transitive), stay-out-of-terminal-states guard.
- [x] **Verify:** 19 tests pass. Total Phase E: 52 tests.

---

## Phase F — Agents and skill

### F1. `pilot-builder` agent

- [x] Create `src/agents/prompts/pilot-builder.md` with frontmatter (`description`, `mode: primary`, `model: anthropic/claude-sonnet-4-6`, `temperature: 0.1`).
- [x] Body: hard rules (no-commit/push/PR, no-questions, no-out-of-scope, no-branch-switch), STOP protocol with examples, workflow (read AGENTS.md, tool preferences, minimal-change discipline, fix-prompt protocol).
- [x] Add `pilotBuilderPrompt = readPrompt("pilot-builder.md")` in `src/agents/index.ts`.
- [x] Add `PILOT_BUILDER_PERMISSIONS` const based on `CORE_BASH_ALLOW_LIST` + `CORE_DESTRUCTIVE_BASH_DENIES` plus pilot-specific denies on `git commit*`, `git push*`, `git tag*`, `git checkout *`, `git switch *`, `git branch *`, `git restore --source*`, `git reset *`, `gh pr *`, `gh release *`. Also denies the `question` tool (unattended invariant).
- [x] Add to `createAgents()` with explicit `mode/model/temperature` overrides (the `agentFromPrompt` helper doesn't parse `temperature` from frontmatter).
- [x] Add `"pilot-builder": "mid"` to `AGENT_TIERS`.
- [x] Extend `test/agents.test.ts` with pilot-builder shape + deny-list assertions.
- [x] **Verify:** 10 new pilot-agent assertions pass; full `test/agents.test.ts` 59/59 green.

### F2. `pilot-planner` agent

- [x] Create `src/agents/prompts/pilot-planner.md` (frontmatter: `mode: primary`, `model: anthropic/claude-opus-4-7`, `temperature: 0.3`).
- [x] Body: workflow (understand → research → apply skill → write YAML → validate → hand off), schema reference, common-mistake list, "when to refuse".
- [x] Add `pilotPlannerPrompt = readPrompt("pilot-planner.md")` in `src/agents/index.ts`.
- [x] Add `PILOT_PLANNER_PERMISSIONS`: `bash: { "*": "deny", + enumerated read-only inspection allows + `bunx @glrs-dev/harness-opencode pilot validate*` + `pilot plan-dir*` + harness `plan-dir*` }`. `edit: allow` (constrained at runtime by pilot-plugin in Phase H1). `webfetch: deny` by default; planner uses `linear` MCP. `question: allow` (interactive planning). `tsc_check`, `eslint_check`, `playwright`, `memory` denied.
- [x] Add to `createAgents()` with explicit `mode/model/temperature` overrides.
- [x] Add `"pilot-planner": "deep"` to `AGENT_TIERS`.
- [x] Extend `test/agents.test.ts` with pilot-planner shape + deny-list assertions; updated `test/harness-models.test.ts` deep/mid groupings to include the new agents.
- [x] **Verify:** 59 agents tests + harness-models tests all pass.

### F3. `pilot-planning` skill

- [x] Create `src/skills/pilot-planning/SKILL.md` — overview + workflow listing the 7 rules + when-to-refuse guidance.
- [x] Create `src/skills/pilot-planning/rules/first-principles.md` (frame from intent; talk to user once; then read code).
- [x] Create `src/skills/pilot-planning/rules/decomposition.md` (right-sized = 10-30 min agent time; sizing heuristics; splitting/anti patterns).
- [x] Create `src/skills/pilot-planning/rules/verify-design.md` (real assertions; two-tier verify; touches-and-verify must agree; deterministic; "before" check).
- [x] Create `src/skills/pilot-planning/rules/touches-scope.md` (tightness heuristics; when `**` is OK; common mistakes).
- [x] Create `src/skills/pilot-planning/rules/dag-shape.md` (real vs false dependencies; common shapes; cycle detection).
- [x] Create `src/skills/pilot-planning/rules/milestones.md` (when to use / not use; presentation/verify-grouping vs scheduling).
- [x] Create `src/skills/pilot-planning/rules/self-review.md` (7-question checklist; validate; ready vs refuse).
- [x] Extend `test/skills-bundle.test.ts` to assert pilot-planning bundles SKILL.md + 7 rules (8 files total).
- [x] **Verify:** `bun run build` clean; skills-bundle test 12 pass; prompts-no-dangling-paths test 10 pass. Total Phase F: 10 new agent assertions + 1 skills-bundle assertion. Full suite 653 pass / 0 fail / 35 files.

---

## Phase G — CLI surface

### G0. Migrated entire CLI to cmd-ts (out-of-band scope expansion)

- [x] Added `cmd-ts@0.15.0` as runtime dep. Migrated the existing top-level commands (install, uninstall, doctor, plan-check, plan-dir) from hand-rolled `if/else` dispatch to declarative `command(...) + subcommands(...)`. Added `bun:sqlite` and `bun:test` to the tsup `external` array so the bundler doesn't try to resolve bun's runtime builtins.

### G1. Pilot CLI subcommand dispatch

- [x] Create `src/pilot/cli/index.ts` exporting `pilotSubcommand` (a `subcommands(...)` value) wired into `src/cli.ts` under the `pilot` key. Each verb's command lives in its own file.
- [x] cmd-ts auto-generates `--help` for both the top-level and the pilot subtree; no manual HELP text maintenance.
- [x] **Verify:** `bunx @glrs-dev/harness-opencode pilot --help` lists all 10 verbs (validate, plan, build, status, resume, retry, logs, worktrees, cost, plan-dir).

### G2. `pilot validate`

- [x] Create `src/pilot/cli/validate.ts`: positional plan path (optional, defaults to latest `*.yaml` in plans dir; accepts a directory). Exports `runValidate(opts)` returning the exit code so other commands (build) can reuse the pipeline.
- [x] Runs schema (`loadPlan`) + DAG (`validateDag`) + per-task touches wellformedness (`validateTouchSet`) + cross-task touches conflicts (`findTouchConflicts`).
- [x] Prints errors with `<kind>: <path-into-doc>: <message>` shape on stderr; exit 1 on I/O, 2 on validation, 0 on clean.
- [x] `--strict` promotes touches-conflict warnings to errors. `--quiet` suppresses success output.
- [x] Test file `test/pilot-cli-validate.test.ts` (15 tests) with fixture plans (valid, schema-invalid, cycle, dangling-dep, duplicate-id, glob-conflict warning + strict) plus 3 spawned-CLI smoke tests.
- [x] **Verify:** 15 tests pass.

### G3. `pilot plan`

- [x] Create `src/pilot/cli/plan.ts`. Spawns `opencode --agent pilot-planner --prompt "<initial>"` per spike S1. `--opencode-bin` flag overrides PATH lookup (used by tests).
- [x] On exit, scans plans dir for new YAML files (or YAMLs whose mtime moved forward); prints `Plan ready at <path>` and `Build with: bunx @glrs-dev/harness-opencode pilot build`.
- [x] Test file `test/pilot-cli-plan.test.ts` (5 tests) using shell shims for happy/fail/no-op opencode behavior.
- [x] **Verify:** 5 tests pass.

### G4. `pilot build`

- [x] Create `src/pilot/cli/build.ts`. Loads + validates plan (via `runValidate`), creates run row, spawns server, builds bus, runs single worker, shuts down.
- [x] Final summary printed BEFORE cleanup so the user-facing report doesn't interleave with shutdown noise.
- [x] Flags: `--plan` (override path), `--filter <id>` (single-id only in v0.1; rejects unknown ids), `--dry-run` (validate + summary; no execution), `--opencode-port`, `--workers` (warns if >1, runs as 1 per Phase C1's clamp).
- [x] Refactored into `runBuild(opts)` (handler) + `executeRun({db, runId, plan, ...})` (re-enterable from `pilot resume`). The executeRun split keeps build and resume sharing the same lifecycle code.
- [x] SIGINT handler aborts the worker via abortSignal, propagating through to session.abort.
- [x] Test file `test/pilot-cli-build.test.ts` (7 tests): --dry-run prints summary, schema-invalid → exit 2, missing file → exit 1, --filter unknown id, --workers > 1 clamp warning, auto-find newest plan when --plan omitted.
- [x] E2E (real opencode) gated by `OPENCODE_E2E=1` — out of scope for the unit tests.
- [x] **Verify:** 7 tests pass.

### G5. `pilot status`

- [x] Create `src/pilot/cli/status.ts`. Reads run + tasks from state DB; supports `--run <id>` (default: newest run discovered via `<pilot>/runs/*/state.db` mtime) and `--json`.
- [x] Text mode renders: run header, counts line, then one line per task with id/status/attempts/cost/branch and an indented `last_error:` block when set.
- [x] JSON mode emits `{run, tasks, counts}` for scripting consumers.
- [x] Created `src/pilot/cli/discover.ts` — shared run-discovery helper used by status/resume/retry/logs/worktrees/cost.
- [x] Test file `test/pilot-cli-status.test.ts` (5 tests): text + json + auto-discover + two error paths (no runs / unknown run id).
- [x] **Verify:** 5 tests pass.

### G6. Admin commands

- [x] `src/pilot/cli/resume.ts` — discovers latest run, reloads plan from `runs.plan_path`, re-marks running, calls `executeRun`. Doesn't reset failed tasks (use `pilot retry` first). Direct UPDATE of run.status to bypass `markRunRunning`'s state-machine guard when the run was previously terminal.
- [x] `src/pilot/cli/retry.ts` — positional `<task-id>` argument; calls `markPending` (preserves attempts/cost). Optional `--run-now` chains into `pilot resume` immediately. Exit 1 on unknown task id.
- [x] `src/pilot/cli/logs.ts` — text mode prints task header (status/attempts/cost/session/branch/wt/jsonl path) plus one line per event with kind-aware payload summarization for common kinds (task.verify.failed → exit + command, task.touches.violation → violators, etc.). `--json` emits decoded events array.
- [x] `src/pilot/cli/worktrees.ts` — `list` (filters `git worktree list --porcelain` to pilot's `<pilot>/worktrees/<runId>/...` path prefix) and `prune` (default: only succeeded tasks on a completed run; `--all` overrides; `--dry-run`).
- [x] `src/pilot/cli/cost.ts` — text mode (per-task lines + total) and `--json` mode.
- [x] Single test file `test/pilot-cli-admin.test.ts` (12 tests) covering all five subcommands with a shared seeded-DB fixture.
- [x] **Verify:** 12 tests pass. Total Phase G: 39 + 5 (validate/plan/build/status/admin) = 44 tests. Full suite 697 pass / 0 fail / 40 files; `bun run typecheck` clean; `bun run build` clean.

---

## Phase H — Plugin glue

### H1. `pilot-plugin.ts` runtime hooks

- [x] Create `src/plugins/pilot-plugin.ts` exporting a `Plugin` factory matching `autopilot.ts`/`notify.ts` shape.
- [x] Hook on `tool.execute.before`: classify session via `client.session.get` (cached per `sessionID`). If session title matches `pilot/<runId>/<taskId>` → pilot-builder; if session directory ends in `/pilot/plans` → pilot-planner; else → non-pilot (pass through).
- [x] **pilot-planner enforcement**: when tool ∈ {`edit`, `write`, `patch`, `multiedit`}, throw if target path outside the plans dir (path resolution against the session's `directory`).
- [x] **pilot-builder enforcement**: when tool = `bash`, throw if command starts with any of `git commit`, `git push`, `git tag`, `git checkout `, `git switch `, `git branch`, `git restore --source`, `git reset`, `gh pr `, `gh release ` (belt + suspenders to F1's permission map).
- [x] Throws are caught by opencode's tool runner and surfaced to the agent as a tool-result error; the message names the offending pattern + reminds the agent of the STOP protocol.
- [x] Wire into `src/index.ts` alongside `autopilotPlugin`, `notifyPlugin`, `costTrackerPlugin`. Hook is conditionally attached (matches the existing pattern for optional sub-plugin hooks).
- [x] `__test__` named export exposes internal helpers (`classifySession`, `inferPlannerPlansDir`, `enforceBuilderBashDeny`, `enforcePlannerEditScope`, `extractBashCommand`, `extractTargetPath`) for direct unit-testing without a fake SDK client setup.
- [x] Test file `test/pilot-plugin.test.ts` (44 tests): pure-helper coverage + classification (pilot-builder via title, pilot-planner via directory, non-pilot fallthrough, two-segment title rejection, classification cache, network-blip tolerance), bash-deny coverage (every forbidden prefix + benign passthrough), edit-scope coverage (inside/outside/relative path resolution, no-path-field passthrough), and 6 plugin-hook integration tests asserting the hook's behavior end-to-end.
- [x] **Verify:** 44 tests pass; full suite stays green.

---

## Phase I — Build, docs, release

### I1. Build (tsup)

- [x] `src/pilot/...` source files are picked up via transitive imports through `src/cli.ts`. No entry change needed.
- [x] `src/skills/pilot-planning/` is copied by the existing `onSuccess` step (verified: `dist/skills/pilot-planning/{SKILL.md, rules/*.md}` is in the build output).
- [x] `picomatch` resolves at runtime via the bundled output (no `external` needed).
- [x] Added `bun:sqlite` and `bun:test` to `tsup.config.ts` `external` array — they're bun runtime builtins that esbuild can't resolve. Without this the bundle fails.
- [x] **Verify:** `npm pack --dry-run` shows pilot agent prompts (`pilot-builder.md`, `pilot-planner.md`) and the full `pilot-planning/` skill tree in the tarball. Tarball weighs ~223KB / 116 files.

### I2. AGENTS.md update

- [x] Documented the `src/pilot/` source tree (full subdirectory listing including state/, worktree/, opencode/, verify/, worker/, scheduler/, cli/).
- [x] Documented that pilot agents register via `createAgents()` like every other agent (rule 10).
- [x] Documented that pilot writes only under `~/.glorious/opencode/<repo>/pilot/` (rule 1, expanded).
- [x] **Verify:** `bun test test/prompts-no-dangling-paths.test.ts` passes (15/15).

### I3. Doctor subcommand updates

- [x] Extended `src/cli/doctor.ts`: new "Pilot subsystem" section that checks git availability + `git worktree --help`, bash availability (verify-runner), and `pilot-builder` / `pilot-planner` presence in `opencode agent list`.
- [x] Test file `test/doctor.test.ts` (5 tests): captures stdout, asserts the harness header + Pilot subsystem section + git/bash/pilot-agent checks all surface.
- [x] **Verify:** 5 doctor tests pass.

### I4. Changeset + release prep

- [x] Created `.changeset/pilot-subsystem-v0-1.md` with `minor` bump, full description of the pilot subsystem (CLI surface, agents, skill, plugin, persistent state, doctor extensions, deferred limitations).
- [x] `bunx changeset status` lists `@glrs-dev/harness-opencode` as a minor bump.
- [x] **Verify:** changeset file committed under `.changeset/`.

---

## Phase J — End-to-end acceptance gate

The TRUE end-to-end gate runs against a real opencode server with model auth and is gated by `OPENCODE_E2E=1`. The synthetic acceptance test below uses the existing CLI verbs against a seeded run state to exercise the wiring layer without requiring real opencode — it's the closest thing to end-to-end the unit-test suite can provide.

- [x] **Synthetic flow** in `test/pilot-acceptance.test.ts` walks: `validate` → `build --dry-run` → seed run state → `status` (text + JSON) → `logs <task-id>` → `cost` → `retry <task-id>` → `worktrees list`. All exit codes and output shapes asserted. Documents the manual E2E checklist as a `OPENCODE_E2E=1`-gated test for operators.
- [x] Hand-written `pilot.yaml` with two tasks: covered by the synthetic test fixture (T1, T2 with deps).
- [x] `pilot validate <path>` exits 0: covered.
- [x] `pilot build --dry-run` succeeds + prints task summary: covered.
- [x] `pilot status` matches the run's actual state: covered.
- [x] `pilot retry <task-id>` resets the task to pending, preserves attempts/cost: covered.
- [x] `pilot logs <task-id>` prints session id + JSONL path + structured events: covered.
- [x] `pilot worktrees list` enumerates worktrees: covered (synthetic run has no real worktree, so the test asserts the "no pilot worktrees" message — the wiring is exercised).
- [x] `pilot cost` reports per-task and total: covered ($0.42 + $1.10 = $1.52).
- [ ] **`OPENCODE_E2E=1` real run** — `pilot plan ENG-XXXX` end-to-end with the planner agent; `pilot build` executing real tasks via the worker against a real opencode server. **Operator action required**; not part of unit-test coverage. Checklist documented in `test/pilot-acceptance.test.ts`.

---

## Phase K — Final checks before ship

- [x] `bun run build` clean.
- [x] `bun run typecheck` clean.
- [x] `bun test` — **748 pass / 0 fail** across 43 files.
- [x] `npm pack --dry-run` shows the full pilot subtree in the tarball (pilot agents, pilot-planning skill SKILL.md + 7 rules, bundled `dist/cli.js` + `dist/index.js`). Tarball weighs ~223KB / 116 files.
- [x] `test/prompts-no-dangling-paths.test.ts` clean (no `~/.claude` etc. in pilot prompts/skill rules — 15 tests pass).
- [x] `test/skills-bundle.test.ts` clean (12 tests; pilot-planning's 8 files asserted).
- [x] `test/agents.test.ts` clean (59 tests covering pilot-planner + pilot-builder shape, mode, model, temperature, permissions including the destructive bash denies + question deny).
- [x] CHANGELOG entry will be auto-generated by changesets from `.changeset/pilot-subsystem-v0-1.md` on the next "Version Packages" PR. The changeset prose names the agents, skill, plugin, persistent-state location, doctor extensions, and known v0.1 limitations — readable to a fresh reader.
- [ ] **Manual smoke** (operator action): install the packed tarball into a throwaway `opencode.json`; run `pilot --help`; run `pilot plan` and confirm the planner agent loads. Out of scope for the unit-test suite.

---

## Out-of-scope for this release (track for v0.3+)

These are explicitly deferred:

- [ ] Multi-worker pool with intra-DAG parallelism (v0.3).
- [ ] Picomatch-driven worktree-pool conflict scheduling (v0.3 — algorithm exists from A4 but only used at runtime in v0.3).
- [ ] Ink TUI for `pilot status --watch` (v0.4).
- [ ] Slack notifications (v0.4).
- [ ] `--unattended` strict-mode flag beyond current implicit unattended-by-default (v0.4).
- [ ] Cost-cap preemption mid-task (v0.4).
- [ ] PR creation (`pilot ship` or integration with `/ship`) — separate decision.
- [ ] Linear/GitHub MCP "optional" formalization for the planner agent.
