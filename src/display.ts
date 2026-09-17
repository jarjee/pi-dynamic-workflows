import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uniqueStrings } from "./validators.js";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentSnapshotStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  model?: string;
  status: WorkflowAgentSnapshotStatus;
  resultPreview?: string;
  error?: string;
}

export type WorkflowPhaseStatus = "pending" | "running" | "done" | "skipped" | "exhausted";

export interface WorkflowPhaseSnapshot {
  title: string;
  status: WorkflowPhaseStatus;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: WorkflowPhaseSnapshot[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  maxLogs?: number;
  maxLines?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  const titles = uniqueStrings((meta.phases ?? []).map((metaPhase) => metaPhase.title));
  return {
    name: meta.name,
    description: meta.description,
    phases: titles.map((title) => ({ title, status: "pending" as const })),
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    if (showStatus) ctx.ui.setStatus(key, statusLine(snapshot, completed));
    ctx.ui.setWidget(key, renderWorkflowLines(snapshot, options), { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed, options) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

interface PhaseRenderEntry {
  title: string;
  status: WorkflowPhaseStatus;
  agents: WorkflowAgentSnapshot[];
}

function isTerminalPhaseStatus(status: WorkflowPhaseStatus): boolean {
  return status === "done" || status === "skipped" || status === "exhausted";
}

function isSettledAgentStatus(status: WorkflowAgentSnapshotStatus): boolean {
  return status === "done" || status === "error" || status === "skipped";
}

/**
 * Resolve the ordered phase list to render: declared snapshot phases first (their recorded
 * status wins), then the current phase, then runtime-created phases inferred from agent
 * `phase` labels that were never declared.
 */
function resolvePhaseEntries(snapshot: WorkflowSnapshot): PhaseRenderEntry[] {
  const agentsByPhase = new Map<string, WorkflowAgentSnapshot[]>();
  for (const agent of snapshot.agents) {
    if (!agent.phase) continue;
    const existing = agentsByPhase.get(agent.phase);
    if (existing) existing.push(agent);
    else agentsByPhase.set(agent.phase, [agent]);
  }

  const entries: PhaseRenderEntry[] = snapshot.phases.map((declared) => ({
    title: declared.title,
    status: declared.status === "pending" && snapshot.currentPhase === declared.title ? "running" : declared.status,
    agents: agentsByPhase.get(declared.title) ?? [],
  }));
  const knownTitles = new Set(entries.map((entry) => entry.title));

  const upsert = (title: string, status: WorkflowPhaseStatus) => {
    if (knownTitles.has(title)) return;
    knownTitles.add(title);
    entries.push({ title, status, agents: agentsByPhase.get(title) ?? [] });
  };

  if (snapshot.currentPhase) upsert(snapshot.currentPhase, "running");
  const agentPhaseNames = uniqueStrings(
    snapshot.agents.map((agent) => agent.phase).filter((phase): phase is string => Boolean(phase)),
  );
  for (const title of agentPhaseNames) {
    const agents = agentsByPhase.get(title) ?? [];
    const settled = agents.length > 0 && agents.every((agent) => isSettledAgentStatus(agent.status));
    upsert(title, settled ? "done" : agents.length > 0 ? "running" : "pending");
  }
  return entries;
}

function terminalPhaseLine(entry: PhaseRenderEntry): string {
  const icon = phaseStatusIcon(entry.status);
  if (entry.status === "done") {
    const done = entry.agents.filter((agent) => agent.status === "done").length;
    return `  ${icon} ${entry.title} ${done}/${entry.agents.length}`;
  }
  const note = entry.status === "skipped" ? "skipped" : "exhausted";
  return `  ${icon} ${entry.title} (${note})`;
}

function runningPhaseLine(entry: PhaseRenderEntry): string {
  const done = entry.agents.filter((agent) => agent.status === "done").length;
  const running = entry.agents.filter((agent) => agent.status === "running").length;
  const errors = entry.agents.filter((agent) => agent.status === "error").length;
  const skipped = entry.agents.filter((agent) => agent.status === "skipped").length;
  const counts = [
    running ? `${running} running` : "",
    errors ? `${errors} errors` : "",
    skipped ? `${skipped} skipped` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const suffix = counts ? ` · ${counts}` : "";
  return `  ${phaseStatusIcon("running")} ${entry.title} ${done}/${entry.agents.length}${suffix}`;
}

function agentLine(agent: WorkflowAgentSnapshot, showResultPreviews: boolean): string {
  const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
  return `    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`;
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const maxLines = options.maxLines ?? 20;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";

  const entries = resolvePhaseEntries(snapshot);
  const terminalEntries = entries.filter((entry) => isTerminalPhaseStatus(entry.status));
  const runningEntries = entries.filter((entry) => entry.status === "running");
  const pendingEntries = entries.filter((entry) => entry.status === "pending");
  const unphasedAgents = snapshot.agents.filter((agent) => !agent.phase);
  const unphasedVisible = unphasedAgents.slice(-maxAgents);

  // Line-budget shedding: pending phases beyond the first 2, then completed phases beyond
  // the most recent 2, then running-phase agent rows down to 2, then logs. The header and
  // the running phase line itself are never shed.
  let terminalKeep = terminalEntries.length;
  let pendingKeep = pendingEntries.length;
  let agentCap = maxAgents;
  let logKeep = Math.min(snapshot.logs.length, maxLogs);

  const countLines = () => {
    let count = 1; // header
    count += terminalKeep + (terminalEntries.length > terminalKeep ? 1 : 0);
    for (const entry of runningEntries) {
      count += 1 + Math.min(entry.agents.length, agentCap) + (entry.agents.length > agentCap ? 1 : 0);
    }
    count += pendingKeep + (pendingEntries.length > pendingKeep ? 1 : 0);
    if (unphasedAgents.length > 0) count += 1 + unphasedVisible.length;
    if (logKeep > 0 && count > 1) count += 1 + logKeep;
    return count;
  };
  const fits = () => countLines() <= maxLines;

  while (!fits() && pendingKeep > Math.min(2, pendingEntries.length)) pendingKeep--;
  while (!fits() && terminalKeep > Math.min(2, terminalEntries.length)) terminalKeep--;
  while (!fits() && agentCap > 2) agentCap--;
  while (!fits() && logKeep > 0) logKeep--;

  const lines = [`◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})`];
  const runningLineIndexes: number[] = [];
  const keptTerminalTitles = new Set(
    (terminalKeep > 0 ? terminalEntries.slice(-terminalKeep) : []).map((entry) => entry.title),
  );
  const keptPendingTitles = new Set(pendingEntries.slice(0, pendingKeep).map((entry) => entry.title));
  let collapsedTerminal = false;
  let collapsedPending = false;

  for (const entry of entries) {
    if (isTerminalPhaseStatus(entry.status)) {
      if (keptTerminalTitles.has(entry.title)) {
        lines.push(terminalPhaseLine(entry));
      } else if (!collapsedTerminal) {
        lines.push(`  … +${terminalEntries.length - terminalKeep} earlier phases`);
        collapsedTerminal = true;
      }
    } else if (entry.status === "running") {
      runningLineIndexes.push(lines.length);
      lines.push(runningPhaseLine(entry));
      const visibleAgents = entry.agents.slice(-agentCap);
      for (const agent of visibleAgents) lines.push(agentLine(agent, showResultPreviews));
      if (entry.agents.length > visibleAgents.length)
        lines.push(`    … ${entry.agents.length - visibleAgents.length} earlier agents`);
    } else if (keptPendingTitles.has(entry.title)) {
      lines.push(`  ${phaseStatusIcon("pending")} ${entry.title}`);
    } else if (!collapsedPending) {
      lines.push(`  … +${pendingEntries.length - pendingKeep} more phases`);
      collapsedPending = true;
    }
  }

  if (unphasedAgents.length) {
    lines.push("  Unphased");
    for (const agent of unphasedVisible) lines.push(agentLine(agent, showResultPreviews));
  }

  const visibleLogs = snapshot.logs.slice(-logKeep);
  if (visibleLogs.length) {
    if (lines.length > 1) lines.push("");
    for (const log of visibleLogs) lines.push(`  log: ${log}`);
  }

  if (lines.length > maxLines) {
    // Pathological inputs (e.g. huge unphased agent counts after all shedding floors are
    // reached): drop lines from the end, never the header or a running phase line.
    const protectedIndexes = new Set<number>([0, ...runningLineIndexes]);
    for (let i = lines.length - 1; i >= 1 && lines.length > maxLines; i--) {
      if (protectedIndexes.has(i)) continue;
      lines.splice(i, 1);
    }
    if (lines.length > maxLines) lines.length = maxLines;
  }
  return lines;
}

export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  completed = false,
  options: WorkflowDisplayOptions = {},
): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot, options)].join("\n");
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

export function statusIcon(status: WorkflowAgentSnapshotStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

export function phaseStatusIcon(status: WorkflowPhaseStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "running":
      return "▶";
    case "done":
      return "✓";
    case "skipped":
      return "-";
    case "exhausted":
      return "⚠";
  }
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
