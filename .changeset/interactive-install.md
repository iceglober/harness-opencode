---
"@glrs-dev/harness-opencode": minor
---

feat: interactive `install-plugin` with model provider and MCP prompts

`glrs-oc install-plugin` now walks users through model provider selection (Anthropic direct, AWS Bedrock, Google Vertex, or keep defaults) and optional MCP toggles (Playwright, Linear). Choices are written to `opencode.json` via non-destructive merge. Non-interactive terminals skip prompts and use defaults.

Also adds `promptChoice` and `promptMulti` helpers to `plugin-check.ts`, and updates the README with progressive disclosure (quick start → workflow examples → detailed reference).
