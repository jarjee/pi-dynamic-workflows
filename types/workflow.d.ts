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
  }

  interface WorkflowAgentRetryOptions {
    /** Total attempts including the first try. */
    attempts?: number;
    /** Delay before retrying, in milliseconds. */
    delayMs?: number;
    /** Retry delay shape. Defaults to exponential. */
    backoff?: "constant" | "exponential";
  }

  type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

  interface WorkflowAgentOptions<TSchema = JsonSchema> {
    /** Short label shown in the live progress UI. */
    label?: string;
    /** Override the current runtime phase for this agent. */
    phase?: string;
    /** JSON Schema for structured output. When present, the returned value is typed as unknown unless you provide a generic. */
    schema?: TSchema;
    /** Provider/model id to use for this subagent, e.g. anthropic/claude-opus-4-6. */
    model?: string;
    /** Model thinking effort for this subagent. */
    thinkingLevel?: WorkflowThinkingLevel;
    /** Built-in coding tools to expose. Omit for runtime defaults; [] exposes no coding tools. */
    tools?: Array<"read" | "grep" | "find" | "ls" | "bash" | "edit" | "write" | string>;
    /** Maximum wall-clock time for each subagent attempt. */
    timeoutSeconds?: number;
    /** Retry failed subagent attempts before returning null. */
    retry?: WorkflowAgentRetryOptions;
    /** Source-qualified reusable role prompt, e.g. package:reviewer. */
    role?: `package:${string}` | `user:${string}` | `project:${string}`;
    /** Enable directed mailbox communication tools for this spawned agent. */
    mailbox?: boolean | { peers?: string[] };
    /** Reserved for future explicit extension tool grants; currently unsupported and fails closed. */
    extensionTools?: never;
    /** Reserved for future caller skill grants; currently unsupported and fails closed. */
    callerSkills?: never;
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

  type WorkflowAgentStatus = "starting" | "running" | "paused" | "completed" | "failed" | "aborted";

  /** Display/snapshot status of a workflow subagent (distinct from the runtime {@link WorkflowAgentStatus}). */
  type WorkflowAgentSnapshotStatus = "queued" | "running" | "done" | "error" | "skipped";

  interface WorkflowAgentHandle<T = unknown> {
    id: string;
    label: string;
    result: Promise<T | null>;
    status(): WorkflowAgentStatus;
  }

  interface WorkflowPolicy {
    defaultTools?: string[];
    hostTools?: "all" | "none" | string[];
    maxConcurrency?: number;
    hardAbortGraceMs?: number;
    projectRoles?: "deny" | "allow";
    mailboxPauseTimeoutSeconds?: number;
  }

  /** Spawn a subagent and return a handle immediately. Use this for mailbox communication or status tracking. */
  function spawn<T = string>(prompt: string, options?: WorkflowAgentOptions): WorkflowAgentHandle<T>;

  /** Spawn a subagent and await its result. Returns final text unless a structured-output schema is used with an explicit generic. */
  function agent<T = string>(prompt: string, options?: WorkflowAgentOptions): Promise<T>;

  /** Phase registration options. */
  interface WorkflowRegisterPhaseOptions {
    /** Validates the phase body's return value. Return null to pass (advance); return a string to retry. */
    gate?: (output: unknown, upstreamOutput: unknown) => Promise<string | null> | string | null;
    /** Max attempts including the first run. Default 1; when `gate` is present, default 3. */
    maxIterations?: number;
    /** Skip the phase entirely when this returns true. */
    skipIf?: (input: unknown) => boolean;
  }

  /** Declare a top-level phase. Phases execute in declaration order; each body receives the previous phase's return value. */
  function registerPhase(
    name: string,
    body: (input: unknown) => unknown | Promise<unknown>,
    options?: WorkflowRegisterPhaseOptions,
  ): void;

  const mailbox: {
    allow(fromId: string, toId: string): void;
    connect(aId: string, bId: string): void;
    send(toId: string, message: string): Promise<unknown>;
  };

  /** Run independent async tasks concurrently. Pass functions, not already-created promises. */
  function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;

  /** Materialize a large upstream value to a temp file when it exceeds inlineLimit. */
  function handoff(value: unknown, options?: { inlineLimit?: number }): string;

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

  /** Deterministic console shim (log/info/warn/error append to workflow logs). */
  const console: Pick<Console, "log" | "info" | "warn" | "error">;

  /** Simple token-budget estimate for workflow runs. */
  const budget: WorkflowBudget;
}
