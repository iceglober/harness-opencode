---
"@glrs-dev/harness-opencode": minor
---

Pivot the installer's provider/model data source from Catwalk (`catwalk.charm.land`) to Models.dev (`models.dev/api.json`), matching what OpenCode's runtime uses to validate model IDs.

Previously, the installer emitted provider IDs from Catwalk's registry (`bedrock/anthropic.claude-opus-4-6`, `vertexai/claude-opus-4-6@20250610`) that OpenCode's runtime rejects at agent invocation with `Agent <name>'s configured model <id> is not valid`. Models.dev uses different provider IDs (`amazon-bedrock`, `google-vertex-anthropic`) for the same providers. The AWS Bedrock and Google Vertex presets have been broken out of the box since this ID schism was introduced upstream; only the Anthropic preset happened to work because its provider ID is identical in both registries.

The Bedrock preset now emits `amazon-bedrock/global.anthropic.claude-*` IDs (using AWS CRIS global cross-region inference for the broadest availability). The Vertex preset now emits `google-vertex-anthropic/claude-*@default` IDs. The Anthropic preset is unchanged.

The plugin's runtime validator (`src/model-validator.ts`) now flags any model override starting with `bedrock/` or `vertex(ai)/` as invalid and suggests the Models.dev-valid replacement. If you hit `ProviderModelNotFoundError` or `Agent ... configured model ... is not valid` after a recent OpenCode upgrade, run `bunx @glrs-dev/harness-opencode doctor` — it enumerates the bad overrides and the correct Models.dev IDs.

**Note for existing installations:** your opencode.json is never auto-rewritten. The doctor tells you the exact line to change. If you had a working `anthropic/*` or `amazon-bedrock/*` config, nothing changes. If you had a Catwalk-style `bedrock/anthropic.*` or `vertexai/claude-*@<date>` config, you will now see warnings until you update it — those configs never actually worked at runtime against current OpenCode versions.
