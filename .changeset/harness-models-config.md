---
"@glrs-dev/harness-opencode": minor
---

Add `harness.models` config for tier-based and per-agent model overrides

Introduces a `harness.models` key in `opencode.json` that lets users override which LLM model each agent uses, either by tier (`deep`, `mid`, `fast`) or per-agent name. Tier assignments cover all 12 agents; per-agent overrides win over tier. No change for users who don't set the key — all agents keep their plugin defaults.
