# S4 — Session resumability across server restarts

**Question:** If a server is killed mid-session, can a new server reattach to the same session ID?

**Verdict:** **Yes.** Sessions persist server-side and reattach cleanly. Major implication: one server can multiplex many worktrees.

## Evidence

Test sequence:

1. `opencode serve --port 7891` (server-1).
2. `POST /session` → returned `id: ses_23cb1f13effeRMKbGf6FHgsntT`.
3. `kill -TERM` server-1, wait, `kill -KILL`.
4. `opencode serve --port 7891` (server-2, fresh process, same port).
5. `GET /session/ses_23cb1f13effeRMKbGf6FHgsntT` → returned the session
   verbatim (same id, same created timestamp, same title).

Server-side state is persisted under `~/.local/state/opencode/` (revealed by
`/path` endpoint: `state: "/Users/iceglobe/.local/state/opencode"`).

## Multi-worktree finding (unexpected)

The same test showed that `?directory=<path>` on `POST /session` per-scopes a
session to that directory:

| Request | `directory` in response |
|---------|-------------------------|
| `POST /session?directory=/tmp/wt-a` | `/private/tmp/wt-a` |
| `POST /session?directory=/tmp/wt-b` | `/private/tmp/wt-b` |

Both sessions live on the same server. The server itself was started with the
default cwd (the current shell), but per-session `directory` overrides it.

## Implication for v0.1

The plan's implicit "spawn one server per worktree" model is unnecessary. v0.1
should:

1. Spawn **one** opencode server at pilot-build start.
2. For each task, call `session.create({ query: { directory: worktreePath } })`.
3. Subsequent `promptAsync` / `abort` / `get` pass the same `directory` query.
4. Shut the server down at pilot-build end.

This simplifies Phase D (single server lifecycle), Phase E (shared event bus
trivially correct), and resource consumption.

## Implication for resume / retry (Phase G6)

Because sessions persist, `pilot retry <task-id>` and `pilot resume` can
in theory reattach to in-flight sessions across `pilot build` invocations.
v0.1 explicitly does NOT do this — `retry` drops the session and starts a
new one — but the capability exists for v0.3+.

## Caveats

- Server-side persistence implies disk writes under
  `~/.local/state/opencode/`. Pilot does not write there directly (per the
  zero-user-filesystem-writes invariant for the harness plugin), but
  opencode itself does. This is acceptable: opencode's own state directory
  is its own contract with the user, not ours.
- Reattach was tested with port reuse on the same machine. Cross-machine
  reattach is irrelevant for v0.1 (single-worker, local).
- An in-flight prompt at the time of kill: not tested. The session reattaches,
  but whether the assistant resumes the partial reply or reports an error is
  unknown. v0.1 doesn't rely on this — `pilot retry` always starts a fresh
  session.
