# Migrating from the clone+symlink install

If you were using the previous `install.sh`-based harness (the `~/.glorious/opencode/` clone), here's how to migrate.

## Step 1: Uninstall the old harness

The final version of the old installer is tagged `v0-legacy-clone-install`. Download and run the uninstaller:

```bash
curl -fsSL https://github.com/iceglober/harness-opencode/releases/download/v0-legacy-clone-install/uninstall.sh -o /tmp/legacy-uninstall.sh
bash /tmp/legacy-uninstall.sh
```

## Step 2: Remove dangling symlinks

If OpenCode or Claude Code misbehaves after the uninstall, there may be dangling symlinks left behind (files the uninstaller intentionally preserved because you had local edits). Remove them:

```bash
find ~/.claude ~/.config/opencode -xtype l -delete
```

`-xtype l` matches dangling symlinks; `-delete` removes them. Safe on both macOS and Linux.

## Step 3: Install the npm plugin

```bash
bunx @glrs-dev/harness-opencode install
```

This adds `"@glrs-dev/harness-opencode"` to your `~/.config/opencode/opencode.json` `plugin` array non-destructively.

## Step 4: Start OpenCode

```bash
opencode
```

Agents, commands, tools, MCPs, and skills load automatically from the plugin.

## What changed

- **No more `~/.glorious/opencode/` clone.** The harness is now an npm package.
- **No more symlinks.** Agents, commands, and tools register at runtime from `node_modules`. Skills are bundled in the package.
- **No more `install.sh` / `update.sh` / `uninstall.sh`.** The old `install.sh` URL now prints a migration message and exits cleanly.
- **Updates via `bun update`.** No cron, no daemon, no state file.
- **Claude Code support is Phase B.** The current plugin is OpenCode-only.

## Troubleshooting

**`opencode` fails to start after migration:**
Run `find ~/.claude ~/.config/opencode -xtype l -delete` to remove any remaining dangling symlinks.

**My `opencode.json` customizations are gone:**
The new installer preserves your existing `opencode.json`. If you had customizations in the old `home/.config/opencode/opencode.json` (which was symlinked into `~/.config/opencode/opencode.json`), those edits were in the git checkout. You can recover them from `~/.glorious/opencode/home/.config/opencode/opencode.json` if the checkout still exists.

**I want to keep using the old install:**
Pin your local checkout to the `v0-legacy-clone-install` tag:
```bash
cd ~/.glorious/opencode && git checkout v0-legacy-clone-install
```
It will stop receiving updates but will continue to work.
