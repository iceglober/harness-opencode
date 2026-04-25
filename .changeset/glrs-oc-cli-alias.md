---
"@glrs-dev/harness-opencode": minor
---

feat: add `glrs-oc` CLI alias for global install usage

Adds a second `bin` entry (`glrs-oc`) alongside the existing `harness-opencode`, both pointing to `dist/cli.js`. After `bun add -g @glrs-dev/harness-opencode`, users can invoke the CLI as `glrs-oc install`, `glrs-oc doctor`, `glrs-oc pilot plan`, etc. — shorter than `bunx @glrs-dev/harness-opencode ...` and avoids the Node.js runtime mismatch that `bunx` can trigger.

Permission maps for CORE_BASH_ALLOW_LIST, PLAN_PERMISSIONS, and PILOT_PLANNER_PERMISSIONS now also allow `glrs-oc *` variants so agents can invoke the short-name CLI.
