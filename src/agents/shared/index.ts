import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function readMd(name: string): string {
  // In the bundled dist/index.js, import.meta.url resolves to dist/,
  // but the file is at dist/agents/shared/. In dev (running from src/),
  // import.meta.url resolves to src/agents/shared/.
  const candidates = [
    join(HERE, name),                                          // dev: src/agents/shared/
    join(HERE, "agents", "shared", name),                      // dist: dist/ → dist/agents/shared/
    join(HERE, "..", "..", "..", "src", "agents", "shared", name), // fallback dev
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(`Could not find shared file: ${name}`);
}

export const WORKFLOW_MECHANICS_RULE: string = readMd("workflow-mechanics.md");
