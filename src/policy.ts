import type { ProjectRolePolicy } from "./roles.js";

export interface WorkflowPolicy {
  defaultTools?: string[];
  maxConcurrency?: number;
  hardAbortGraceMs?: number;
  projectRoles?: ProjectRolePolicy;
}

export function normalizeWorkflowPolicy(value: unknown): WorkflowPolicy {
  if (value === undefined) return {};
  if (!value || typeof value !== "object") throw new TypeError("workflow policy must be an object");
  const policy = value as WorkflowPolicy;
  return {
    defaultTools: optionalStringArray(policy.defaultTools, "policy.defaultTools"),
    maxConcurrency: optionalPositiveInteger(policy.maxConcurrency, "policy.maxConcurrency"),
    hardAbortGraceMs: optionalNonNegativeNumber(policy.hardAbortGraceMs, "policy.hardAbortGraceMs"),
    projectRoles: optionalProjectRolePolicy(policy.projectRoles),
  };
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of strings`);
  return Array.from(value, (item, index) => {
    if (typeof item !== "string") throw new TypeError(`${name}[${index}] must be a string`);
    return item;
  });
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError(`${name} must be a positive integer`);
  return value as number;
}

function optionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function optionalProjectRolePolicy(value: unknown): ProjectRolePolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== "deny" && value !== "allow") throw new TypeError('policy.projectRoles must be "deny" or "allow"');
  return value;
}
