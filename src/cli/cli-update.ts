/**
 * CLI auto-update: check npm registry after each command, auto-apply
 * minor/patch updates, notify-only for major updates.
 *
 * Behavior:
 *   - Checks `registry.npmjs.org` at most once per 24h (rate-limited
 *     via a timestamp file at `~/.cache/harness-opencode/cli-update.json`).
 *   - Minor/patch: spawns `bun update -g @glrs-dev/harness-opencode`
 *     as a detached background process. Current invocation uses the old
 *     version; next invocation gets the new one.
 *   - Major: prints a notice to stderr. No auto-apply.
 *   - Disabled by `HARNESS_OPENCODE_UPDATE_CHECK=0`.
 *
 * This module is fire-and-forget: the CLI calls `maybeAutoUpdate()` after
 * its command handler returns. Errors are swallowed — the update check
 * must never break a CLI invocation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@glrs-dev/harness-opencode";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

// --- ANSI helpers ----------------------------------------------------------

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

// --- Semver helpers --------------------------------------------------------

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(v: string): SemVer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]! };
}

function isNewer(current: SemVer, latest: SemVer): boolean {
  if (latest.major !== current.major) return latest.major > current.major;
  if (latest.minor !== current.minor) return latest.minor > current.minor;
  return latest.patch > current.patch;
}

function isMajorBump(current: SemVer, latest: SemVer): boolean {
  return latest.major > current.major;
}

// --- State file ------------------------------------------------------------

function getStateFilePath(): string {
  const cacheHome =
    process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "harness-opencode", "cli-update.json");
}

interface UpdateState {
  last_check_ts: number;
  latest_version?: string;
}

function readState(): UpdateState | null {
  try {
    const raw = fs.readFileSync(getStateFilePath(), "utf8");
    return JSON.parse(raw) as UpdateState;
  } catch {
    return null;
  }
}

function writeState(state: UpdateState): void {
  try {
    const statePath = getStateFilePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    // best-effort
  }
}

// --- Version detection -----------------------------------------------------

function readInstalledVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "package.json"),
    path.join(here, "..", "..", "package.json"),
    path.join(here, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === PACKAGE_NAME && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // try next
    }
  }
  return "0.0.0";
}

// --- Registry fetch --------------------------------------------------------

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

// --- Background update -----------------------------------------------------

function spawnBackgroundUpdate(): void {
  try {
    // Detach a child process that updates the global install.
    // stdio: "ignore" + detached + unref() ensures the parent exits
    // immediately without waiting.
    const child = spawn("bun", ["update", "-g", PACKAGE_NAME], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // If bun isn't available or spawn fails, silently degrade.
  }
}

// --- Public API ------------------------------------------------------------

/**
 * Start the update check immediately (non-blocking). Returns a cleanup
 * function that should be called to print the result. The fetch runs
 * concurrently with the command handler.
 *
 * Usage in CLI entry:
 *   const printUpdate = startUpdateCheck();
 *   process.on('exit', printUpdate);
 *   run(binary(cli), process.argv);
 */
export function startUpdateCheck(): () => void {
  if (process.env["HARNESS_OPENCODE_UPDATE_CHECK"] === "0") {
    return () => {};
  }

  const currentVersionStr = readInstalledVersion();
  const current = parseSemver(currentVersionStr);
  if (!current) return () => {};

  // Check rate limit synchronously — avoid the fetch entirely if <24h.
  const state = readState();
  if (state && Date.now() - state.last_check_ts < CHECK_INTERVAL_MS) {
    // Even if we skip the fetch, check if a previously discovered
    // major bump is still pending notification.
    if (state.latest_version) {
      const cached = parseSemver(state.latest_version);
      if (cached && isNewer(current, cached) && isMajorBump(current, cached)) {
        return () => printMajorNotice(currentVersionStr, state.latest_version!);
      }
    }
    return () => {};
  }

  // Fire the fetch — it runs concurrently with the command handler.
  // The result is captured in a closure variable.
  let action: (() => void) | null = null;

  fetchLatestVersion()
    .then((latestStr) => {
      writeState({
        last_check_ts: Date.now(),
        latest_version: latestStr ?? undefined,
      });

      if (!latestStr) return;
      const latest = parseSemver(latestStr);
      if (!latest || !isNewer(current, latest)) return;

      if (isMajorBump(current, latest)) {
        action = () => printMajorNotice(currentVersionStr, latestStr);
      } else {
        action = () => {
          process.stderr.write(
            `\n${c.blue}•${c.reset} Updating ${PACKAGE_NAME} ` +
              `${c.dim}${currentVersionStr}${c.reset} → ${c.green}${latestStr}${c.reset} ` +
              `in the background...\n`,
          );
          spawnBackgroundUpdate();
        };
      }
    })
    .catch(() => {
      // Never let the update check break the CLI.
    });

  // Return a synchronous callback that prints/spawns whatever the
  // fetch resolved to. Safe to call from process.on('exit').
  return () => {
    if (action) action();
  };
}

function printMajorNotice(current: string, latest: string): void {
  process.stderr.write(
    `\n${c.yellow}${c.bold}Major update available:${c.reset} ` +
      `${current} → ${c.green}${latest}${c.reset}\n` +
      `${c.dim}Review the changelog before upgrading:${c.reset}\n` +
      `  bun update -g ${PACKAGE_NAME}\n`,
  );
}
