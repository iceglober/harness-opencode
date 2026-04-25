# Pilot Phase 0 — Spike Results

Pre-implementation findings that de-risk Phases A–I of [`PILOT_TODO.md`](../../../PILOT_TODO.md). Each spike below produced an answer that downstream phases consume verbatim.

**Environment:** opencode 1.14.24, `@opencode-ai/sdk` 1.14.19 on macOS. Scratch
work under `/tmp/pilot-s*` (no user state touched).

| Spike | Question | Verdict |
|-------|----------|---------|
| [S1](./s1-opencode-cli-flags.md) | TUI flags for agent + first-prompt injection | **Confirmed:** `--agent <name>` and `--prompt <text>` |
| [S2](./s2-sdk-session-methods.md) | SDK session API shape | **Confirmed with corrections** — see below |
| [S3](./s3-sse-event-shapes.md) | SSE event names for assistant message + idle | **Confirmed:** `message.updated`, `message.part.updated`, `session.idle` |
| [S4](./s4-session-resumability.md) | Sessions survive server restarts? | **Yes** — sessions persist server-side, reattach via `session.get` |
| [S5](./s5-picomatch-globs-conflict.md) | Picomatch-based glob intersection | **Works** with probe-based bidirectional matching |
| [S6](./s6-serve-startup-line.md) | Parseable startup line for port discovery | **Confirmed:** `opencode server listening on http://<host>:<port>` |

## Plan corrections required

These contradict claims in `PILOT_TODO.md` and must be reflected before Phase D
implementation begins:

1. **`session.create` does NOT take `workspaceID`** (S2). It takes `{ body: { title?, parentID? }, query: { directory? } }`. Per-session working directory is set via the `directory` query param.
2. **`client.session.info` does NOT exist** (S2). Use `client.session.get({ path: { id } })` for full session, or `client.session.status({ query: { directory? } })` for status-only. Cost-tracking polling should use `session.get` and read `cost`/`tokens` from the returned `Session` shape (verify field names at implementation time — not all SDKs expose cost on the session object; may need `session.messages` aggregation).
3. **One server can multiplex worktrees** (S4 side-finding). The plan's implicit per-worktree-server model is unnecessary for v0.1: a single `opencode serve` accepts `?directory=<wt-path>` per session call. v0.1 should use one shared server. Spawning per-worktree servers can be reconsidered in v0.3 if isolation becomes a concern.
4. **TUI agent flag is `--agent`** (S1). First-prompt injection is `--prompt <text>` (NOT `--message`). `opencode run` also accepts a positional `message..` array, but the TUI uses `--prompt`.

## How phases consume these spikes

- **Phase A** (plan format): unaffected.
- **Phase B** (state DB): unaffected.
- **Phase C** (worktrees): unaffected.
- **Phase D** (opencode integration): consumes S1, S2, S3, S6 — schema-level
  corrections above. `EventBus.waitForIdle` listens for `session.idle` events.
  `startOpencodeServer` parses the line in S6.
- **Phase E** (worker): consumes S2 (session methods) + S3 (events). Worker
  reuses one server across all worktrees (S4 finding).
- **Phase F** (agents/skill): unaffected.
- **Phase G** (CLI): `pilot plan` spawns `opencode --agent pilot-planner --prompt "..."` per S1.
