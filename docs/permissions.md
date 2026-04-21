# Permissions

OpenCode controls tool access via the [`permission` config block](https://opencode.ai/docs/permissions). This page covers the defaults `glorious-opencode` ships, how the trust model interacts with `/fresh` worktrees, and how to adjust or opt out.

## Overview

OpenCode has a special permission key called `external_directory` that fires whenever a tool touches a path outside the session's project working directory. By default it resolves to `ask` — the first time an agent reads, edits, or runs a command under `~/.glorious/worktrees/<repo>/<wt>/*` (a path that *is* outside the session's root), OpenCode prompts:

```
Always allow
This will allow the following patterns until OpenCode is restarted
 - /Users/<you>/.glorious/worktrees/<repo>/<wt>/*
```

That prompt fires once per new worktree, per session. For teams that use `/fresh` heavily it adds 1–2 dead clicks per task — friction with no security value, since the worktree is a sanctioned clone of an already-trusted repo that you asked for.

## What we ship

In our global `~/.config/opencode/opencode.json`, the top-level `permission` block sets:

```json
{
  "permission": {
    "external_directory": {
      "~/.glorious/worktrees/**": "allow"
    }
  }
}
```

This pre-authorizes any path under the gs-agentic worktrees root. `/fresh` no longer re-prompts.

Rationale: the `/fresh` workflow is a user-invoked clone of a repo the user has already trusted. The worktree's working tree IS the parent repo's working tree, checked out at a different ref. Treating it as a separate untrusted workspace adds paperwork without reducing risk. Shipping this default is the narrowest fix that makes the workflow frictionless out of the box.

## What this does NOT change

`external_directory: allow` only short-circuits the out-of-workspace prompt. All other permission rules continue to apply to tool calls inside worktree paths:

- **`.env` and `secrets/**` reads are still denied** by the top-level `permission.read` block. A tool trying to read `~/.glorious/worktrees/foo/wt-x/.env` still hits the `*.env` deny rule and is refused.
- **`edit` and `bash` rules still apply.** If your config asks for confirmation on `git reset --hard` or denies `rm -rf *`, those rules fire the same way under a worktree path as they do in the parent repo.

The permission table is layered, not replaced. `external_directory` just answers the "is this path worth considering at all?" question — everything else runs on top.

## Opting out

If you want the prompt back, remove the key from your `opencode.json`:

```jsonc
"permission": {
  // "external_directory": { ... }   ← delete or set to "ask"
}
```

Or set the value to `"ask"` explicitly (which is also what OpenCode defaults to):

```json
"permission": {
  "external_directory": "ask"
}
```

Note: if you set a scalar string here, our installer's merge step treats it as "user wins" and does not auto-upgrade it on future installs — see the [scalar-vs-object](#scalar-vs-object-collisions) section below. You'll keep your scalar and the `/fresh` bug will keep re-prompting. That's deliberate.

## Extending

The `external_directory` value is an object whose keys are path globs and values are `allow` / `deny` / `ask`. Add your own entries alongside ours:

```json
"permission": {
  "external_directory": {
    "~/.glorious/worktrees/**": "allow",
    "~/scratch/**": "allow",
    "/etc/**": "deny"
  }
}
```

Patterns use simple wildcard matching:
- `*` matches zero or more of any character — **including `/`** (see [Gotchas](#gotchas)).
- `?` matches exactly one character.
- `~/` and `$HOME/` are expanded to the running user's home directory before matching.

Rules are evaluated by pattern-length with the last match winning, so more-specific denies override broader allows when you add them.

## Scalar-vs-object collisions

The installer does NOT overwrite a scalar value with an object. If your existing `opencode.json` has:

```json
"permission": { "external_directory": "ask" }
```

…then running `install.sh` will print a `WARN:` line naming the keypath and leave your value untouched. To widen it, manually replace the scalar with the object form above.

## Gotchas

- **`*` matches `/`.** OpenCode's wildcard matcher compiles `*` to the regex `.*`, so `~/.glorious/worktrees/*` covers any depth of subdirectory. The `**` form (which we ship) is idiomatic glob, not a different pattern — both match identically. Don't "tighten" `**` to `*` thinking you're restricting the scope.
- **Home expansion happens on keys starting with `~/` or `$HOME/`.** Anywhere else in the pattern, `~` is literal.
- **Paths are matched as requested, not as resolved.** If you symlink some directory into `~/.glorious/worktrees/`, the inbound symlink target doesn't inherit trust — only the symlinked path itself does. Similarly, if `~/.glorious/worktrees` is itself a symlink to elsewhere, the expansion matches the literal path, not the realpath. This is usually what you want.

## Recovery

The installer writes `opencode.json.bak.<epoch>-<pid>` alongside your `opencode.json` before every mutation. If a merge produced an unexpected result, restore from the backup:

```bash
ls ~/.config/opencode/opencode.json.bak.*
# pick the most recent
mv ~/.config/opencode/opencode.json.bak.<timestamp>-<pid> ~/.config/opencode/opencode.json
```

The installer also prints this command on stdout after every successful merge so you can copy-paste.

## Verifying the default works

1. Open an OpenCode session rooted at a repo you already have (`cd ~/repos/<repo> && opencode`).
2. Ask the agent to read a file under `~/.glorious/worktrees/<other-repo>/<wt-name>/` that exists on your machine.
3. Expect: the read succeeds silently. No "Always allow" prompt.

To sanity-check that the fix is load-bearing: temporarily remove the `external_directory` key from your `opencode.json`, restart OpenCode, and repeat step 2 — you should see the prompt fire. Put the key back.

## References

- [`/fresh` command reference](fresh.md) — the slash command that creates the worktrees this default authorizes.
- [OpenCode permissions documentation](https://opencode.ai/docs/permissions) — the upstream spec for every key named here.
- [AGENTS.md §"Rules when editing this repo" rule 4](../AGENTS.md) — the repo-internal policy that keeps your `opencode.json` edits sacred when we ship new defaults.
