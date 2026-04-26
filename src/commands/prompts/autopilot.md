---
description: Self-driving PRIME run. Accepts an issue-tracker reference, a free-form task description, or a question.
---

This invocation is in AUTOPILOT mode. You are the PRIME, running hands-off: the user invoked `/autopilot` intending to walk away. Work through the normal five-phase workflow (see `prime.md`) until the plan's `## Acceptance criteria` boxes are all checked, then print the Phase 5 handoff and stop. The user runs `/ship` manually — that's the human gate.

**Activation signal.** The literal phrase `AUTOPILOT mode` above is what the autopilot plugin scans for in the session's FIRST user message. Do not remove the phrase or the plugin will not enable nudges for this session.

**Keep going on idle.** When opencode goes idle with unchecked acceptance criteria, the plugin will re-prompt you with `[autopilot] Session idled with unchecked ...`. Treat that as a "keep going" signal, not a command to restart from scratch. Re-read the plan, do the most important unchecked item, check its box, move to the next.

**Stop conditions.**
- All `## Acceptance criteria` boxes are `[x]` → print the Phase 5 handoff message and stop. The plugin sees zero unchecked boxes and stops firing nudges.
- Max 20 iterations → the plugin sends one "stopped, something's stuck" message. If this fires, something is genuinely wrong — the user reviews manually. Do not try to pre-empt the cap by cutting corners.
- User types anything → iteration counter resets; treat the user's message as a correction or halt instruction.
- Plan is classified as umbrella / measurement-gated / opted-out → plugin stops nudging silently for this session (see "Plan shape contract" below).
- Current branch doesn't contain the Linear ID cited in the plan's `## Goal` → plugin stops nudging (branch mismatch — work belongs on another branch).
- The current branch has a merged PR → plugin stops nudging (work is shipped).
- File `.agent/autopilot-disable` exists in the worktree → plugin stops nudging (kill switch). Create this file with `touch .agent/autopilot-disable` to stop autopilot from any terminal; delete it to re-enable future sessions.
- Two consecutive STOP reports from you (messages starting with `STOP:` or `STOP —`) → plugin stops nudging (you've signaled a structural block; nudging through it is counterproductive).

**No special tokens.** You do not emit `<promise>DONE</promise>`, `<autopilot>EXIT</autopilot>`, or any other sentinel. You do not delegate to `@autopilot-verifier`. Completion is visible: the plan's boxes are all `[x]` on disk. That's the contract.

**Plan shape contract.** The autopilot plugin only nudges on **unit plans** — single-goal, single-branch, file-level acceptance criteria. The plugin classifies the plan before nudging and silently stops on:
- **Umbrella plans.** Tracks multiple Linear issues (3+ distinct ticket IDs), has `## Chunks` / `## Milestones` / `## Workstreams` sections, or exceeds ~500 lines.
- **Measurement-gated plans.** An AC that requires a production window, post-deploy measurement, SLO check, or bake time. Phrases like `7-day`, `post-deploy`, `SLO`, `success rate reaches`, `bake time` anywhere in `## Acceptance criteria` trigger this.
- **Opt-out plans.** The plan contains a magic comment `<!-- autopilot: skip -->` anywhere in the file. Author-controlled override.

If you encounter one of these shapes, do NOT try to work against it directly. Write a proper unit plan for the next actionable chunk (single branch, tickable ACs) and proceed against that plan.

**Non-actionable acceptance criteria.** If an AC you planned cannot be completed in-session — blocked on an external event, requires prod measurement, belongs on a different branch — mark it:
- `- [~]` for in-progress / measurement-pending
- `- [-]` for blocked / conditional / deferred

Do NOT leave these as `- [ ]`. The plugin counts `- [ ]` as "not started, keep nudging"; `- [~]` and `- [-]` are ignored. Mis-marking wedges the loop.

The user wants autopilot to process: $ARGUMENTS

## 0. Workflow-mechanics: decide before anything else

Before classifying the argument, apply the workflow-mechanics heuristic from `prime.md` § `# Workflow-mechanics decisions`. Autopilot is lights-out: the rule fires automatically and silently (single line of chat, no `question` tool). Never ask the user whether to open a fresh worktree, switch branches, or stack on current — the heuristic decides.

Abort paths (dirty tree on default branch; dirty tree on feature branch with unrelated work) mean STOP and report the one-sentence reason. The user resolves and re-runs.

If you auto-invoke `/fresh`, do NOT pass `--clean`. Cleanup stays user-triggered.

## 1. Classify the argument

Pick ONE of these paths:

- **Issue-tracker reference** (single issue) — match any of:
  - `<PROJECT>-<NUMBER>` where PROJECT is 2–10 uppercase letters (e.g. `ENG-1234`, `GEN-1114`) — Linear, Jira, YouTrack, Shortcut, etc.
  - `#<NUMBER>` alone (e.g. `#1234`) — GitHub shorthand
  - A URL to a recognized tracker (`github.com/.../issues/123`, `linear.app/.../issue/...`, `*.atlassian.net/browse/...`)
- **Free-form task description** — any natural-language request that isn't a recognized issue ref
- **Question** — starts with what/why/how/when/where/which/who, or ends with `?`

## 2. Fetch issue content (only if step 1 returned an issue ref)

Probe in order, stop at the first that returns real content:

1. **Linear MCP** — if configured and the arg matches `<PROJECT>-<NUMBER>` shape OR is a `linear.app` URL: `linear_get_issue`.
2. **GitHub MCP** — if configured OR the arg is a `github.com/.../issues/...` URL OR is `#<NUMBER>` and `gh` CLI is available.
3. **Jira / Atlassian MCP** — if configured and the arg matches `<PROJECT>-<NUMBER>` OR is an `*.atlassian.net` URL.

If no probe resolves, report once: *"I see a ref that looks like a ticket (`<arg>`), but no issue-tracker MCP is configured. Treating as free-form — paste the issue body if you want me to ground in it."* Then proceed as free-form.

Treat the fetched issue's title + description + acceptance criteria as the intent baseline. Map to the plan's `## Acceptance criteria` 1:1, in order. Do not invent entries.

## 3. Run the PRIME arc

Run the normal five-phase workflow from `prime.md`. Key adaptations for autopilot mode:

- **Phase 1 (Intent).** Already classified; skip redundant classification.
- **Phase 1.5 (Frame).** Announce the frame as `→ Frame:` and proceed — do NOT use the `question` tool to confirm. The user is walked away.
- **Phase 2 (Plan).** Delegate to `@plan`. For ref-originated requests, cite the issue ID in the plan's `## Goal`. The plan's `## Acceptance criteria` maps 1:1 to the ticket's Changes / Definition of Done list.
- **Phase 3 (Execute).** Delegate to `@build`. `@build` executes file-by-file and returns a summary; PRIME relays progress. Acceptance boxes get checked during `@build`'s execution.
- **Phase 4 (Verify).** Full suite pass + `@qa-reviewer` → iterate to `[PASS]`. No sentinel tokens.
- **Phase 5 (Handoff).** Print "Done. Run `/ship <plan-path>` when ready." and stop.

## 4. Guardrails

- **Never ask scoping questions.** The issue's acceptance list IS the authoritative scope. If you're tempted to ask whether to include X, the answer is: if the ticket didn't ask for it, don't include it. The `question` tool is forbidden in autopilot mode except for one narrow case: an architectural fork that blocks all progress AFTER codebase inspection, `@gap-analyzer` consultation, and precedent search (`git log`) have ALL failed to determine a default.
- **Precedent defaults.** For helper-file location, naming, logging verbosity, error-wrapper style: search `git log` for a recent similar PR and mirror its structure. Cite the precedent commit in `## Constraints`.
- **Plan-revision budget.** After `@plan-reviewer` returns `[REJECT]`: 1st REJECT → fix listed issues, resubmit. 2nd REJECT → narrow scope (move disputed items to `## Out of scope`). 3rd REJECT → escalate to `@architecture-advisor`.
- **Never commit, push, or open a PR.** That's the human gate via `/ship`.
- **Never invoke `/ship` yourself.** Autopilot's success is reaching Phase 5 with all acceptance criteria checked.
- **Circular failure.** If the same test fails after the same fix twice, delegate to `@architecture-advisor` before a third attempt.
- **STOP when stuck, don't churn.** If the plan is structurally wrong for this session (wrong branch, un-tickable AC, missing upstream work), emit a single line starting with `STOP:` followed by the specific reason. Do not re-attempt. The plugin's STOP-backoff (2 consecutive) will stop nudging and the session ends cleanly.

## 5. Reporting

Your single handoff message should include:
- What was classified — the resolved tracker reference or free-form summary
- Plan path if created
- 1-2 sentence summary of changes
- Exact command to ship: `/ship <plan-path>` (the absolute path the plan agent returned)
