# Security Policy

Thank you for helping keep `@glrs-dev/harness-opencode` and the people who use it safe. This document describes how to report a vulnerability, what versions we fix, and what is in scope.

## Supported versions

We publish fixes for the **latest minor** during the 0.x cadence. Older minors do not receive backports.

| Version | Supported |
| ------- | --------- |
| 0.x (latest minor) | ✅ |
| 0.x (older minors) | ❌ |

Once 1.0 ships, this table will track supported major lines instead.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.**

Use one of these private channels:

1. **Preferred — GitHub private vulnerability reporting:** go to the [Security tab](https://github.com/iceglober/harness-opencode/security/advisories/new) and open a new advisory. This gives us a private thread with tracking, severity fields, and a path to issue a CVE if applicable.
2. **Fallback — email:** `austin@glorious.dev`. Use PGP if you have a key; otherwise plain email is fine. Include the word `SECURITY` in the subject.

Please include:

- A description of the issue and why it matters (threat, impact).
- Steps to reproduce, ideally a minimal repro or a failing test.
- Affected version(s). Check with `npm view @glrs-dev/harness-opencode version` if unsure.
- Your disclosure timeline preference, if you have one.

## Our response SLA

These are honest numbers for a small maintainer footprint. We will keep them:

- **Acknowledge your report:** within **72 hours**.
- **Triage (confirmed / not a vuln / needs more info):** within **7 days**.
- **Fix-or-disclose decision + timeline:** within **30 days** of acknowledgement.

If a vulnerability is confirmed and fixed, we will publish a GitHub security advisory and an `npm deprecate` notice for affected versions.

## Scope

**In scope:**

- The published npm tarball (`@glrs-dev/harness-opencode`).
- CLI subcommands (`glrs-oc`, `harness-opencode`): `install`, `uninstall`, `doctor`, `plan-dir`, `plan-check`, `pilot`.
- Plugin hooks registered via the OpenCode plugin API (`config`, `tool.execute.before/after`, `session.idle`, etc.).
- The MCP config writer (`src/cli/install.ts`, `src/mcp/index.ts`) and the `opencode.json` merge logic (`src/cli/merge-config.ts`).
- Outbound network calls the plugin makes on its own:
  - `https://registry.npmjs.org/` — daily update check (opt-out: `HARNESS_OPENCODE_UPDATE_CHECK=0`).
  - `https://catwalk.charm.land/` — model catalog fetch during interactive install.
  - `https://us.aptabase.com/` — anonymous telemetry (opt-out: `HARNESS_OPENCODE_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `CI=true`).

**Out of scope (will not be treated as vulnerabilities in this package):**

- User-authored `pilot.yaml` files: the pilot verify-runner executes user-supplied shell commands by design. Malicious `pilot.yaml` contents are the user's responsibility to review.
- **Third-party MCP upstreams** the plugin configures (Serena, mcp-server-git, `@playwright/mcp`, `@modelcontextprotocol/server-memory`, Linear MCP): these run in the user's MCP shell and are outside this package's boundary. Report issues to their respective maintainers.
- **Agent bash permission patterns** (`CORE_DESTRUCTIVE_BASH_DENIES` in `src/agents/index.ts`): the deny-list is a safety rail for common mistakes, not a sandbox. An agent (or prompt injection that reaches one) can exfiltrate files, call network endpoints, or mutate the shell via constructs the deny-list does not match (shell expansion, piping to curl, etc.). This is a documented property of the threat model; see `docs/THREAT_MODEL.md` (when published) or the README's Threat boundaries section.
- Decisions made by the underlying LLM. If a model follows a malicious instruction, that's a model/prompt issue, not a plugin issue. Defense-in-depth against prompt injection is welcome via the private reporting channel but will typically be triaged as a feature request.
- Vulnerabilities in Node.js, Bun, npm, git, `uvx`, `npx`, or other tools the plugin invokes via `execFile`/subprocess. Report to their maintainers; we will update our pinned/required versions if a fix affects us.

## Safe harbor

We will not pursue legal action against security researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and service interruption.
- Report through the private channels above and give us reasonable time to fix before disclosing publicly.
- Do not exploit the issue beyond what's necessary to demonstrate it.
- Do not access, modify, or exfiltrate data that is not clearly theirs.

If you are unsure whether your planned research falls within this safe harbor, ask first at the private channels above.

## Coordinated disclosure & credit

Unless you opt out, we will credit you by name (or chosen handle) in:

- The GitHub security advisory for the fix.
- The `CHANGELOG.md` entry.

## Out-of-tree security concerns

Use GitHub issues (public) for:

- Hardening suggestions that are not actively exploitable.
- Documentation improvements to this policy.
- Questions about supported platforms / configurations.

Use private reporting for anything that has impact before a patch is published.
