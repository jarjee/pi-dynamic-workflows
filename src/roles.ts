import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentsDir } from "./paths.js";

export type WorkflowRoleSource = "package" | "user" | "project";
export type ProjectRolePolicy = "deny" | "allow";

export interface WorkflowRoleOptions {
  packageDir?: string;
  userDir?: string;
  projectDir?: string;
  projectRoles?: ProjectRolePolicy;
}

export interface ResolvedWorkflowRole {
  ref: string;
  source: WorkflowRoleSource;
  name: string;
  prompt: string;
}

const defaultPackageDir = agentsDir;

export async function resolveWorkflowRole(
  ref: string,
  options: WorkflowRoleOptions = {},
): Promise<ResolvedWorkflowRole> {
  const parsed = parseRoleRef(ref);
  if (parsed.source === "project" && (options.projectRoles ?? "deny") !== "allow") {
    throw new Error(`Project workflow roles are denied by policy: ${ref}`);
  }
  const roleDir = roleDirectory(parsed.source, options);
  if (!roleDir) throw new Error(`No workflow role directory configured for ${parsed.source}:${parsed.name}`);
  const prompt = await readFile(join(roleDir, `${parsed.name}.md`), "utf8");
  return { ...parsed, ref, prompt };
}

export function formatWorkflowRoleInstructions(role: ResolvedWorkflowRole): string {
  return [`Role ${role.ref}:`, stripFrontmatter(role.prompt).trim()].join("\n\n");
}

/** Strip leading YAML frontmatter (--- ... ---) from a role prompt so it is not injected as instructions. */
function stripFrontmatter(prompt: string): string {
  const match = prompt.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? prompt.slice(match[0].length) : prompt;
}

function parseRoleRef(ref: string): { source: WorkflowRoleSource; name: string } {
  const match = ref.match(/^(package|user|project):([a-zA-Z0-9][a-zA-Z0-9_-]*)$/);
  if (!match) throw new Error(`Workflow role refs must be source-qualified, e.g. package:reviewer: ${ref}`);
  return { source: match[1] as WorkflowRoleSource, name: match[2] };
}

function roleDirectory(source: WorkflowRoleSource, options: WorkflowRoleOptions): string | undefined {
  switch (source) {
    case "package":
      return options.packageDir ?? defaultPackageDir;
    case "user":
      return options.userDir;
    case "project":
      return options.projectDir;
  }
}
