---
"@glrs-dev/harness-opencode": patch
---

Make tool-output truncation per-tool-shape-aware and widen the permission allowlist to cover the plugin's own spill path.

Before this change, every `bash`/`read`/`glob`/`grep` output over 2000 chars was truncated to a 300-char head + 200-char tail with the full text spilled to `~/.local/state/harness-opencode/tool-output/<callID>.txt` — but that spill path was not in the external_directory allowlist, so the PRIME hit a permission prompt on every recovery read. The recovery read then re-truncated, compounding. On any file >~50 lines or grep with >~15 matches, a session spent 3-5 turns ping-ponging between truncation and permission prompts.

**Allowlist:** `~/.local/state/**` and `~/.config/crush/**` are now in the default `permission.external_directory` map (before `...existingExtDir`, so user overrides still win).

**Truncation:** raised the base threshold from 2000 → 6000 chars (~150 lines of code) and added per-tool shapes:
- `read`: `"skip"` — Read's own `limit`/`offset` is the single bound.
- `glob`: `"skip"` — path lists aren't useful when middle-truncated.
- `bash`: `"tail"` (default 4000 chars) — failures and exit codes are at the end; keeping head loses signal.
- `grep`: `"head-with-count"` — first 20 match blocks verbatim + `"... N more matches — full output at <path>"` footer. Middle-truncation breaks match blocks.

The bash-failure bypass (`looksLikeBashFailure`) is preserved as the first check among truncation paths. A new recovery-read bypass skips truncation entirely when Read is targeting a file under the spill dir. Users can override per-tool shape/threshold/head/tail/grepHeadMatches via `toolHooks.backpressure.perTool.<tool>` in `opencode.json`; user values always win.
