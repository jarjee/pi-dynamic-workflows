import type { ProjectRolePolicy } from "./roles.js";
import { optionalNonNegativeNumber, optionalPositiveInteger, optionalStringArray } from "./validators.js";

export type WorkflowHostToolPolicy = "all" | "none" | string[];

export interface WorkflowPolicy {
  defaultTools?: string[];
  hostTools?: WorkflowHostToolPolicy;
  maxConcurrency?: number;
  hardAbortGraceMs?: number;
  projectRoles?: ProjectRolePolicy;
  mailboxPauseTimeoutSeconds?: number;
}

export function normalizeWorkflowPolicy(value: unknown): WorkflowPolicy {
  if (value === undefined) return {};
  if (!value || typeof value !== "object") throw new TypeError("workflow policy must be an object");
  const policy = value as WorkflowPolicy;
  return {
    defaultTools: optionalStringArray(policy.defaultTools, "policy.defaultTools"),
    hostTools: optionalHostToolPolicy(policy.hostTools),
    maxConcurrency: optionalPositiveInteger(policy.maxConcurrency, "policy.maxConcurrency"),
    hardAbortGraceMs: optionalNonNegativeNumber(policy.hardAbortGraceMs, "policy.hardAbortGraceMs"),
    projectRoles: optionalProjectRolePolicy(policy.projectRoles),
    mailboxPauseTimeoutSeconds: optionalNonNegativeNumber(
      policy.mailboxPauseTimeoutSeconds,
      "policy.mailboxPauseTimeoutSeconds",
    ),
  };
}

function optionalHostToolPolicy(value: unknown): WorkflowHostToolPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "all" || value === "none") return value;
  return optionalStringArray(value, "policy.hostTools");
}

function optionalProjectRolePolicy(value: unknown): ProjectRolePolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== "deny" && value !== "allow") throw new TypeError('policy.projectRoles must be "deny" or "allow"');
  return value;
}
