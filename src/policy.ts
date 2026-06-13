import type { ProjectRolePolicy } from "./roles.js";

export type WorkflowWeight = "light" | "medium" | "heavy";
/** @deprecated Use WorkflowWeight. */
export type WorkflowStream = WorkflowWeight;
export type WorkflowHostToolPolicy = "all" | "none" | string[];

export interface WorkflowPolicy {
  defaultTools?: string[];
  hostTools?: WorkflowHostToolPolicy;
  maxConcurrency?: number;
  hardAbortGraceMs?: number;
  projectRoles?: ProjectRolePolicy;
  modelsByWeight?: Partial<Record<WorkflowWeight, string>>;
  /** @deprecated Use modelsByWeight. */
  modelsByStream?: Partial<Record<WorkflowWeight, string>>;
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
    modelsByWeight: optionalModelsByWeight(policy.modelsByWeight, "policy.modelsByWeight"),
    modelsByStream: optionalModelsByWeight(policy.modelsByStream, "policy.modelsByStream"),
    mailboxPauseTimeoutSeconds: optionalNonNegativeNumber(
      policy.mailboxPauseTimeoutSeconds,
      "policy.mailboxPauseTimeoutSeconds",
    ),
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

function optionalHostToolPolicy(value: unknown): WorkflowHostToolPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "all" || value === "none") return value;
  return optionalStringArray(value, "policy.hostTools");
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

function optionalModelsByWeight(value: unknown, name: string): Partial<Record<WorkflowWeight, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new TypeError(`${name} must be an object`);
  const input = value as Record<string, unknown>;
  const out: Partial<Record<WorkflowWeight, string>> = {};
  for (const weight of ["light", "medium", "heavy"] as const) {
    const model = input[weight];
    if (model === undefined) continue;
    if (typeof model !== "string" || !model.trim()) {
      throw new TypeError(`${name}.${weight} must be a non-empty string`);
    }
    out[weight] = model;
  }
  return out;
}
