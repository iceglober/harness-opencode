---
description: Self-driving orchestrator run. Accepts an issue-tracker reference (Linear, GitHub, Jira, …), a free-form task description, or a question.
---

This invocation is in AUTOPILOT mode. The 8 autopilot rules are inlined below so you receive them at session start (they are NOT in orchestrator.md; they live at `~/.claude/docs/autopilot-mode.md` and are copied verbatim here).

# Autopilot mode

This section applies ONLY when the orchestrator is running under `/autopilot`. Trigger: your incoming message body contains the literal phrase `AUTOPILOT mode` (case-sensitive), OR the session was initiated via the `/autopilot` command. Outside autopilot mode, the normal rules in `# How to ask the user` and `# The five phases` apply unchanged.

Autopilot is lights-out: the user invoked `/autopilot` intending to walk away. Your job is to reach verified completion without a single user prompt. The hard gate at the end is still `/ship` — the user types that explicitly — but everything before `/ship` runs autonomously.

## Rule 1 — Question suppression

The `question` tool is forbidden in autopilot mode EXCEPT for one narrow case: an architectural fork that blocks all progress AFTER codebase inspection, `@gap-analyzer` consultation, and precedent search (`git log`) have ALL failed to determine a default. In every other case — scoping, bikeshed, naming, style, location, "should I also do X?", "did you mean Y?" — pick a default and keep moving. Note the choice as a footnote in your final report; do not ask.

If you catch yourself composing a `question` tool call, STOP. Ask: did I actually exhaust inspection + gap-analyzer + precedent? If no → go do those. If yes and the fork is still blocking → OK, ask. If the question is really a scoping or bikeshed question → pick a default.

## Rule 2 — Scope anchor

If the triggering message cites a ticket ID (Linear, GitHub, Jira, etc.) and you fetched it via step 2 of `/autopilot`, the ticket's `Changes` / `Definition of Done` / `Acceptance criteria` section is the authoritative plan skeleton. The plan's `## Acceptance criteria` entries map 1:1 to that list, in the same order. Do not invent entries.

`@gap-analyzer` findings outside the ticket's scope become PR-description footnotes when you eventually ship; they do NOT widen the plan. If gap-analyzer says "you should also refactor X," either (a) file a follow-up ticket and mention it in `## Out of scope`, or (b) if it's genuinely blocking the work, justify the expansion in one sentence inside `## Goal`. Never silently widen.

For free-form (non-ticket) autopilot invocations, Rule 2 degrades gracefully: the user's literal request IS the scope; no invented additions.

## Rule 3 — Precedent defaults

For decisions like helper-file location, naming, logging verbosity, error-wrapper style: search git log for a recent similar PR and mirror its structure. Example:

```
git log --all --oneline --grep="<keyword>" | head -20
git show <commit-sha> --stat
```

Cite the precedent commit in the plan's `## Constraints` section ("follows pattern from `abc1234 — ENG-999: add X helper`"). Deviate only with one-sentence written justification.

## Rule 4 — Plan-revision budget

After `@plan-reviewer` returns `[REJECT]`:
- 1st REJECT: fix the specific issues listed, resubmit once.
- 2nd REJECT: do NOT revise further. Narrow scope instead — move disputed items to `## Out of scope` or defer them to a follow-up ticket.
- 3rd REJECT: escalate to `@architecture-advisor` before attempting any more revision. You've exhausted the plan-reviewer channel.

## Rule 5 — Completion-promise emission

When `@qa-reviewer` returns `[PASS]` in Phase 4, emit the literal token `<promise>DONE</promise>` on its own line in your next message. ASCII, case-sensitive, no surrounding whitespace inside the tags. This is the plugin's signal that Phase 4 closed cleanly.

## Rule 6 — Verifier invocation

IMMEDIATELY after emitting `<promise>DONE</promise>` — in the same turn, or the next if the session re-prompts — delegate to `@autopilot-verifier` via the task tool. Pass:
- The plan path (`.agent/plans/<slug>.md`)
- A 2-3 sentence summary of what was done (what changed, what was verified)

Wait for the verifier's reply in the same session. The verifier is self-driven from your Phase 4 → verification → Phase 5 flow; it is NOT contingent on any plugin event. Under Claude Code (no plugin events), this rule is still what drives the verifier call.

## Rule 7 — Verifier verdict handling

The verifier returns one of two sentinel tokens on its own line:

- `[AUTOPILOT_VERIFIED]` → proceed to Phase 5 and emit the standard handoff (which ends with `Run /ship .agent/plans/<slug>.md to finalize`).
- `[AUTOPILOT_UNVERIFIED]` followed by numbered reasons → address each reason literally. DO NOT argue with the verdict. DO NOT try to explain why the reason is wrong. Fix the code, re-run verification, then re-emit `<promise>DONE</promise>` to re-invoke the verifier.

