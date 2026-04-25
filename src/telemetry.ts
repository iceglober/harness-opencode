// telemetry.ts — anonymous, opt-out usage telemetry via Aptabase.
//
// Sends fire-and-forget events to Aptabase's HTTP ingestion endpoint.
// No SDK dependency — raw fetch against the same endpoint shape the
// official SDKs hit. Keeps install footprint small and audit-friendly.
//
// Privacy guarantees:
//   - Write-only App Key embedded in source (safe — same model as PostHog phc_)
//   - Install ID is SHA-256 hashed + truncated to 8 chars in transit
//   - No file paths, contents, prompts, model outputs, error messages, or
//     git remotes are ever collected
//   - Property allowlist enforced — unknown keys are stripped before send
//   - Fire-and-forget: fetch().catch(() => {}) — never throws, never blocks
//
// Opt-out: HARNESS_OPENCODE_TELEMETRY=0|false, DO_NOT_TRACK=1, CI=true

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APP_KEY = "A-US-3617699429";
const ENDPOINT = "https://us.aptabase.com/api/v0/event";
const PKG_NAME = "@glrs-dev/harness-opencode";

// Replaced at build time by tsup's `define` option. Falls back to "dev"
// if running unbundled (tests, direct ts-node execution).
declare const __PKG_VERSION__: string;
const PKG_VERSION =
  typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";

export const DISABLED =
  process.env.HARNESS_OPENCODE_TELEMETRY === "0" ||
  process.env.HARNESS_OPENCODE_TELEMETRY === "false" ||
  process.env.DO_NOT_TRACK === "1" ||
  process.env.CI === "true";

const SESSION_ID = randomUUID();

function getInstallId(): string {
  const dir = join(homedir(), ".config", "harness-opencode");
  const file = join(dir, "install-id");
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    mkdirSync(dir, { recursive: true });
    const id = createHash("sha256")
      .update(randomUUID())
      .digest("hex")
      .slice(0, 16);
    writeFileSync(file, id, { mode: 0o600 });
    return id;
  } catch {
    return "anon";
  }
}

// The allowlist is the firewall. If it's not on this list, it doesn't ship.
// Add new keys deliberately, never with a wildcard.
const ALLOWED_PROPS = new Set([
  "tool",
  "outcome",
  "duration_ms",
  "edit_kind",
  "ops_count",
  "retry_count",
  "diagnostics_count",
  "ext",
  "stale",
  "error_class",
  "subagent",
  "memory_op",
  "tool_category",
]);

export function clean(
  p: Record<string, unknown>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!ALLOWED_PROPS.has(k)) continue;
    if (typeof v === "string" || typeof v === "number") out[k] = v;
    else if (typeof v === "boolean") out[k] = v ? 1 : 0;
  }
  return out;
}

const installId = DISABLED ? "" : getInstallId();

export function track(
  eventName: string,
  props: Record<string, unknown> = {},
): void {
  if (DISABLED) return;

  // Fire and forget. Never await on the hot path. Never throw.
  fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "App-Key": APP_KEY,
      "Content-Type": "application/json",
      "User-Agent": `${PKG_NAME}/${PKG_VERSION} node/${process.version}`,
    },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
      eventName,
      systemProps: {
        isDebug: process.env.NODE_ENV !== "production",
        osName: process.platform,
        osVersion: process.release?.name ?? "node",
        locale: (process.env.LANG ?? "en").split(".")[0] ?? "en",
        appVersion: PKG_VERSION,
        appBuildNumber: PKG_VERSION,
        sdkVersion: "harness-opencode-fetch@1",
        engineName: "node",
        engineVersion: process.version,
      },
      props: { ...clean(props), install: installId.slice(0, 8) },
    }),
  }).catch(() => {});
}
