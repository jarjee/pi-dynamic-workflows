import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultPackageDir = join(packageRoot, "agents");

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
  return [`Role ${role.ref}:`, role.prompt.trim()].join("\n\n");
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
