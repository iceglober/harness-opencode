---
"@glrs-dev/harness-opencode": patch
---

Check for plugin updates on every OpenCode session start instead of rate-limiting to once per 24 hours. The file-based rate limit caused same-day publishes to go undetected until the next day, delaying auto-update of the plugin cache.
