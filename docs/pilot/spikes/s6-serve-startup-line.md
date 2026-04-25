# S6 — opencode serve startup line

**Question:** What stdout/stderr line does `opencode serve` emit when listening, so `startOpencodeServer` can parse the port reliably?

**Verdict:** **Confirmed and stable.** Format: `opencode server listening on http://<host>:<port>`. Emitted on stdout (NOT stderr).

## Evidence

`opencode serve --port 0 --print-logs` produced:

```
INFO  ... service=server-proxy version=1.14.24 args=["serve","--port","0","--print-logs"] process_role=worker run_id=...
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
INFO  ... service=file init
INFO  ... service=config path=/Users/iceglobe/.config/opencode/config.json loading
INFO  ... service=config path=/Users/iceglobe/.config/opencode/opencode.json loading
INFO  ... service=config path=/Users/iceglobe/.config/opencode/opencode.jsonc loading
opencode server listening on http://127.0.0.1:4096
```

Key observations:

1. The "listening on" line appears AFTER several `INFO ...` log lines — the parser must scan continuously until the listening line appears.
2. The format is exactly `opencode server listening on <url>`. The URL is plain (no quoting, no trailing punctuation).
3. Port `0` (random) was used; opencode picked `4096` (or random unused port — varies). The actual port is in the URL, not in the args echo.
4. `--print-logs` adds the `INFO ...` noise to stderr; the listening line is on stdout regardless.

## Parser implementation

```ts
// src/pilot/opencode/server.ts
const child = spawn("opencode", ["serve", "--port", String(port ?? 0)], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
});

const portReady = new Promise<{ host: string; port: number }>((resolve, reject) => {
  let buf = "";
  const timeout = setTimeout(
    () => reject(new Error("opencode serve startup timeout (10s)")),
    10_000,
  );
  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const m = buf.match(/opencode server listening on https?:\/\/([^:\s]+):(\d+)/);
    if (m) {
      clearTimeout(timeout);
      resolve({ host: m[1], port: Number(m[2]) });
    }
  });
  child.on("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`opencode serve exited ${code} before listening`));
  });
});
```

## Edge cases

- **No `--print-logs`**: the INFO lines disappear but the listening line still
  appears on stdout. The parser is unaffected.
- **Port already in use**: opencode either fails fast (exits non-zero) or picks
  a different port (when `--port 0`). The exit handler covers the first case.
- **Auth password warning**: harmless; pilot can ignore it. For production
  hardening (v0.4+), set `OPENCODE_SERVER_PASSWORD` in the spawned env and
  pass it on every client call.
- **stderr vs stdout**: as captured above, the listening line is on stdout.
  Don't switch to stderr-only parsing.

## Implementation note for Phase D1

The 10-second startup timeout in the example above is a starting point. On a
cold first run (npm install of plugins, model warmup), opencode can take
several seconds before printing the listening line. v0.1 should default to
30s and expose a `OPENCODE_SERVER_TIMEOUT_MS` env override.
