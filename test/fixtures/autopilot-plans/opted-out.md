# Migrate legacy tests

<!-- autopilot: skip -->

## Goal

Multi-week migration from Jest to Vitest, file-by-file. Autopilot should not drive this — it's a slow grind best done with human judgment on each migration.

## Acceptance criteria

- [ ] Convert all files under `src/legacy/`.
- [ ] Remove the Jest config.
- [ ] Update CI.
