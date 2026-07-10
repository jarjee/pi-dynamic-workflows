import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository/package root: the directory containing package.json, DOCS.md, agents/, docs/. */
export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directory containing the bundled role prompt markdown files (agents/*.md). */
export const agentsDir = join(packageRoot, "agents");

/** Directory containing the reference markdown docs (workflow-api.md, teams.md, etc.). */
export const docsDir = join(packageRoot, "docs");
