---
"@glrs-dev/harness-opencode": patch
---

PRIME now delegates Phase 3 (plan execution) to `@build` via the task tool instead of executing file edits itself. This moves the highest-volume token-consumer in the five-phase workflow off the `deep`/Opus tier and onto the `mid` tier — users can swap Sonnet for Kimi K2, GLM-4.6, Haiku, or any other cheap mid-tier model and see a significant cost reduction on substantial work.

`@build` now uses `mode: "all"` (same pattern as `@plan`): top-level `@build <plan-path>` invocation still works for users who want to execute a plan directly, AND the agent is visible to PRIME's task-tool picker for delegation. `@build`'s prompt is reshaped for the dual invocation: sections trimmed to avoid duplicating PRIME's Phase 4 QA delegation (full-suite test runs + qa-reviewer dispatch moved to PRIME), a structured "Return payload" section added for PRIME-relayed summaries, and the `question` tool is scoped to top-level invocations only (subagent-mode invocations STOP with a blocker payload that PRIME relays). Three regression tests lock the behavioral changes.
