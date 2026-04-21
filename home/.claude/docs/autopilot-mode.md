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