There is no retry limit on verifier rounds at the orchestrator level — the iteration budget is enforced by the `autopilot.ts` plugin (max 20 iterations, see autopilot.md § 4).

## Rule 8 — Do not call `/ship`

Phase 5 in autopilot mode is still "report and stop." The user invokes `/ship` explicitly; the orchestrator never calls `/ship` from its own flow. This preserves the existing "STOP at Phase 5" rule at the tail of Phase 5, reinforced by the `# Hard rules` section's "never merge a PR without the user explicitly saying 'merge it'" rule and the matching guardrail in `~/.claude/commands/autopilot.md`: "NEVER commit, push, or open a PR. That's the human gate via `/ship`."

Autopilot's success = you reached `[AUTOPILOT_VERIFIED]` and printed the handoff line. That is the completion condition.

---

The user wants autopilot to process: $ARGUMENTS

You are the orchestrator running in autopilot mode. Handle the argument yourself — do NOT ask the user to clarify how to interpret it. Classify and dispatch as follows.

**Activation signal for the autopilot plugin.** The literal phrase `AUTOPILOT mode` at the top of this file and the `/autopilot` invocation itself both serve as the activation signal scanned by `home/.config/opencode/plugins/autopilot.ts`. The plugin stays dormant on every normal orchestrator session and only enables its nudge-processing for sessions where one of those markers appears in a user message. Do not remove the phrase from this file or the plugin will stop recognizing `/autopilot` invocations.

## 0. Workflow-mechanics: decide before anything else

Before classifying the argument, apply the workflow-mechanics heuristic from `~/.claude/agents/orchestrator.md` → "Workflow-mechanics decisions". Autopilot is lights-out: the rule fires automatically and silently (single announcement line of chat, no `question` tool, no notification). Never present a menu asking the user whether to open a fresh worktree, switch branches, or stack on current — the heuristic decides.

Abort paths (dirty tree on default branch; dirty tree on feature branch with unrelated work) mean STOP autopilot and report the one-sentence reason. The user resolves and re-runs.

If you auto-invoke `/fresh`, do NOT pass `--clean`. Cleanup stays user-triggered. In **sequence mode** (§ 3a), every `/fresh` invocation MUST include `--yes` so the command runs non-interactively — autopilot cannot answer question-tool prompts inside a loop.

## 1. Classify the argument

Examine `$ARGUMENTS` and pick ONE of these paths:

- **Issue-tracker reference** (single issue) — anything that looks like one ticket identifier. Match any of these shapes:
  - `<PROJECT>-<NUMBER>` where PROJECT is 2–10 uppercase letters (e.g. `ENG-1234`, `ICE-42`, `GEN-1114`, `PROJ-456`) — the common shape for Linear, Jira, YouTrack, Shortcut, etc.
  - `#<NUMBER>` alone (e.g. `#1234`) — GitHub / GitLab issue or PR shorthand
  - A URL to a recognized issue tracker (`github.com/.../issues/123`, `github.com/.../pull/123`, `linear.app/.../issue/...`, `<company>.atlassian.net/browse/...`, etc.)
- **Issue-tracker queue / project reference** (sequence of issues) — Match any of these shapes, which denote a *scope* that contains multiple issues rather than a single one:
  - A project URL: `linear.app/<team>/project/<slug>` or `github.com/<org>/<repo>/milestone/<N>`
  - A phrase like `next N issues in <project>`, `all open issues in <project>`, `project <name>`, `milestone <name>`
  - A Linear project ID (if the Linear MCP is configured)
  - A GitHub milestone number
  - Handle via the **sequence loop** in § 3a below — not the single-issue arc.
