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
  // In the bundled dist/cli.js, import.meta.url resolves to dist/.
  // The shell script is at dist/bin/plan-check.sh. In dev, HERE is src/bin/.
  const candidates = [
    join(here, "plan-check.sh"),             // dev: src/bin/plan-check.sh
    join(here, "bin", "plan-check.sh"),       // dist: dist/ → dist/bin/plan-check.sh
  ];

  let scriptPath: string | undefined;
  for (const p of candidates) {
    try {
      execFileSync("test", ["-f", p]);
      scriptPath = p;
      break;
    } catch {
      // try next
    }
  }

  if (!scriptPath) {
    console.error("plan-check: could not find plan-check.sh");
    process.exit(2);
  }

  try {
    execFileSync("bash", [scriptPath, ...args], {
      stdio: "inherit",
      encoding: "utf8",
    });
  } catch (e: any) {
    process.exit(e.status ?? 1);
  }
}
