---
"@glrs-dev/harness-opencode": patch
---

Detect pre-#100 legacy model-override IDs at runtime and in `doctor`.

Before PR #100, the installer suggested stale model IDs like `bedrock/claude-opus-4` (no `anthropic.` subpath, no minor-version digit). These IDs never resolved in OpenCode, so any user who kept their pre-#100 `options.models` block saw agents crash with `ProviderModelNotFoundError` at the first subagent invocation — most visibly on `pilot-planner` and `qa-reviewer`, whose tier overrides get stomped first.

The plugin now runs a conservative offline pattern validator on every override it applies in `resolveHarnessModels()`. On invalid IDs it emits a single-line warn (deduped per unique bad value) naming the offending key (`models.deep`, `models.pilot-planner`, etc.) and suggesting the Catwalk-canonical replacement. The user's config is never auto-rewritten.

`bunx @glrs-dev/harness-opencode doctor` now includes a model-overrides check: it reads both `plugin options.models` and legacy `harness.models`, prints a red-X line with the full remediation hint for each invalid entry, and a green check when everything resolves cleanly.

Unknown or CRIS-prefixed IDs (`global.anthropic.*`, `openai/*`, etc.) stay silent — the validator flags only the specific pre-#100 legacy pattern. No behavior change to the happy path.
