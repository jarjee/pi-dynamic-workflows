import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Built-in coding tools available when an agent call omits its own tools allowlist. */
  defaultTools?: string[];
  /** Additional custom tools always available to subagents. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  /** Built-in coding tool allowlist for this subagent. Omit to use runtime defaults; [] exposes no coding tools. */
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

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly codingTools: ToolDefinition[];
  private readonly customTools: ToolDefinition[];
  private readonly defaultTools: string[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly activeSessions = new Set<{ abort(): void; dispose(): void }>();

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.codingTools = createCodingTools(this.cwd);
    this.customTools = options.tools ?? [];
    this.defaultTools = options.defaultTools ?? DEFAULT_WORKFLOW_TOOLS;
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const customTools: ToolDefinition[] = [
      ...this.selectCodingTools(options.tools ?? this.defaultTools),
      ...this.customTools,
      ...(options.customTools ?? []),
    ];

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    const agentDir = getAgentDir();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...this.sessionOptions,
    });

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

  private selectCodingTools(names: string[]): ToolDefinition[] {
    const byName = new Map(this.codingTools.map((tool) => [tool.name, tool]));
    const selected: ToolDefinition[] = [];
    for (const name of names) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Unknown or unavailable workflow subagent tool: ${name}`);
      selected.push(tool);
    }
    return selected;
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
