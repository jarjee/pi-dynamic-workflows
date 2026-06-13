import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ActiveWorkflowStore } from "./active-workflow.js";
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
    hostTools: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("none"), Type.Array(Type.String())])),
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    hardAbortGraceMs: Type.Optional(Type.Number({ minimum: 0 })),
    projectRoles: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
    mailboxPauseTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    modelsByWeight: Type.Optional(
      Type.Object({
        light: Type.Optional(Type.String()),
        medium: Type.Optional(Type.String()),
        heavy: Type.Optional(Type.String()),
      }),
    ),
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
    description:
      "Raw JavaScript. First statement: export const meta = { name, description }. Must call agent() or spawn() at least once.",
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

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docsDir = join(packageRoot, "docs");
const _docPath = join(packageRoot, "DOCS.md");

const WORKFLOW_MINIMAL_EXAMPLE = [
  'export const meta = { name: "example", description: "..." }',
  "",
  'registerPhase("Scan", async () => {',
  '  return await agent("Scan the codebase", { label: "scan", model: "provider/fast-model" })',
  "})",
  "",
  'registerPhase("Review", async (ctx) => {',
  "  const ref = handoff(ctx)",
  '  const reviews = await parallel(["security", "perf", "style"].map(aspect => () =>',
  '    agent("Review " + aspect + ". Context:\\n" + ref, { label: "review-" + aspect, model: "provider/code-model" })',
  "  ))",
  "  return reviews.filter(Boolean)",
  "})",
  "",
  'registerPhase("Synthesize", async (reviews) => {',
  '  return await agent("Synthesize findings:\\n" + handoff(reviews), { label: "synthesis", model: "provider/reasoning-model", thinkingLevel: "high" })',
  "})",
].join("\n");

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  hardAbortGraceMs?: number;
  /** Compatibility escape hatch for executable custom tools supplied by an embedding host. */
  extensionTools?: ToolDefinition[];
  /** Host extension tool names inherited from the parent Pi session (e.g. MCP/Glean). Evaluated per workflow execution when a function is supplied. */
  hostToolNames?: string[] | (() => string[]);
  /** Shared active workflow state used by interactive UI surfaces such as /workflow. */
  activeWorkflowStore?: ActiveWorkflowStore;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Orchestrate multiple subagents in a JavaScript workflow script using registerPhase(), agent(), spawn(), parallel(), and pipeline().",
    promptSnippet: `Orchestrate subagents via a JavaScript workflow script. Pass raw JS with \`export const meta = { name, description }\` as the first statement. Use registerPhase() for top-level phase declarations and automatic data flow. Globals: registerPhase, agent, spawn, parallel, pipeline, phase, log, handoff, mailbox, args, cwd, budget, policy. handoff() is synchronous (within phases only).`,
    executionMode: "sequential",
    promptGuidelines: [
      `# Workflow Script Rules`,
      "",
      `- Plain JavaScript only — no TypeScript, no imports, no require, no fs.`,
      `- \`export const meta = { name, description }\` must be the first statement.`,
      `- Date.now(), new Date(), and Math.random() are unavailable — orchestration must be deterministic.`,
      `- Delegate file operations to subagents via their \`tools\` option; workflow scripts have no direct tools.`,
      `- Do NOT embed backtick template literals inside the script string argument. When building subagent prompts with variable interpolation, use string concatenation (\`"prefix " + variable + " suffix"\`) or \`.join()\` instead of nested templates.`,
      "",
      `# Phase Registration DSL`,
      "",
      `Use \`registerPhase(name, body, options?)\` to declare phases at the top level. Phases execute in declaration order. The body receives the previous phase's return value. The body's return value flows to the next phase automatically — no manual wiring needed. This kills the [object Promise] footgun at its source.`,
      "",
      `All existing primitives work inside phase bodies: agent(), spawn(), parallel(), pipeline(), handoff(), log(), mailbox.`,
      "",
      `The runtime wraps subagent prompts with iteration context. On retry (gate failure), the subagent sees \`<retry>failure details</retry>\` injected into its prompt. The body writes ONE prompt — no conditional branching for retries.`,
      "",
      `## registerPhase() options`,
      "",
      `- \`gate: async (output, upstreamOutput) => string | null\` — validates the phase body's return value. Return null to pass (advance to next phase). Return a string describing the failure to trigger a retry — the failure string is injected into the body's subagent prompt as \`<retry>failure string</retry>\`.`,
      `- \`maxIterations: number\` — max attempts including the first run. Default 1 (no retries). When a gate is present, default 3.`,
      `- \`skipIf: (input) => boolean\` — skip the phase entirely if the condition is met. Skipped phases show as "skipped" in the progress UI.`,
      "",
      `## Exhausted iterations`,
      "",
      `When maxIterations is exhausted (all attempts failed gate), the phase returns its last output with metadata: \`{ ...output, __phaseMeta: { exhausted: true, iteration: N, gateError: "..." } }\`. Downstream phases can check \`input.__phaseMeta?.exhausted\` to decide whether to halt or continue degraded.`,
      "",
      `# Subagent Rules`,
      "",
      `## Model selection`,
      "",
      `Use explicit \`provider/model\` refs. Bare model names will fail. Combined with \`thinkingLevel\` for effort control. Match model capability to task complexity:`,
      `- Cheap scans, grep, classification, fan-out: a fast configured model such as \`provider/fast-model\``,
      `- Code generation, review, implementation: a stronger configured code model such as \`provider/code-model\``,
      `- Architecture, adversarial review, final synthesis: a configured reasoning/frontier model such as \`provider/reasoning-model\``,
      `- \`thinkingLevel: "high"\` — combine with heavy models for complex reasoning tasks`,
      "",
      `## agent() / spawn() rules`,
      "",
      `- Every agent()/spawn() call must include a unique short \`label\` (2-5 words) for readable progress.`,
      `- parallel() takes functions, not promises: \`await parallel(items.map(item => () => agent(...)))\`. Results return in input order.`,
      `- Failed branches return null. Always filter with \`results.filter(Boolean)\` before passing to downstream agents. Await all upstream lanes before the final synthesis agent.`,
      `- Default subagent tools are read-only ['read', 'grep', 'find', 'ls']; host tools may also be ambient when policy permits. Add 'bash', 'edit', 'write' only for side-effectful lanes.`,
      "",
      `## handoff()`,
      "",
      `Use handoff() WITHIN a phase body to pass data to subagents inside that phase. It is synchronous — no await needed. Example:`,
      `  const data = await agent("scan", { label: "scan", model: "provider/fast-model" })`,
      `  const ref = handoff(data)  // sync, returns string`,
      `  await agent("analyze: " + ref, { label: "analyze", model: "provider/code-model" })`,
      "",
      `Do NOT use handoff() BETWEEN phases — cross-phase data flows automatically through return/input. WRONG:`,
      `  registerPhase("A", async () => { return await agent(...) })`,
      `  const ref = handoff(resultOfPhaseA)  // ERROR: phase A's result is not accessible here`,
      `  registerPhase("B", async (input) => { ... })  // CORRECT: input IS phase A's return value`,
      "",
      `# Side Effects & Validation`,
      "",
      `- If any parallel lane can edit/write/run bash, state explicit non-overlapping file ownership in each lane prompt. If ownership overlaps, serialize lanes or add dependencies.`,
      `- Side-effectful workflows must end with a validation/repair check. Use a gate or a standalone validation phase. Progress and final summaries must be user-facing evidence, not scratchpad notes.`,
      `- For safety-critical edits, add a validation phase after implementation that runs the project's linter, type checker, and tests. If the gate fails, the iteration model retries the implementation with test failure context injected into the prompt.`,
      "",
      `# Team Coordination (spawn + mailbox)`,
      "",
      `For multi-agent teams with directed communication, use spawn() + mailbox inside a phase body. Keep mailbox flows bounded: avoid circular waits, do not ask multiple agents to pause waiting on each other unless a peer is guaranteed to send a message, and prefer one-shot handoffs for simple coordination.`,
      `  const arch = spawn("Design the interface and send it to the worker once", { label: "architect", mailbox: true, model: "provider/reasoning-model" })`,
      `  const worker = spawn("Wait for one design message, acknowledge it, then finish", { label: "worker", mailbox: true, model: "provider/code-model", tools: ["edit", "write"] })`,
      `  mailbox.connect(arch.id, worker.id)`,
      `  await parallel([() => arch.result, () => worker.result])`,
      `Mailbox-enabled agents receive mailbox_peers, mailbox_send, and mailbox_pause tools. Channel permissions are one-way (mailbox.allow makes A->B; mailbox.connect makes bidirectional). Always await all spawn handles before the body returns — leaked handles fail the workflow. If a mailbox team may wait, set a short policy.mailboxPauseTimeoutSeconds and include an explicit fallback.`,
      "",
      `# Terminology (use these terms consistently)`,
      `- Subagent: an agent spawned inside a workflow via agent() or spawn()`,
      `- Model: explicit provider/model string (e.g. "provider/fast-model"). Bare model names fail. Combine with thinkingLevel for effort`,
      `- Mailbox: communication channel between spawned subagents. Use spawn() + mailbox: true`,
      `- Handoff: serialized data passed between agents WITHIN a phase. Synchronous, returns string`,
      `- Phase: top-level work unit declared via registerPhase(). Groups subagents in the UI`,
      `- Lane: one parallel branch of work — a single function in a parallel() call`,
      `- Policy: frozen runtime policy (defaultTools, hostTools, maxConcurrency)`,
      "",
      `# Minimal valid workflow`,
      "```js",
      WORKFLOW_MINIMAL_EXAMPLE,
      "```",
      "",
      `# Workflow with gate (implementation + validation)`,
      "```js",
      'export const meta = { name: "impl_feature", description: "Implement a feature with test gate" }',
      "",
      'registerPhase("Plan", async () => {',
      '  return await agent("Create a detailed plan", { label: "plan", model: "provider/reasoning-model", thinkingLevel: "high" })',
      "})",
      "",
      'registerPhase("Implement", async (plan) => {',
      "  const ref = handoff(plan)",
      '  return await parallel(["auth", "billing"].map(mod => () =>',
      '    agent("Implement " + mod + " from plan:\n" + ref, {',
      '      label: "impl-" + mod, model: "provider/code-model",',
      '      tools: ["read", "edit", "write"],',
      "    })",
      "  ))",
      "}, {",
      "  gate: async (output, plan) => {",
      '    const result = await agent("Run npm test and report failures verbatim", {',
      '      label: "run-tests", model: "provider/fast-model", tools: ["bash"],',
      "    })",
      '    return result.includes("FAIL") ? result : null',
      "  },",
      "  maxIterations: 3,",
      "})",
      "",
      'registerPhase("Synthesize", async (impl) => {',
      '  return await agent("Executive summary:\n" + handoff(impl), {',
      '    label: "synthesis", model: "provider/reasoning-model",',
      "  })",
      "})",
      "```",
      "",
      `# Advanced reference (rarely needed)`,
      `- Full API (pipeline, schema, retry, recovery): ${docsDir}/workflow-api.md`,
      `- Team composition patterns: ${docsDir}/teams.md`,
      `- Side-effect rules and file ownership: ${docsDir}/side-effects.md`,
      `- Phase registration DSL spec: ${docsDir}/register-phase-dsl.md`,
      `- ADRs and project glossary: ${join(packageRoot, "CONTEXT.md")}`,
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const activeWorkflow = options.activeWorkflowStore?.create(snapshot);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, {
        ...workflowDisplayOptions,
        showResultPreviews: ctx.ui.getToolsExpanded(),
      });

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        activeWorkflow?.update(snapshot);
        display.update(snapshot);
      };

      const completeDisplay = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        activeWorkflow?.update(snapshot, true);
        display.complete(snapshot);
      };

      try {
        const recordPhase = (title: string | undefined) => {
          if (!title) return;
          if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
        };

        const completedResults = new Map<string, unknown>();
        let result: WorkflowRunResult;
        try {
          result = await runWorkflow(script, {
            cwd: options.cwd ?? ctx.cwd,
            args: params.args,
            signal,
            concurrency: options.concurrency,
            hardAbortGraceMs: options.hardAbortGraceMs,
            policy: params.policy,
            customTools: options.extensionTools,
            hostToolNames:
              typeof options.hostToolNames === "function" ? options.hostToolNames() : options.hostToolNames,
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
                model: event.model ?? modelRef(ctx.model),
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
              if (event.result !== null) {
                completedResults.set(event.label, event.result);
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
            completeDisplay();
            throw new Error("Workflow was aborted");
          }
          // Partial recovery: persist completed agent results so a follow-up
          // workflow can pick up where this one failed.
          const recovery = persistRecovery(completedResults, snapshot, error);
          completeDisplay();
          return {
            content: [
              {
                type: "text" as const,
                text: formatRecoveryMessage(error, recovery, snapshot),
              },
            ],
            details: { ...snapshot, error: error instanceof Error ? error.message : String(error), recovery },
          };
        }

        if (result.agentCount === 0) {
          throw new Error(
            "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
          );
        }

        snapshot.result = result.result;
        snapshot.durationMs = result.durationMs;
        completeDisplay();

        const mailboxText = result.mailbox
          ? `\n\nMailbox transcript: ${result.mailbox.transcriptPath} (${result.mailbox.eventCount} event(s))`
          : "";

        return {
          content: [
            {
              type: "text",
              text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).${mailboxText}\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
            },
          ],
          details: {
            ...snapshot,
            meta: result.meta,
            phases: result.phases,
            logs: result.logs,
            result: result.result,
            durationMs: result.durationMs,
            mailbox: result.mailbox,
          },
        };
      } finally {
        if (activeWorkflow) options.activeWorkflowStore?.clear(activeWorkflow);
      }
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

function modelRef(model: { provider?: string; id?: string } | undefined): string | undefined {
  if (!model?.provider || !model.id) return undefined;
  return `${model.provider}/${model.id}`;
}

interface RecoveryInfo {
  recoveryDir: string;
  completedAgents: Array<{ label: string; resultFile: string }>;
  failedAgents: string[];
  runningAgents: string[];
}

function persistRecovery(
  completedResults: Map<string, unknown>,
  snapshot: WorkflowSnapshot,
  _error: unknown,
): RecoveryInfo {
  const completedAgents: RecoveryInfo["completedAgents"] = [];
  const failedAgents: string[] = [];
  const runningAgents: string[] = [];

  for (const agent of snapshot.agents) {
    if (agent.status === "done") {
      // will be written below
    } else if (agent.status === "error") {
      failedAgents.push(agent.label);
    } else if (agent.status === "running") {
      runningAgents.push(agent.label);
    }
  }

  if (completedResults.size === 0) {
    return { recoveryDir: "", completedAgents, failedAgents, runningAgents };
  }

  const recoveryDir = mkdtempSync(join(tmpdir(), "pi-workflow-recovery-"));
  let index = 0;
  for (const [label, result] of completedResults) {
    const filename = `${String(index++).padStart(3, "0")}-${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    const filePath = join(recoveryDir, filename);
    writeFileSync(filePath, JSON.stringify({ label, result }, null, 2), { encoding: "utf8", mode: 0o600 });
    completedAgents.push({ label, resultFile: filePath });
  }

  // Write a manifest for easy discovery
  writeFileSync(
    join(recoveryDir, "manifest.json"),
    JSON.stringify({ completedAgents, failedAgents, runningAgents }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );

  return { recoveryDir, completedAgents, failedAgents, runningAgents };
}

function formatRecoveryMessage(error: unknown, recovery: RecoveryInfo, snapshot: WorkflowSnapshot): string {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const lines = [`Workflow failed: ${errorMsg}`];
  lines.push(
    `\nCompleted: ${recovery.completedAgents.length} agent(s), Failed: ${recovery.failedAgents.length}, Running: ${recovery.runningAgents.length}`,
  );
  lines.push(`Phases reached: ${snapshot.phases.join(", ") || "(none)"}`);

  if (recovery.completedAgents.length > 0) {
    lines.push(`\nRecovery directory: ${recovery.recoveryDir}`);
    lines.push("Completed agent results (read these to continue from where the workflow failed):");
    for (const agent of recovery.completedAgents) {
      lines.push(`  - ${agent.label}: ${agent.resultFile}`);
    }
    lines.push(`  - manifest: ${join(recovery.recoveryDir, "manifest.json")}`);
  }

  if (recovery.failedAgents.length > 0) {
    lines.push(`\nFailed agents: ${recovery.failedAgents.join(", ")}`);
  }

  if (snapshot.logs.length > 0) {
    lines.push(`\nWorkflow logs:`);
    for (const log of snapshot.logs.slice(-10)) {
      lines.push(`  ${log}`);
    }
  }

  lines.push("\nYou can write a new workflow that reads the recovery files to continue from where this one failed.");
  return lines.join("\n");
}
