---
"@glrs-dev/harness-opencode": patch
---

Two friction fixes so `/fresh` is actually friction-free, not just nominally so:

1. **`/fresh` no longer asks to confirm discarding uncommitted changes.** Running `/fresh` is itself the intent to discard; the interactive default has always been "wipe silently" per spec, but the prompt was hedged enough that the agent kept synthesizing a confirmation anyway (notably for untracked non-gitignored files like `.opencode/package-lock.json`). Added a loud top-of-prompt directive enumerating the only two permissible `question`-tool cases (`--confirm` was passed, or the input had no ref) and reinforced the "only under `--confirm`" guard at §3. No behavior change in `--confirm` or `--yes` modes.

2. **Plugin now self-updates the OpenCode cache instead of asking users to run `bun update`.** Context: OpenCode caches the plugin at `~/.cache/opencode/packages/@glrs-dev/harness-opencode@latest/` with an exact version pin baked into that dir's `package.json` and `package-lock.json` — so `bun update` from anywhere else is a no-op, and users silently drift behind for releases. (Symptom: users on 0.1.2 still hitting the `/tmp/**` external-directory prompts that were fixed in 0.3.0.) The daily update check now rewrites that cache dir's pin to the latest version and removes its `node_modules/`, so the next OpenCode restart re-installs fresh. The toast copy is now "next restart will auto-update" instead of "run bun update." Writes are atomic (tmp + rename), skip non-exact user-managed pins, and require name-match against our package. `HARNESS_OPENCODE_AUTO_UPDATE=0` disables just the rewrite; `HARNESS_OPENCODE_UPDATE_CHECK=0` still disables the whole thing.

Bonus: fixes a drift bug where `BUNDLED_VERSION` was hardcoded to `"0.1.2"` in source (comment lied — release pipeline never actually patched it). It's now read from `package.json` at module load, so the running version always matches the shipped package.
