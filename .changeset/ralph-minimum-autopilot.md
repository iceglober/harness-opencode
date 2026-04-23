---
"@glrs-dev/harness-opencode": minor
---

Simplify `/autopilot` to the canonical Ralph loop. The previous implementation had grown to a 1344-line plugin, a 227-line prompt, a 9-rule orchestrator carve-out, and a 13-field per-session state machine with five independent "exit detectors." A recent failure session showed the plugin fighting the orchestrator for control and firing stale nudges on a non-autopilot session. The architecture had drifted far from the Ralph pattern it was modeled on (`while :; do cat PROMPT.md | claude-code ; done` — one prompt, stateless agent, filesystem is the state).

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
