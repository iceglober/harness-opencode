/**
 * Slug derivation for `pilot.yaml` files.
 *
 * The CLI accepts a free-form input string when starting a plan
 * (`pilot plan ENG-1234`, `pilot plan "auth refactor"`, `pilot plan
 * https://github.com/owner/repo/issues/42`). We need to turn that input
 * into a stable filesystem slug that:
 *
 *   1. Is deterministic — same input → same slug, every time.
 *   2. Is filesystem-safe (lowercase, dashes, no slashes/spaces/dots).
 *   3. Is recognizable to a human glancing at `~/.glorious/opencode/<repo>/pilot/plans/`.
 *   4. Avoids collisions with previously-stored plans by appending `-2`, `-3`, ...
 *
 * Recognized input shapes (in priority order):
 *
 *   a) **Linear-style ID**: matches `^[A-Z][A-Z0-9]{1,9}-\d+$` (e.g.
 *      `ENG-1234`, `PILOT-7`). Slug = lowercased ID. This catches the
 *      common "I copy-pasted the ticket id" case unambiguously.
 *
 *   b) **GitHub issue/PR URL**: matches `github.com/<owner>/<repo>/(issues|pull)/<n>`.
 *      Slug = `<repo>-issue-<n>` or `<repo>-pr-<n>`. We drop the owner
 *      because the same repo from different forks is conceptually the
 *      same project for our purposes.
 *
 *   c) **Free-form text**: kebab-case the alphanumeric runs, lowercase,
 *      collapse separators, trim to ~50 chars. Same `slugify` algorithm
 *      as a thousand other libraries — but inlined here to avoid a
 *      dependency for ~30 lines of code.
 *
 * What this module does NOT do:
 *   - Read or write the filesystem (that's `resolveUniqueSlug`'s
 *     in-memory check; it takes `existingSlugs` as input).
 *   - Validate that the slug is unique globally — only within a passed-in
 *     set. Callers (typically `load.ts` or `pilot/cli/plan.ts`) glob the
 *     plans dir and pass the existing slug set in.
 *
 * Ship-checklist alignment: Phase A2 of `PILOT_TODO.md`.
 */

// --- Constants -------------------------------------------------------------

/**
 * Maximum slug length before truncation. 50 is a balance between
 * "readable in `ls`" and "the few extra bytes a long ticket title needs".
 * Linear IDs (`ENG-1234`) are well under this; only free-form titles
 * can hit it.
 */
const MAX_SLUG_LENGTH = 50;

/**
 * Linear ID pattern. 1–10 uppercase chars + dash + digits. Matches Linear
 * teams (`ENG`, `BACKEND`, `MKT`) and our own pilot tasks
 * (`PILOT-API-1`). Anchored to the whole string — partial matches inside
 * a longer URL fall through to the URL handler.
 */
const LINEAR_ID_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/**
 * GitHub issue/PR URL pattern. Captures the repo name and issue/PR
 * number. Owner is captured but unused (see module doc).
 */
const GITHUB_URL_PATTERN =
  /github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i;

// --- Public API ------------------------------------------------------------

/**
 * Derive a base slug from a free-form input string. Pure function —
 * no filesystem, no collision check.
 *
 * Returns a non-empty kebab-case string. Throws if `input` reduces to
 * the empty slug (only whitespace, only special characters); the caller
 * should fall back to a canonical "untitled" or fail fast — we don't
 * silently produce a unhelpful sentinel.
 */
export function deriveSlug(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError(`deriveSlug: expected string, got ${typeof input}`);
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("deriveSlug: input is empty after trimming");
  }

  // Linear-style ID: lowercased, untouched separator. Highest priority
  // because Linear IDs are unambiguous and the user almost certainly
  // wants the slug to match the ticket ID verbatim.
  if (LINEAR_ID_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  // GitHub URL: extract `<repo>-(issue|pr)-<n>`.
  const ghMatch = trimmed.match(GITHUB_URL_PATTERN);
  if (ghMatch) {
    const repo = ghMatch[2]!.toLowerCase();
    const kind = ghMatch[3]!.toLowerCase() === "pull" ? "pr" : "issue";
    const num = ghMatch[4]!;
    return `${kebabify(repo)}-${kind}-${num}`;
  }

  // Free-form: kebabify and truncate.
  const slug = kebabify(trimmed).slice(0, MAX_SLUG_LENGTH);
  if (slug.length === 0) {
    throw new Error(
      `deriveSlug: input ${JSON.stringify(input)} contains no slug-safe characters`,
    );
  }
  // Slice may end on a stray dash if the boundary fell mid-word; trim.
  return slug.replace(/-+$/, "");
}

/**
 * Resolve a unique slug given a set of slugs already in use. If `base`
 * is unused, returns it unchanged. Otherwise appends `-2`, `-3`, ... until
 * a free slot is found.
 *
 * `existingSlugs` is checked with `Set.has`, so callers should pass a
 * `Set<string>` of base slugs (without the `.yaml` extension and without
 * any trailing numeric suffix). The collision space is the set as
 * provided — if a caller wants to consider only currently-existing files
 * on disk, they pass exactly those; if they want to reserve more, they
 * include those.
 *
 * Hardcoded cap at 1000 to prevent an infinite loop if the caller passes
 * a malformed `existingSlugs` (e.g. an iterator that lies about
 * containment). 1000 plans for the same base name in one plans dir is a
 * pathological state worth failing on.
 */
export function resolveUniqueSlug(
  base: string,
  existingSlugs: ReadonlySet<string>,
): string {
  if (!existingSlugs.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!existingSlugs.has(candidate)) return candidate;
  }
  throw new Error(
    `resolveUniqueSlug: exhausted 1000 collision suffixes for base ${JSON.stringify(base)}; ` +
      `something is wrong (clean up old plans or pick a different name)`,
  );
}

// --- Internals -------------------------------------------------------------

/**
 * Standard kebab-case slugifier. Lowercases, replaces any non-alphanumeric
 * run with a single dash, strips leading/trailing dashes.
 *
 *   "Foo Bar—Baz!"     → "foo-bar-baz"
 *   "ENG-1234"         → "eng-1234"
 *   "https://x.com/a"  → "https-x-com-a"   (NB: only reachable for inputs
 *                                            that didn't match GH or
 *                                            Linear patterns)
 *   "____"             → "" (caller must check for empty)
 *
 * Unicode letters are stripped — we deliberately keep the slug ASCII to
 * avoid filesystem encoding surprises across macOS HFS+ / APFS / Linux ext4.
 */
function kebabify(s: string): string {
  return s
    .toLowerCase()
    // Replace any run of non-[a-z0-9] with a single dash.
    .replace(/[^a-z0-9]+/g, "-")
    // Trim leading/trailing dashes.
    .replace(/^-+|-+$/g, "");
}
