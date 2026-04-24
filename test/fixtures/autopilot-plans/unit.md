# Fix the auth redirect bug

## Goal

When a user signs out then signs back in, they should land on the page they were on before signing out, not the homepage. GEN-1234.

## Acceptance criteria

- [ ] Capture the current URL in session storage on sign-out.
- [ ] Read session storage on sign-in and redirect accordingly.
- [ ] Add a regression test in `auth.test.ts`.

## File-level changes

### src/auth/signout.ts
- Change: write `window.location.pathname` to `sessionStorage` before redirecting.
- Why: preserve intent across the auth hop.
- Risk: low

### src/auth/signin.ts
- Change: read the stashed path post-auth, fall back to `/` if absent or expired.
- Why: complete the round-trip.
- Risk: low

## Test plan

- New `auth.test.ts` case covering the signout→signin redirect.

## Out of scope

- Cross-device session continuity.