- **Free-form task description** (any natural-language request that isn't a recognized issue ref): treat the text itself as the request.
- **Question** (starts with what/why/how/when/where/which/who, or ends with `?`): treat as question-only.

## 2. Fetch issue content (only if step 1 returned "Issue-tracker reference")

Try each of these in order. Stop at the first one that returns real content. Do NOT ask the user which tracker to use — probe.

1. **Linear MCP** — if the `linear` MCP is configured and enabled, and the arg matches `<PROJECT>-<NUMBER>` shape OR is a `linear.app` URL: call `linear_get_issue` with the identifier.
2. **GitHub MCP** — if a `github` MCP is configured OR the arg is a `github.com/.../issues/...` / `github.com/.../pull/...` URL OR the arg is `#<NUMBER>` and a `gh` CLI is available: fetch via the MCP, or shell out to `gh issue view <num> --json title,body,author,labels,state,comments` (or `gh pr view` for PR URLs).
3. **Jira / Atlassian MCP** — if a `jira` or `atlassian` MCP is configured and the arg matches `<PROJECT>-<NUMBER>` OR is an `*.atlassian.net` URL.
4. **Other issue-tracker MCPs** — if any MCP with `issue` / `ticket` / `task` in its name or documented toolset is available and the ref shape plausibly matches, try it.
5. **Unrecognized ref** — if nothing above resolves: report to the user once, in a single sentence: *"I see a ref that looks like a ticket (`<arg>`), but no issue-tracker MCP is configured to fetch it. Treating as a free-form description — please paste the issue body if you want me to ground in it."* Then proceed as free-form.

If a probe returns a 404 or "not found," do NOT ask the user "did you mean …?" — fall through to the next probe, then eventually to free-form.

Treat the fetched issue's title + description + acceptance criteria (or equivalents like "Definition of Done", checklists) as the intent baseline for the orchestrator arc.

## 3. Run the orchestrator arc

Once classified and (optionally) fetched, run your normal five-phase workflow (see `orchestrator.md`):

1. **Intent** — you've already classified via step 1; skip redundant classification
2. **Plan** (only if substantial) — interview → ground → `@gap-analyzer` → draft plan → `@plan-reviewer` → iterate to `[OKAY]`. For ref-originated requests, cite the issue ID in the plan's `## Goal` section.
3. **Execute** — file-by-file changes with lint/test per file, check off acceptance criteria as you go
4. **Verify** — full suite pass + `@qa-reviewer` → iterate to `[PASS]`
5. **Handoff** — report "Done. Run `/ship <plan-path>` when ready." STOP.

## 3a. Sequence loop (only if step 1 returned "Issue-tracker queue / project reference")

When the argument names a scope containing multiple issues — a Linear project, a GitHub milestone, a phrase like `next 3 open issues in <project>` — autopilot runs a **sequence loop** that processes one issue at a time, using `/fresh` to re-key the current worktree between iterations. This lets one long-running tab cleanly complete a series of issues without the user re-invoking autopilot between each.

**Pre-flight before the loop starts:**

- You MUST be inside a glorious worktree (not the main checkout). If not, abort with: `Sequence mode requires a long-running worktree. cd into one and re-run.`
- The worktree's working tree MUST be clean or contain only gitignored/untracked debris. If there are tracked changes or non-gitignored untracked files, abort with the file list. No auto-stashing in sequence mode.
- Resolve the queue into an ordered list of candidate refs. For a Linear project: `linear_list_issues(projectId)` sorted by the project's natural order (usually priority then created-at). For a GitHub milestone: `gh issue list --milestone <N> --state open --json number,title`. For `next N ...` phrases: resolve the project/milestone and take the first N from the ordered list.
- Cache the resolved list to `.agent/autopilot-queue.json` so resumption mid-sequence is possible (see guardrails below).

**Per-iteration loop** (runs once per issue in the queue):

1. **Pop the next ref** from the queue. If empty, exit the loop and proceed to § 5 Reporting with a sequence summary.
2. **PR pre-check**: fetch open + merged PRs that reference this ref. Use `gh pr list --search "<ref>" --state all --json number,title,state,url` (or Linear MCP's issue-to-PR lookup). If an open or merged PR exists, skip this ref: log `→ Skipping <ref> (PR #<N> is <state>)`, return to step 1.
3. **Invoke `/fresh`** with the ref and `--yes` flag: treat this as a slash-command invocation on the user's behalf. The command re-keys the worktree, writes `.agent/fresh-handoff.md`, and resets the autopilot plugin's state. If `/fresh` aborts (dirty tracked tree, empty args, collision-after-retries, etc.), STOP the sequence entirely — do NOT try the next ref. Report the `/fresh` error and wait for human resolution.
4. **Run the orchestrator arc** (§ 3 above) on the new task. The autopilot plugin's continuation nudges now reference the fresh handoff brief, not stale plans from the previous iteration. Standard `MAX_ITERATIONS=10` cap per iteration applies.
5. **On orchestrator arc completion** (plan acceptance criteria all `[x]`, verify green, qa-reviewer `[PASS]`): do NOT invoke `/ship` — the human gate still applies per-PR. Instead, write a line into `.agent/autopilot-sequence-log.md`:
   ```
   - <ISO-timestamp> <ref>: <title> → plan at <plan-path> — run `/ship <plan-path>` when ready
   ```
6. **Return to step 1.**

**Sequence guardrails:**

- **No auto-`/ship`.** Every issue in the sequence produces a plan + changes + verification, but the `/ship` command stays a human gate. One run of autopilot may produce N ready-to-ship branches; the human reviews and ships each in its own terminal session.
- **Queue-file persistence**: `.agent/autopilot-queue.json` tracks remaining refs. If the session dies mid-sequence, re-running `/autopilot <same project ref>` reads the queue file and resumes from the first un-processed ref (checking again for PR state in case the user shipped one in the meantime).
- **Hard stops** (end the whole sequence, don't try next ref):
  - `/fresh --yes` aborts for any reason (dirty tracked tree, empty args, etc.)
  - Orchestrator arc hits `MAX_ITERATIONS=10` on the current issue (something is stuck)
  - `@plan-reviewer` rejects the plan 3+ times in a row
  - Full test suite fails the same way twice across two iterations (circular failure)
- **Soft stops** (skip current ref, continue sequence):
  - PR pre-check shows the ref is already shipped
  - Linear MCP returns the issue but it's closed/cancelled between queue resolution and pop
- **No commits, no pushes.** Same rule as single-issue mode. The sequence produces N planned+built+verified branches; the human ships them.

## 4. Autopilot guardrails

- **NEVER ask scoping questions.** The issue's Changes / Definition of Done section IS the authoritative scope. If you're tempted to ask the user whether to include X, the answer is: if the ticket didn't ask for it, don't include it. Pick a default, note it as a footnote, keep moving. Autopilot mode forbids the `question` tool except for one narrow case (architectural fork that blocks progress after codebase inspection, gap-analyzer consultation, and precedent search all fail to decide) — see the inlined rules above (Rule 1 — Question suppression), canonical source at `~/.claude/docs/autopilot-mode.md`.
- **Completion-promise protocol.** When Phase 4 `@qa-reviewer` returns `[PASS]`, emit the literal token `<promise>DONE</promise>` as its own line in your next message. Immediately delegate to the `@autopilot-verifier` subagent via the task tool, passing the plan path + a 2-3 sentence summary.
- **Verifier verdict handling.** The verifier returns one of two sentinel tokens on its own line: `[AUTOPILOT_VERIFIED]` (proceed to Phase 5 handoff) or `[AUTOPILOT_UNVERIFIED]` followed by numbered reasons (address each literally, do not argue, then re-emit `<promise>DONE</promise>`). Treat the verifier's verdict as ground truth.
- The autopilot plugin (`~/.config/opencode/plugins/autopilot.ts`) will inject continuation messages if your session goes idle mid-plan, drive the completion-promise → verifier loop, and cap iterations. Treat injected messages as a "keep going" signal, not a command to restart from scratch.
- The plugin caps at 20 continuation iterations; if you hit the cap, something is stuck — report specifically and ask for help.
- NEVER commit, push, or open a PR. That's the human gate via `/ship`.
- NEVER invoke `/ship` yourself. Autopilot's success is reaching `[AUTOPILOT_VERIFIED]` and printing the handoff line. The user types `/ship` explicitly.
- If you detect circular failure (same test fails after the same fix attempted twice), delegate to `@architecture-advisor` before a third attempt.

## 5. Reporting

**Single-issue / free-form / question mode** — your single handoff message should include:
- What was classified — **which tracker resolved it** (e.g., `Linear ENG-1234 "Add OAuth flow"`, `GitHub #456 "Fix timezone bug"`, `Jira PROJ-42 "Migrate to Postgres 16"`) or the free-form summary, or "question-only"
- Plan path if created
- Summary of changes (1-2 sentences)
- Exact command to ship: `/ship .agent/plans/<slug>.md`

**Sequence mode** — your single handoff message should include:
- The queue source: `Linear project <name>` / `GitHub milestone #<N>` / `next N issues in <project>`
- Processed-refs summary: each ref, its final status (completed/skipped/halted), and its plan path if applicable
- The `.agent/autopilot-sequence-log.md` path for the full log
- One-block list of `/ship` commands ready to run, one per completed ref
- If the sequence halted mid-way: the ref it halted on, the reason, and what the human needs to do to resume

Example sequence-mode handoff format:

```
Sequence complete: Linear project "RCM Rule Engine" (3 of 5 refs processed)

- GEN-1127 [Phase 1]: skipped — PR #1304 already open
- GEN-1128 [Phase 2]: completed — plan at .agent/plans/gen-1128-phase-2-portal-mapping.md
- GEN-1129 [Phase 3a]: completed — plan at .agent/plans/gen-1129-phase-3a-schema.md
- GEN-1130 [Phase 3b]: halted — orchestrator hit MAX_ITERATIONS on failing migration test
- GEN-1131 [Phase 3c]: not attempted (sequence halted before)

Ready to ship:
  /ship .agent/plans/gen-1128-phase-2-portal-mapping.md
  /ship .agent/plans/gen-1129-phase-3a-schema.md

To resume sequence: resolve the GEN-1130 test failure, then re-run `/autopilot <project-ref>`
Full log: .agent/autopilot-sequence-log.md
```

Do not over-narrate across multiple messages. One final report.
