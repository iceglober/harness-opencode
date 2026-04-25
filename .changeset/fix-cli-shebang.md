---
"@glrs-dev/harness-opencode": patch
---

fix: change CLI shebang from `node` to `bun` to fix ERR_UNSUPPORTED_ESM_URL_SCHEME

The CLI binary (`dist/cli.js`) used `#!/usr/bin/env node`, causing `bunx` and global installs to spawn Node.js instead of Bun. Node.js cannot resolve `bun:sqlite` imports used by the pilot subsystem, producing `ERR_UNSUPPORTED_ESM_URL_SCHEME` on every CLI invocation — including commands that don't touch SQLite (`install`, `doctor`, etc.) because ESM evaluates all static imports eagerly.
