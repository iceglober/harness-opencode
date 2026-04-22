---
"@glrs-dev/harness-opencode": patch
---

Fix two permission-layer bugs that caused friction during subagent-delegated work (notably `/qa` runs hitting prompts on `git log`, `git merge-base`, `git diff --name-only`, `git branch --show-current`, and `/tmp/*`):

- **Subagent permissions are now actually wired up.** The nested `permission:` YAML blocks declared in subagent prompt frontmatter (`src/agents/prompts/*.md`) were silently dropped by the flat frontmatter parser, and `agentFromPrompt` never read them. Subagents including `qa-reviewer`, `autopilot-verifier`, `plan-reviewer`, `gap-analyzer`, `code-searcher`, `architecture-advisor`, `lib-reader`, and `agents-md-writer` ran with no declared permissions, falling back to session defaults that prompt on read-only git operations. Fix: per-subagent permission constants (`QA_REVIEWER_PERMISSIONS`, `AUTOPILOT_VERIFIER_PERMISSIONS`, etc.) now live in `src/agents/index.ts` and are passed via the existing `overrides` arg on `agentFromPrompt()` — the same mechanism primary agents use. The dead `permission:` blocks have been stripped from the `.md` files so there's one source of truth.

- **Scratch and XDG directories no longer prompt by default.** Added six paths to the plugin's `external_directory` defaults: `/tmp/**`, `/private/tmp/**` (macOS `/tmp` symlink target), `/var/folders/**/T/**` (macOS `$TMPDIR` expansion), `~/.config/opencode/**` (OpenCode's own config dir — agents read it to inspect current config), `~/.cache/**` (XDG cache; npm/pip/bun write here), and `~/.local/share/**` (XDG data; Linear MCP cache, etc.). Agents read these paths routinely with no security upside to prompting (the user already has access). User values in `opencode.json` still win — set e.g. `"/tmp/**": "deny"` or `"~/.cache/**": "deny"` to clamp any of them back down.

`applyConfig` is now exported from `src/index.ts` to enable direct test coverage of the merge semantics. No behavior change to the `config` hook path. 9 new tests (`test/agents.test.ts` + new `test/external-directory.test.ts`) lock in the permission shape, regression-test read-only git commands in qa-reviewer, and verify user-wins precedence on `external_directory`.
