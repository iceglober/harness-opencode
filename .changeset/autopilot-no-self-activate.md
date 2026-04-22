---
"@glrs-dev/harness-opencode": patch
---

Close a self-activation loophole in autopilot mode. The orchestrator was occasionally emitting `<promise>DONE</promise>` and delegating to `@autopilot-verifier` in sessions that were NOT invoked via `/autopilot` — symptoms of the orchestrator self-diagnosing into autopilot mode from ambient text (descriptive references to `/autopilot` or `AUTOPILOT mode` in prompt files, plan files, PR descriptions, etc.).

Two-layer fix:

- **Orchestrator prompt (primary)** — `src/agents/prompts/orchestrator.md` § `# Autopilot mode` rewritten. The activation clause is narrowed from "incoming message body contains the phrase" to "the session's FIRST user message was `/autopilot <args>` or contains the literal marker `AUTOPILOT mode` that the `/autopilot` command injects." An explicit non-trigger list enumerates the false-positive sources (reading prompt files, plan files, PR descriptions, session transcripts of other sessions, prior assistant messages, documents that mention the marker descriptively). A new self-check principle states: *"If you are unsure whether you are in autopilot mode, you are not."* A new hard rule at the top of `# Hard rules` forbids emitting `<promise>DONE</promise>`, `<autopilot>EXIT</autopilot>`, or delegating to `@autopilot-verifier` outside a user-invoked `/autopilot` session. The Phase 4 description gains a clarifying negation so the `[PASS]` → `<promise>DONE</promise>` + verifier delegation path is explicitly gated on autopilot mode being active.

- **Plugin (defense in depth)** — `src/plugins/autopilot.ts` `detectActivation` Signal 1 is tightened to check ONLY the first user message in the session for the activation marker, rather than scanning every user message. A marker appearing in a later user message is treated as either quoted context, a subsequent turn in an already-activated session (handled by the monotonic `enabled` flag), or a prompt-injection attempt — none of which should retroactively activate a non-`/autopilot`-initiated session. Signal 2 (fresh-handoff transition via `/plan-loop`) is unchanged; it's independent of user-message content.

No migration required — the `/autopilot` slash command always lands in the first user message, so legitimate autopilot sessions are unaffected. Sessions that were wrongly self-activating now proceed through the normal five-phase workflow without firing completion-promise + verifier rituals. 6 new tests lock in the tightened gate (`test/autopilot-plugin.test.js`, 110 total tests now pass).
