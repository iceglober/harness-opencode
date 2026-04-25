---
"@glrs-dev/harness-opencode": minor
---

Add anonymous, opt-out usage telemetry via Aptabase. Tracks tool invocation counts, durations, file extensions, and success/failure rates — no file paths, code, prompts, or identifying information. Disabled automatically in CI and via `HARNESS_OPENCODE_TELEMETRY=0` or `DO_NOT_TRACK=1`.
