/**
 * Self-update for @glrs-dev/harness-opencode.
 *
 * Context: OpenCode caches plugin packages at
 * `~/.cache/opencode/packages/@glrs-dev/harness-opencode@latest/` with an
 * exact version pin written into that dir's `package.json` and
 * `package-lock.json`. Once pinned, `bun update` from within that dir is a
 * no-op — the user never auto-receives new plugin releases. They'd have to
 * manually `rm -rf` the cache, which is the exact "manual step" we want to
 * eliminate.
 *
 * This module self-heals by detecting a stale cache pin and atomically
 * rewriting the cache-dir's `package.json` + `package-lock.json` to point at
 * the latest version. It then removes `node_modules/` under the cache dir so
 * OpenCode's next start triggers a fresh install. The plugin currently
 * running in-process is still the old version — the refresh takes effect on
 * the NEXT OpenCode restart.
 *
 * Zero-user-filesystem-writes invariant (see AGENTS.md): this writes only
 * inside OpenCode's cache dir for OUR own package. It does NOT touch
 * `~/.config/opencode/agents/`, `~/.config/opencode/commands/`,
 * `~/.config/opencode/skills/`, `~/.config/opencode/tools/`, `~/.claude/`,
 * or `~/.config/opencode/opencode.json`. The cache dir is OpenCode's
 * ephemeral install tree — rewriting our own package's pin there is
 * equivalent to `npm install <pkg>@<new-version>` scoped to our dir.
 *
 * Safety:
 *   - Atomic writes (tmp + rename) so we never leave a corrupt lockfile.
 *   - Skip rewrite if the cache dir's package.json declares a non-exact
 *     version (e.g. `^0.6.0`) — the user is managing pins themselves.
 *   - Cross-check package name in cache dir matches ours before writing.
 *   - Best-effort rm of `node_modules/`; if it fails, next start re-reads
 *     the new pin and the install just overwrites.
 *   - `HARNESS_OPENCODE_AUTO_UPDATE=0` disables ONLY the cache rewrite
 *     (update check still runs and toasts).
 *   - `HARNESS_OPENCODE_UPDATE_CHECK=0` disables both check and rewrite.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@glrs-dev/harness-opencode";

export function getOpenCodeCachePackageDir(): string {
  const cacheHome =
    process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache");
  // OpenCode's layout: packages/<scope>/<name>@<range>/
  // The `@latest` range is what our installer writes by default (unpinned
  // plugin entry in opencode.json). If the user manually pinned, the dir
  // suffix would differ and we won't touch it.
  return path.join(
    cacheHome,
    "opencode",
    "packages",
    "@glrs-dev",
    "harness-opencode@latest",
  );
}

interface CachePackageJson {
  name?: string;
  dependencies?: Record<string, string>;
}

interface CacheLockfile {
  name?: string;
  packages?: Record<
    string,
    { version?: string; dependencies?: Record<string, string> }
  >;
}

export interface RefreshContext {
  /** Override the cache dir — used in tests. Defaults to real OpenCode path. */
  cacheDir?: string;
  /** Skip actual writes — used in tests to verify decision logic. */
  dryRun?: boolean;
}

export interface RefreshResult {
  /** What happened. */
  outcome:
    | "disabled"
    | "cache-missing"
    | "not-our-package"
    | "no-pin-to-rewrite"
    | "non-exact-pin"
    | "already-current"
    | "refreshed"
    | "error";
  message: string;
  /** Only set when outcome === "refreshed" or "already-current". */
  fromVersion?: string;
  toVersion?: string;
}

/**
 * Check whether the cache dir is exact-pinned to our package at the given
 * version. Used before writing to ensure we don't stomp user-managed pins.
 */
export async function inspectCachePin(
  cacheDir: string,
): Promise<
  | { kind: "missing" }
  | { kind: "not-our-package"; name: string }
  | { kind: "non-exact"; spec: string }
  | { kind: "exact"; version: string }
> {
  const pkgPath = path.join(cacheDir, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, "utf8");
  } catch {
    return { kind: "missing" };
  }
  let parsed: CachePackageJson;
  try {
    parsed = JSON.parse(raw) as CachePackageJson;
  } catch {
    return { kind: "missing" };
  }
  const deps = parsed.dependencies ?? {};
  const spec = deps[PACKAGE_NAME];
  if (typeof spec !== "string") {
    // This cache dir isn't pinning our package. Could be corrupted or
    // belong to a different plugin sharing the dir name.
    return { kind: "not-our-package", name: parsed.name ?? "(unknown)" };
  }
  // Exact = pure semver like "0.6.0" with no leading ^, ~, >=, <, range, etc.
  if (/^\d+\.\d+\.\d+(-[0-9a-zA-Z.-]+)?(\+[0-9a-zA-Z.-]+)?$/.test(spec)) {
    return { kind: "exact", version: spec };
  }
  return { kind: "non-exact", spec };
}

/**
 * Atomically write a JSON file: write to `.tmp` sibling, then rename.
 */
async function atomicWriteJson(
  targetPath: string,
  value: unknown,
): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, serialized, "utf8");
  await fs.rename(tmpPath, targetPath);
}

/**
 * Rewrite the cache dir's package.json + lockfile to pin a new version, and
 * remove the cache dir's node_modules so OpenCode triggers a reinstall on
 * next start.
 *
 * This function is strictly additive: if any safety check fails, it returns
 * without writing anything. Callers inspect the RefreshResult to decide what
 * (if anything) to show the user.
 */
