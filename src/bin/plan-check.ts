/**
 * plan-check — parse a plan file's plan-state fence.
 *
 * Delegates to the bundled plan-check.sh shell script, which contains the
 * awk-based fence parser. This avoids re-implementing complex awk logic in
 * TypeScript while still shipping the tool as part of the npm package.
 *
 * Usage:
 *   bunx @glrs-dev/harness-opencode plan-check <path>
 *   bunx @glrs-dev/harness-opencode plan-check --run <path>
 *   bunx @glrs-dev/harness-opencode plan-check --check <path>
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function planCheck(args: string[]): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(here, "plan-check.sh");

  try {
    execFileSync("bash", [scriptPath, ...args], {
      stdio: "inherit",
      encoding: "utf8",
    });
  } catch (e: any) {
    // execFileSync throws on non-zero exit; propagate the exit code
    process.exit(e.status ?? 1);
  }
}
