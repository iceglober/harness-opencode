---
"@glrs-dev/harness-opencode": minor
---

Add `agent-estimation` bundled skill. Teaches agents to estimate task effort in tool-call rounds first (with a structured module-breakdown table and risk coefficients) and convert to human wallclock only at the final step. Avoids the systematic overestimation that happens when agents anchor to human-developer timelines absorbed from training data. Adapted from https://openclawlaunch.com/skills/agent-estimation.
