import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Recursively copy a directory tree
function copyDir(src: string, dst: string) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  // Treat markdown files as raw text strings (imported via ?raw)
  loader: {
    ".md": "text",
    ".sh": "text",
  },
  // Bundle everything except peer deps
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
  // After build: copy skills tree and bin scripts
  async onSuccess() {
    // Copy skills
    try {
      copyDir("src/skills", "dist/skills");
      console.log("✓ Copied src/skills → dist/skills");
    } catch (e) {
      console.warn("! Could not copy skills:", e);
    }
    // Copy agent prompts (read at runtime via readFileSync)
    try {
      copyDir("src/agents/prompts", "dist/agents/prompts");
      copyDir("src/agents/shared", "dist/agents/shared");
      console.log("✓ Copied agent prompts → dist/agents/");
    } catch (e) {
      console.warn("! Could not copy agent prompts:", e);
    }
    // Copy command prompts
    try {
      copyDir("src/commands/prompts", "dist/commands/prompts");
      console.log("✓ Copied command prompts → dist/commands/");
    } catch (e) {
      console.warn("! Could not copy command prompts:", e);
    }
    // Copy bin scripts
    try {
      mkdirSync("dist/bin", { recursive: true });
      copyFileSync(
        "src/bin/memory-mcp-launcher.sh",
        "dist/bin/memory-mcp-launcher.sh",
      );
      copyFileSync(
        "src/bin/plan-check.sh",
        "dist/bin/plan-check.sh",
      );
      console.log("✓ Copied bin scripts → dist/bin/");
    } catch (e) {
      console.warn("! Could not copy bin scripts:", e);
    }
  },
});
