import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function readMd(name: string): string {
  const candidates = [
    join(HERE, name),
    join(HERE, "..", "..", "..", "src", "agents", "shared", name),
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
