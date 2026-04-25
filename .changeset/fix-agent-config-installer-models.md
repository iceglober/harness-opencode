---
"@glrs-dev/harness-opencode": patch
---

Fix agent config and installer model IDs

- Rename remaining "orchestrator" references to "PRIME" in the PRIME agent prompt.
- Demote pilot-builder and pilot-planner from primary to subagent mode so they no longer appear as tab-selectable agents.
- Fix docs-maintainer model from bare "sonnet" to "anthropic/claude-sonnet-4-6".
- Correct Bedrock and Vertex model IDs in installer presets to match Crush's Catwalk registry (e.g. bedrock/claude-opus-4 → bedrock/anthropic.claude-opus-4-6).
- Add Catwalk API client that fetches live providers during install with graceful fallback to hardcoded presets when offline.
