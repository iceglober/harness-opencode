---
"@glrs-dev/harness-opencode": patch
---

Security & OSS hygiene — PR1 of a 3-part remediation (follow-ups tracked in #113 and #114):

- Add `SECURITY.md` with private disclosure channel, response SLA, scope statement, and safe-harbor clause.
- Validate Catwalk model-catalog responses with a zod schema before any value reaches `opencode.json`; malformed responses fail closed and the installer falls back to built-in presets.
- Document the threat boundary, outbound network calls, and the explicit "agent bash deny-list is not a sandbox" limit in the README.
- Add npm provenance verification instructions (`npm audit signatures`) to the README.
- Declare `engines.node >= 20.10` in `package.json` and add a runtime guard at the top of the CLI binary so users on unsupported runtimes get an actionable error instead of a cryptic stack trace.
- Include `SECURITY.md` in the published tarball.