export async function refreshPluginCache(
  currentVersion: string,
  latestVersion: string,
  ctx: RefreshContext = {},
): Promise<RefreshResult> {
  if (process.env["HARNESS_OPENCODE_AUTO_UPDATE"] === "0") {
    return {
      outcome: "disabled",
      message: "HARNESS_OPENCODE_AUTO_UPDATE=0 — cache rewrite skipped",
    };
  }

  const cacheDir = ctx.cacheDir ?? getOpenCodeCachePackageDir();

  // Nothing to do if the two versions are already aligned.
  if (currentVersion === latestVersion) {
    return {
      outcome: "already-current",
      message: `running ${currentVersion}, latest is ${latestVersion}`,
      fromVersion: currentVersion,
      toVersion: latestVersion,
    };
  }

  const pin = await inspectCachePin(cacheDir);
  switch (pin.kind) {
    case "missing":
      return {
        outcome: "cache-missing",
        message: `no cache pin at ${cacheDir} — nothing to rewrite`,
      };
    case "not-our-package":
      return {
        outcome: "not-our-package",
        message: `cache dir exists but doesn't pin ${PACKAGE_NAME} (name=${pin.name})`,
      };
    case "non-exact":
      return {
        outcome: "non-exact-pin",
        message: `cache pin is "${pin.spec}" (not exact) — user-managed, leaving alone`,
      };
    case "exact": {
      if (pin.version === latestVersion) {
        return {
          outcome: "already-current",
          message: `cache already pinned to ${latestVersion}`,
          fromVersion: pin.version,
          toVersion: latestVersion,
        };
      }
      // Fall through to rewrite.
      break;
    }
  }

  const fromVersion = (pin as { kind: "exact"; version: string }).version;
  if (ctx.dryRun) {
    return {
      outcome: "refreshed",
      message: `[dry-run] would rewrite ${cacheDir} from ${fromVersion} to ${latestVersion}`,
      fromVersion,
      toVersion: latestVersion,
    };
  }

  try {
    // 1. Rewrite package.json to bump the dep spec.
    const pkgPath = path.join(cacheDir, "package.json");
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(pkgRaw) as CachePackageJson;
    const deps = { ...(pkg.dependencies ?? {}) };
    deps[PACKAGE_NAME] = latestVersion;
    const newPkg = { ...pkg, dependencies: deps };
    await atomicWriteJson(pkgPath, newPkg);

    // 2. Rewrite lockfile (if present) to match. If parsing fails, delete
    // it — bun/npm will regenerate from the updated package.json.
    const lockPath = path.join(cacheDir, "package-lock.json");
    try {
      const lockRaw = await fs.readFile(lockPath, "utf8");
      const lock = JSON.parse(lockRaw) as CacheLockfile;
      const packages = { ...(lock.packages ?? {}) };
      // Root package entry
      if (packages[""] && packages[""].dependencies) {
        packages[""] = {
          ...packages[""],
          dependencies: {
            ...packages[""].dependencies,
            [PACKAGE_NAME]: latestVersion,
          },
        };
      }
      // The pinned node_modules entry won't match once we delete
      // node_modules/ anyway, but clean it up for hygiene so a partial
      // re-read before node_modules/ is deleted doesn't see stale data.
      const nmKey = `node_modules/${PACKAGE_NAME}`;
      if (packages[nmKey]) {
        packages[nmKey] = {
          ...packages[nmKey],
          version: latestVersion,
        };
        // Drop stale `resolved`/`integrity` — they pin the OLD tarball.
        // bun/npm will backfill on reinstall.
        delete (packages[nmKey] as Record<string, unknown>)["resolved"];
        delete (packages[nmKey] as Record<string, unknown>)["integrity"];
      }
      const newLock = { ...lock, packages };
      await atomicWriteJson(lockPath, newLock);
    } catch {
      // Lockfile missing or malformed — just remove it. Next install rebuilds.
      try {
        await fs.rm(lockPath, { force: true });
      } catch {
        // best-effort
      }
    }

    // 3. Remove node_modules/ so OpenCode's next start triggers a fresh
    // install. If this fails, the old node_modules/ may get used on next
    // start, but the package.json mismatch will make bun/npm reinstall
    // anyway. Best-effort.
    const nmPath = path.join(cacheDir, "node_modules");
    try {
      await fs.rm(nmPath, { recursive: true, force: true });
    } catch {
      // ignore — pin rewrite alone is usually enough to trigger reinstall
    }

    return {
      outcome: "refreshed",
      message: `rewrote cache pin ${fromVersion} → ${latestVersion}; next OpenCode restart will reinstall`,
      fromVersion,
      toVersion: latestVersion,
    };
  } catch (err) {
    return {
      outcome: "error",
      message: `cache rewrite failed: ${(err as Error).message}`,
      fromVersion,
      toVersion: latestVersion,
    };
  }
}

/**
 * Read our own package.json to get the version we're running as.
 *
 * At runtime (bundled), `src/index.ts` is compiled to `dist/index.js`, so
 * package.json sits one directory up. During tests (source load), the file
 * sits two dirs up (src/ → repo root). Walk upward until we find a
 * package.json whose `name` matches ours.
 */
export function readOurPackageVersion(fromFileUrl: string): string {
  const here = path.dirname(fileURLToPath(fromFileUrl));
  const candidates = [
    path.join(here, "..", "package.json"),      // dist/index.js → dist/../package.json
    path.join(here, "..", "..", "package.json"), // src/index.ts → src/../../package.json
    path.join(here, "package.json"),             // safety net
  ];
  for (const candidate of candidates) {
    try {
      const raw = fsSync.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === PACKAGE_NAME && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // try next
    }
  }
  // Last resort — return "0.0.0" so version compare will always see us as
  // stale. Better to nag than silently drift.
  return "0.0.0";
}
