import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import { normalizeWorkflowPolicy, type WorkflowPolicy } from "./policy.js";
import { parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";

const workflowPolicySchema = Type.Optional(
  Type.Object({
    defaultTools: Type.Optional(Type.Array(Type.String())),
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    hardAbortGraceMs: Type.Optional(Type.Number({ minimum: 0 })),
    projectRoles: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
    mailboxPauseTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    modelsByStream: Type.Optional(
      Type.Object({
        light: Type.Optional(Type.String()),
        medium: Type.Optional(Type.String()),
        heavy: Type.Optional(Type.String()),
      }),
    ),
  }),
);

const workflowToolSchema = Type.Object({
  script: Type.String({
    description: [
      "Required raw JavaScript workflow script, with no Markdown fences.",
      "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
      "Use phase('Name'), agent(prompt, opts), spawn(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), handoff(value, opts), mailbox, log(message), args, and budget. The workflow must call agent() or spawn() at least once.",
      "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
    ].join(" "),
  }),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
  policy: workflowPolicySchema,
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
  policy?: WorkflowPolicy;
};

const workflowDisplayOptions = {
  key: "workflow",
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: false,
} as const;

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  hardAbortGraceMs?: number;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
      "For workflow, available globals are agent(prompt, opts), spawn(prompt, opts), parallel(thunks), pipeline(items, ...stages), handoff(value, opts), mailbox, phase(title), log(message), args, cwd, process.cwd(), policy, and budget. Every workflow must call agent() or spawn() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
      "For workflow, first gate fit: use it only when there are multiple independent work streams, distinct areas of expertise, broad context gathering, or repeatable quality gates. Avoid workflows for mostly sequential work, tightly coupled edits, single-file tasks, or work likely to need user input midway.",
      "For workflow, before writing the script identify the goal, scope, stream boundaries, file ownership for any side-effectful lanes, dependencies, and expected deliverables.",
      "For workflow, pick work stream based on required power: light for cheap summarization/classification over many items, medium for normal code generation or repo review, and heavy for architecture, final synthesis, adversarial critique, or quality gates.",
      "For workflow, side-effectful implementation lanes must have explicit non-overlapping file or directory ownership in their prompts. Serialize lanes or add dependencies when ownership overlaps.",
      "For workflow, side-effectful workflows need an explicit validation gate after edits: run the project's formatter/linter/typecheck/tests as appropriate, capture failures, fix them, and only then synthesize or report completion. Do not commit or call the work done before validation passes unless the user explicitly asked to skip it.",
      "For workflow, keep progress/status text user-meaningful. Do not expose scratchpad notes like 'Need biome' or 'Run commit'; report concrete actions, evidence, failures, and next steps.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
      "For workflow, use agent() for simple awaited subagents and spawn() when you need an id, status(), result handle, mailbox communication, or non-blocking setup. Public spawn handles must be awaited before workflow return; leaked running/paused handles fail the workflow and are cleaned up.",
      "For workflow, every agent()/spawn() call may include a built-in tool allowlist such as { tools: ['read', 'grep', 'find', 'ls'] }. Omit tools for the runtime default read-only tools; use tools: [] for no coding tools. Add bash, edit, or write only when the subagent truly needs side effects.",
      "For workflow, agent() may include a source-qualified reusable role such as { role: 'package:reviewer' }. Use package roles for common reviewer, critic, scout, planner, synthesizer, and worker behavior. Project roles are repository-controlled and denied unless the host explicitly allows them.",
      "For workflow, agent()/spawn() may include model: 'provider/model-id' to run that subagent on a configured Pi model, or stream: 'light' | 'medium' | 'heavy' to let runtime policy route the model. thinkingLevel is separate and may be 'off', 'minimal', 'low', 'medium', 'high', or 'xhigh'. Unknown explicit model refs fail before launch.",
      "For workflow, agent()/spawn() may include timeoutSeconds and retry: { attempts, delayMs, backoff }. retry.attempts includes the first attempt; failed intermediate attempts are logged, and exhausted branches return null unless the workflow is aborted.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For workflow, use handoff(value, { inlineLimit }) before passing potentially large upstream outputs to later agents; it returns inline text for small values and a temp-file instruction for large values.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.update(snapshot);
      };

      const recordPhase = (title: string | undefined) => {
        if (!title) return;
        if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
      };

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          cwd: options.cwd ?? ctx.cwd,
          args: params.args,
          signal,
          concurrency: options.concurrency,
          hardAbortGraceMs: options.hardAbortGraceMs,
          policy: params.policy,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
          },
          onLog(message) {
            snapshot.logs.push(message);
            update();
          },
          onPhase(title) {
            snapshot.currentPhase = title;
            recordPhase(title);
            update();
          },
          onAgentStart(event) {
            if (signal?.aborted) throw new Error("Workflow was aborted");
            recordPhase(event.phase);
            snapshot.agents.push({
              id: snapshot.agents.length + 1,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "running",
            });
            update();
          },
          onAgentEnd(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === "running");
            if (agent) {
              agent.status = event.result === null ? "error" : "done";
              agent.resultPreview = preview(event.result);
            }
            update();
          },
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      return {
        content: [
          {
            type: "text",
            text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
  const value = args as Record<string, unknown>;
  if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
  return {
    ...value,
    script: normalizeWorkflowScript(value.script),
    policy: normalizeWorkflowPolicy(value.policy),
  } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
