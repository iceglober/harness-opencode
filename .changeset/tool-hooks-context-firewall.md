---
"@glrs-dev/harness-opencode": minor
---

Add tool-hooks sub-plugin with four context-saving optimizations: output backpressure (truncate successful tool output above threshold, write full to disk), post-edit verification loop (auto-run tsc after TS/JS edits), loop detection (warn after N edits to same file), and read deduplication (skip re-reads of unchanged files). Add context firewall section to orchestrator prompt mandating sub-agent delegation for high-output operations.
