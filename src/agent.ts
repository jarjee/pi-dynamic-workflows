import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { WorkflowHostToolPolicy } from "./policy.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Built-in coding tools available when an agent call omits its own tools allowlist. */
  defaultTools?: string[];
  /** Host extension tool names inherited from the parent Pi session (e.g. MCP/Glean). */
  hostToolNames?: string[];
  /** Controls which host tools are ambient when an agent omits its tools option. */
  hostToolPolicy?: WorkflowHostToolPolicy;
  /** Additional custom tool definitions always available to subagents, separate from built-in coding tools. */
  customTools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  /** Provider/model id to use for this subagent, e.g. anthropic/claude-opus-4-6. */
  model?: string;
  /** Model thinking effort for this subagent. */
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** Built-in/host tool name allowlist for this subagent. Omit to use runtime defaults; [] exposes no ordinary tools. */
  tools?: string[];
  /** Extra custom tools for this subagent, in addition to selected built-ins. */
  customTools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

const DEFAULT_WORKFLOW_TOOLS = ["read", "grep", "find", "ls"];
const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly hostToolNames: string[];
  private readonly customTools: ToolDefinition[];
  private readonly defaultTools?: string[];
  private readonly hostToolPolicy?: WorkflowHostToolPolicy;
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly activeSessions = new Set<{ abort(): void; dispose(): void }>();

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.hostToolNames = uniqueStrings(options.hostToolNames ?? []).filter((name) => !BUILT_IN_TOOL_NAMES.has(name));
    this.customTools = options.customTools ?? [];
    this.defaultTools = options.defaultTools;
    this.hostToolPolicy = options.hostToolPolicy;
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const customTools: ToolDefinition[] = [...this.customTools, ...(options.customTools ?? [])];

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    const toolNames = uniqueStrings([
      ...this.selectOrdinaryToolNames(options.tools),
      ...customTools.map((tool) => tool.name),
    ]);

    const agentDir = getAgentDir();
    const model = this.resolveModel(options.model);
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      tools: toolNames,
      customTools,
      ...this.sessionOptions,
      ...(model ? { model } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });

    this.assertRequestedToolsAvailable(toolNames, session.getActiveToolNames());

    let removeAbortListener: (() => void) | undefined;
    this.activeSessions.add(session);
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      if (options.schema) {
        if (!capture.called) {
          throw new Error("Subagent finished without calling structured_output");
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } finally {
      removeAbortListener?.();
      this.activeSessions.delete(session);
      session.dispose();
    }
  }

  abortAll(_reason?: string): void {
    for (const session of this.activeSessions) session.abort();
  }

  disposeAll(): void {
    for (const session of this.activeSessions) session.dispose();
    this.activeSessions.clear();
  }

  private resolveModel(ref: string | undefined) {
    if (!ref) return undefined;
    const separator = ref.indexOf("/");
    if (separator <= 0 || separator === ref.length - 1) {
      throw new Error(`Workflow subagent model must be provider/model: ${ref}`);
    }
    const provider = ref.slice(0, separator);
    const modelId = ref.slice(separator + 1);
    const model = this.sessionOptions.modelRegistry?.find(provider, modelId);
    if (!model) throw new Error(`Unknown workflow subagent model: ${ref}`);
    return model;
  }

  private selectOrdinaryToolNames(names: string[] | undefined): string[] {
    if (names !== undefined) return names;
    if (this.defaultTools !== undefined) return this.defaultTools;
    return [...DEFAULT_WORKFLOW_TOOLS, ...this.selectAmbientHostToolNames()];
  }

  private selectAmbientHostToolNames(): string[] {
    const policy = this.hostToolPolicy;
    if (policy === "none") return [];
    if (Array.isArray(policy)) return policy.filter((name) => this.hostToolNames.includes(name));
    return this.hostToolNames;
  }

  private assertRequestedToolsAvailable(requested: string[], active: string[]): void {
    const activeSet = new Set(active);
    const missing = requested.filter((name) => !activeSet.has(name));
    if (missing.length > 0) {
      throw new Error(`Unknown or unavailable workflow subagent tool: ${missing.join(", ")}`);
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
