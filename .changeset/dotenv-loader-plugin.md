---
"@glrs-dev/harness-opencode": minor
---

Add dotenv loader plugin for MCP config interpolation

Loads `.env` and `.env.local` into `process.env` at plugin-init time so `{env:VAR}` references in MCP server config resolve project-local secrets without a shell-side `source .env` ritual. Shell exports still win (never overwritten), `.env.local` overrides `.env`, missing files silently skipped. Zero external dependencies — inline parser only.
