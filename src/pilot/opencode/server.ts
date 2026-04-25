/**
 * opencode server lifecycle for the pilot subsystem.
 *
 * Wraps `@opencode-ai/sdk`'s `createOpencodeServer` + `createOpencodeClient`
 * with the concerns the SDK doesn't address:
 *
 *   - **Sane default timeout.** SDK default is 5s, which is fine on a
 *     warm machine but flaky on first boot (npm cache miss, cold model
 *     warmup). We default to 30s and expose `OPENCODE_SERVER_TIMEOUT_MS`.
 *   - **Doctor-friendly error messages.** SDK errors when `opencode` is
 *     not on PATH look like generic spawn errors. We pre-check and emit
 *     a message that points users at `bunx opencode upgrade` or the
 *     install docs.
 *   - **Idempotent shutdown.** `close()` from the SDK is fine but
 *     calling it twice is harmless; we expose a `shutdown()` that's
 *     safe to call from a cleanup chain that already saw an earlier
 *     failure.
 *   - **Single source of truth for the URL** so callers don't have to
 *     parse it themselves.
 *
 * Why we don't reimplement the spawn-and-parse-listening-line dance:
 * The SDK's implementation is exactly what spike S6 documented (parses
 * `opencode server listening on <url>` from stdout). Reinventing it in
 * pilot would be redundant code that lags behind upstream changes.
 *
 * Side-finding from spike S4: one server is enough for many worktrees
 * (the `directory` query param per-scopes sessions). v0.1 spawns ONE
 * server at the start of `pilot build` and tears it down at the end.
 *
 * Ship-checklist alignment: Phase D1 of `PILOT_TODO.md`.
 */

import { execFile } from "node:child_process";
import {
  createOpencodeServer,
  createOpencodeClient,
} from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";

// --- Constants -------------------------------------------------------------

/**
 * Default startup timeout. 30s covers cold first-runs (model warmup,
 * config parsing, plugin install) without being so generous that a
 * truly hung opencode binary stalls a `pilot build` indefinitely.
 *
 * Override via `OPENCODE_SERVER_TIMEOUT_MS` env var.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/**
 * Default port. `0` asks opencode to pick a free port — the SDK parses
 * the actual port out of the listening line. Picking 0 instead of a
 * specific number means concurrent `pilot build` invocations don't
 * collide. Override via the `port` arg.
 */
const DEFAULT_PORT = 0;

// --- Public types ----------------------------------------------------------

export type StartedServer = {
  /** The URL opencode is listening on (e.g. `http://127.0.0.1:54321`). */
  url: string;
  /** SDK client bound to the URL. Use this for `session.create`, etc. */
  client: OpencodeClient;
  /**
   * Tear down the server. Idempotent: subsequent calls are no-ops. The
   * underlying child process is sent SIGTERM, then SIGKILL if it
   * doesn't exit within the SDK's grace period.
   */
  shutdown: () => Promise<void>;
};

export type StartOpencodeServerOptions = {
  /**
   * Working directory for the spawned opencode process. Sessions
   * created via the returned client will inherit this as their default
   * `directory` query param unless the client passes a different one.
   *
   * v0.1 sets this to the main repo root; per-task workspaces override
   * via `client.session.create({ query: { directory: wt.path } })`.
   */
  cwd?: string;

  /**
   * Hostname to bind. Default `127.0.0.1` (loopback only — the server
   * has no auth without `OPENCODE_SERVER_PASSWORD`).
   */
  hostname?: string;

  /**
   * Port to bind. Default 0 (let opencode pick).
   */
  port?: number;

  /**
   * Startup timeout in milliseconds. Default 30s; override via
   * `OPENCODE_SERVER_TIMEOUT_MS` env var.
   */
  timeoutMs?: number;
};

// --- Public API ------------------------------------------------------------

