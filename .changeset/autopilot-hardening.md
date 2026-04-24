---
"@glrs-dev/harness-opencode": patch
---

Autopilot hardening: silent circuit breakers against umbrella plans, wrong-branch work, and stuck loops

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
