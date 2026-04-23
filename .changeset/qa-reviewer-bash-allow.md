---
"@glrs-dev/harness-opencode": patch
---

Simplify `bash` permission for `qa-reviewer`, `qa-thorough`, and `autopilot-verifier` to the plain string `"allow"`, removing the agent-level object-form rule-map. Eliminates a recurring permission-ask prompt on read-only pipelined commands (e.g. `git show <ref>:<path> | sed -n 'N,Mp'`) during review runs — the OpenCode runtime was apparently misfiring on pipelined shapes despite the catch-all `"*": "allow"` rule, and the agent-level deny list was defense-in-depth anyway.

Destructive-command safety is retained at two layers:

- **Global layer:** the `permission.bash` block in `applyConfig` (src/index.ts) continues to deny `git push --force*`, `rm -rf /*`, `rm -rf ~*`, `chmod *`, `chown *`, `sudo *` for every agent that doesn't override it. A new regression test locks this safety net in place.
- **Agent-prompt layer:** each read-only reviewer's system prompt explicitly forbids mutating history, force-pushing, or touching the filesystem root.

Other subagents are unchanged: `plan-reviewer`, `code-searcher`, `gap-analyzer`, `architecture-advisor`, and `lib-reader` keep `bash: "deny"`; `agents-md-writer` keeps `bash: "ask"`; `orchestrator` and `build` (primary agents) keep their object-form bash maps.

Plan: `.agent/plans/qa-reviewer-bash-allow.md` (7/8 ACs [x] — a8 is this changeset).