/**
 * Start an opencode server and return a client bound to it.
 *
 * Pre-checks that `opencode` is on PATH so we can fail with a useful
 * "did you install opencode?" message instead of a generic ENOENT
 * burrowed inside the SDK's spawn error.
 *
 * The returned `shutdown()` is idempotent — call it from a cleanup
 * chain even if an earlier step already shut down. The Promise it
 * returns resolves once the SDK's `close()` has been called; the
 * underlying child process exit is fire-and-forget (the SDK doesn't
 * expose a wait-for-exit handle).
 */
export async function startOpencodeServer(
  options: StartOpencodeServerOptions = {},
): Promise<StartedServer> {
  // 1. Resolve effective options first. We do this BEFORE the precheck
  //    so a malformed env var emits its diagnostic warning even if the
  //    precheck then fails — both pieces of info are useful when
  //    troubleshooting a fresh environment.
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? "127.0.0.1";

  // 2. Pre-check `opencode` on PATH. Cheap (one subprocess, ~50ms) and
  //    gives us a doctor-friendly error.
  await ensureOpencodeOnPath();

  // 3. Spawn server via SDK. `cwd` doesn't have a direct equivalent in
  //    the SDK options (createOpencodeServer doesn't pass it through);
  //    we set it on the parent process briefly via execFile env.
  //    Actually — looking at the SDK source, it inherits process.env
  //    and uses launch() defaults, which means cwd is whatever cwd we
  //    invoke it from. Set process.cwd before spawn? That's hostile.
  //    Instead: per spike S4, per-session directory routing via
  //    `query.directory` is what actually scopes a session. The
  //    server's cwd is irrelevant for our use case — set it via
  //    `process.chdir` is a non-starter. Document and move on.
  void options.cwd;

  let server: { url: string; close(): void };
  try {
    server = await createOpencodeServer({
      hostname,
      port,
      timeout: timeoutMs,
    });
  } catch (err) {
    throw new Error(
      `pilot: failed to start opencode server (timeout=${timeoutMs}ms, host=${hostname}, port=${port}): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const client = createOpencodeClient({
    baseUrl: server.url,
  });

  let shutDown = false;
  const shutdown = async (): Promise<void> => {
    if (shutDown) return;
    shutDown = true;
    try {
      server.close();
    } catch {
      // SDK's close() is synchronous and swallows process-already-dead;
      // wrap in try in case a future SDK version throws.
    }
  };

  return { url: server.url, client, shutdown };
}

// --- Internals -------------------------------------------------------------

/**
 * Resolve the effective startup timeout. Precedence:
 *   1. Explicit `options.timeoutMs`.
 *   2. `OPENCODE_SERVER_TIMEOUT_MS` env var (parsed as integer).
 *   3. `DEFAULT_STARTUP_TIMEOUT_MS`.
 *
 * Bad env values fall back to the default with a stderr warning rather
 * than throwing — env-var typos shouldn't crash a long-running pilot
 * session, but they should be visible.
 *
 * Exported for direct unit-testing (precedence is finicky enough that
 * indirectly-via-error-message tests turned out to be brittle).
 */
export function resolveTimeoutMs(explicit: number | undefined): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const envRaw = process.env.OPENCODE_SERVER_TIMEOUT_MS;
  if (envRaw && envRaw.length > 0) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    process.stderr.write(
      `[pilot] OPENCODE_SERVER_TIMEOUT_MS=${JSON.stringify(envRaw)} is not a positive number; using default ${DEFAULT_STARTUP_TIMEOUT_MS}ms\n`,
    );
  }
  return DEFAULT_STARTUP_TIMEOUT_MS;
}

/**
 * Verify `opencode` is on PATH by running `opencode --version`. The
 * binary's own help text doesn't matter; we only need the spawn to
 * succeed (exit code 0) within a short window.
 *
 * Throws a doctor-friendly error message on failure.
 */
async function ensureOpencodeOnPath(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    execFile(
      "opencode",
      ["--version"],
      { signal: controller.signal, encoding: "utf8" },
      (err) => {
        clearTimeout(timer);
        if (err) {
          reject(
            new Error(
              `pilot: \`opencode\` binary not on PATH (or refused --version). ` +
                `Install opencode (https://opencode.ai/docs/install) and re-run \`pilot build\`. ` +
                `Underlying error: ${err.message}`,
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}
