import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Returns the absolute path to the bundled dist/skills/ directory.
 *
 * The plugin ships as ESM (tsup default). `import.meta.url` resolves to the
 * plugin's own dist/index.js, which lives alongside dist/skills/ in the
 * tsup-emitted output. Resolving relative to the module URL is both simple
 * and robust against npm-cache path variance.
 *
 * No createRequire / require.resolve needed — verified by Spike 1 against
 * OpenCode 1.14.19 on macOS.
 */
export function getSkillsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "skills");
}
