# S1 — opencode CLI flags

**Question:** Does `opencode` accept `--agent <name>` and `--message <text>` for primary-agent first-prompt injection?

**Verdict:** Partially. `--agent` is correct. The first-prompt flag is `--prompt`, not `--message`.

## Evidence

`opencode --help` (top-level TUI invocation) lists:

```
--agent        agent to use                                                           [string]
--prompt       prompt to use                                                          [string]
```

`opencode run --help` lists `--agent` and accepts a positional `message..` array (used as the first message). It does NOT advertise a `--message` flag.

## Implication for Phase G (`pilot plan` CLI)

```ts
// src/pilot/cli/plan.ts
spawn("opencode", ["--agent", "pilot-planner", "--prompt", initialPrompt], {
  cwd: process.cwd(),
  stdio: "inherit",
});
```

`--prompt` injects the first user message into the TUI session, then the user
takes over interactively. This matches the design's "drive the planner agent
to ask clarifying questions, then write `pilot.yaml`" flow.

For headless runs (later, e.g. CI), use `opencode run --agent pilot-planner "<message>"` instead.
