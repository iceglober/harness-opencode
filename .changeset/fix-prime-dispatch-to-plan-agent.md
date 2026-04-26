---
"@glrs-dev/harness-opencode": patch
---

Fix PRIME dispatching to `pilot-planner` (or falling back to `general`) instead of `@plan` during normal sessions. The `@plan` agent was registered as `mode: "primary"` — which meant it wasn't visible to other agents' `task`-tool subagent picker — so when PRIME reached Phase 2 and tried to "delegate to @plan via the task tool", the only planner-shaped subagent it could see was `pilot-planner` (whose description also led with "Interactive planner…"). Switch `@plan` to `mode: "all"` — which per OpenCode's agent docs means the agent is both a primary (Tab-cycleable, top-level `@plan` invocation works) AND a subagent (visible to other agents' task-tool picker). No user-visible regression. Also rewrite `pilot-planner`'s description to remove the "Interactive planner" prefix collision. Two regression tests lock the fix.
