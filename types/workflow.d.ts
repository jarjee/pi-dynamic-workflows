/**
 * Ambient globals available inside pi-dynamic-workflows workflow scripts.
 *
 * Add this to a JavaScript or TypeScript workflow file for editor IntelliSense:
 *
 *   /// <reference types="pi-dynamic-workflows/workflow" />
 */

export {};

declare global {
  /** Literal workflow metadata. Must be the first statement: `export const meta = { ... }`. */
  interface WorkflowMeta {
    name: string;
    description: string;
    whenToUse?: string;
    /** Optional documentation for an expected outline. Live progress is driven by `phase(...)`. */
    phases?: WorkflowMetaPhase[];
  }

  interface WorkflowMetaPhase {
    title: string;
    detail?: string;
    model?: string;
  }

  interface WorkflowAgentRetryOptions {
    /** Total attempts including the first try. */
    attempts?: number;
    /** Delay before retrying, in milliseconds. */
    delayMs?: number;
    /** Retry delay shape. Defaults to exponential. */
    backoff?: "constant" | "exponential";
  }

  interface WorkflowAgentOptions<TSchema = JsonSchema> {
    /** Short label shown in the live progress UI. */
    label?: string;
    /** Override the current runtime phase for this agent. */
    phase?: string;
    /** JSON Schema for structured output. When present, the returned value is typed as unknown unless you provide a generic. */
    schema?: TSchema;
    /** Provider/model id to use for this subagent, e.g. anthropic/claude-opus-4-6. */
    model?: string;
    /** Requested isolation mode. */
    isolation?: "worktree";
    /** Requested subagent role/type. */
    agentType?: string;
    /** Built-in coding tools to expose. Omit for runtime defaults; [] exposes no coding tools. */
    tools?: Array<"read" | "grep" | "find" | "ls" | "bash" | "edit" | "write" | string>;
    /** Maximum wall-clock time for each subagent attempt. */
    timeoutSeconds?: number;
    /** Retry failed subagent attempts before returning null. */
    retry?: WorkflowAgentRetryOptions;
    /** Source-qualified reusable role prompt, e.g. package:reviewer. */
    role?: `package:${string}` | `user:${string}` | `project:${string}`;
  }

  type JsonPrimitive = string | number | boolean | null;
  type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
  interface JsonObject {
    [key: string]: JsonValue;
  }

  interface JsonSchema {
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema | JsonSchema[];
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    enum?: JsonValue[];
    const?: JsonValue;
    description?: string;
    [key: string]: unknown;
  }

  interface WorkflowBudget {
    total: number | null;
    spent(): number;
    remaining(): number;
  }

  interface WorkflowPolicy {
    defaultTools?: string[];
    maxConcurrency?: number;
    hardAbortGraceMs?: number;
    projectRoles?: "deny" | "allow";
  }

  /** Spawn a subagent. Returns final text unless a structured-output schema is used with an explicit generic. */
  function agent<T = string>(prompt: string, options?: WorkflowAgentOptions): Promise<T>;

  /** Run independent async tasks concurrently. Pass functions, not already-created promises. */
  function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;

  /** Run each item through sequential async stages while different items may run concurrently. */
  function pipeline<TItem, TResult = unknown>(
    items: TItem[],
    ...stages: Array<(previous: unknown, original: TItem, index: number) => TResult | Promise<TResult>>
  ): Promise<TResult[]>;

  /** Mark the current workflow phase for progress grouping. */
  function phase(title: string): void;

  /** Append a workflow-level log line. */
  function log(message: unknown): void;

  /** Optional JSON args passed to the workflow tool. Narrow with a local type assertion when needed. */
  const args: unknown;

  /** Runtime-enforced workflow policy selected by the host/tool call. */
  const policy: Readonly<WorkflowPolicy>;

  /** Current working directory for the workflow/subagents. */
  const cwd: string;

  /** Deterministic process shim exposing only cwd(). */
  const process: { cwd(): string };

  /** Simple token-budget estimate for workflow runs. */
  const budget: WorkflowBudget;
}
