import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActiveWorkflow } from "./active-workflow.js";
import type { WorkflowAgentSnapshot, WorkflowAgentStatus, WorkflowSnapshot } from "./display.js";

interface InspectorRow {
  type: "phase" | "agent" | "log" | "result";
  key: string;
  phase?: string;
  agent?: WorkflowAgentSnapshot;
}

export function createWorkflowInspector(
  workflow: ActiveWorkflow,
  tui: Pick<TUI, "requestRender">,
  keybindings: KeybindingsManager,
  done: () => void,
  getToolsExpanded: () => boolean,
): Component & { dispose(): void } {
  return new WorkflowInspector(workflow, tui, keybindings, done, getToolsExpanded);
}

class WorkflowInspector implements Component {
  private static readonly MAX_VISIBLE_ROWS = 12;
  private static readonly MAX_LOG_ROWS = 5;

  private selected = 0;
  private globalExpanded: boolean;
  private readonly phaseOverrides = new Map<string, boolean>();
  private readonly expandedAgents = new Set<number>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly workflow: ActiveWorkflow,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    getToolsExpanded: () => boolean,
  ) {
    this.globalExpanded = getToolsExpanded();
    this.unsubscribe = workflow.subscribe(() => {
      this.clampSelection();
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }

    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.globalExpanded = !this.globalExpanded;
      this.phaseOverrides.clear();
      this.clampSelection();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = Math.min(this.rows().length - 1, this.selected + 1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.selected = Math.max(0, this.selected - WorkflowInspector.MAX_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.selected = Math.min(this.rows().length - 1, this.selected + WorkflowInspector.MAX_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, "home")) {
      this.selected = 0;
      return;
    }
    if (matchesKey(data, "end")) {
      this.selected = Math.max(0, this.rows().length - 1);
      return;
    }

    const row = this.rows()[this.selected];
    if (!row) return;

    if (matchesKey(data, "space") || matchesKey(data, "return")) {
      this.toggle(row);
      return;
    }
    if (matchesKey(data, "right")) {
      this.setExpanded(row, true);
      return;
    }
    if (matchesKey(data, "left")) {
      this.setExpanded(row, false);
      return;
    }
  }

  render(width: number): string[] {
    const snapshot = this.workflow.getSnapshot();
    const innerW = Math.max(20, width - 2);
    const lines: string[] = [];
    const border = (left: string, fill: string, right: string) => left + fill.repeat(innerW) + right;
    const row = (content = "") => `│${truncateToWidth(` ${content}`, innerW, "…", true).padEnd(innerW, " ")}│`;

    const title = ` Workflow ${this.workflow.isCompleted() ? "completed" : "running"} `;
    const borderWidth = Math.max(0, innerW - visibleWidth(title));
    const left = Math.floor(borderWidth / 2);
    const right = borderWidth - left;
    lines.push(`╭${"─".repeat(left)}${title}${"─".repeat(right)}╮`);
    lines.push(row(headerText(snapshot)));
    lines.push(row(snapshot.description ?? ""));
    lines.push(border("├", "─", "┤"));

    const rows = this.rows();
    const visibleRows = this.visibleRows(rows);
    if (rows.length === 0) {
      lines.push(row("No phases or subagents yet."));
    } else {
      for (const { row: inspectorRow, index } of visibleRows) {
        const selected = index === this.selected;
        lines.push(row(this.renderInspectorRow(inspectorRow, selected)));
      }
    }
    while (lines.length < 5 + WorkflowInspector.MAX_VISIBLE_ROWS) lines.push(row());
    if (rows.length > WorkflowInspector.MAX_VISIBLE_ROWS) {
      const first = (visibleRows[0]?.index ?? 0) + 1;
      const last = (visibleRows.at(-1)?.index ?? 0) + 1;
      lines.push(row(`Showing ${first}-${last} of ${rows.length}`));
    } else {
      lines.push(row());
    }

    lines.push(border("├", "─", "┤"));
    lines.push(row("Recent logs"));
    for (const log of snapshot.logs.slice(-WorkflowInspector.MAX_LOG_ROWS)) lines.push(row(`  ${log}`));
    while (lines.length < 8 + WorkflowInspector.MAX_VISIBLE_ROWS + WorkflowInspector.MAX_LOG_ROWS) lines.push(row());

    lines.push(border("├", "─", "┤"));
    lines.push(row("↑↓/pg select • space/enter toggle • ←/→ collapse/expand • ctrl+o global • esc close"));
    lines.push(border("╰", "─", "╯"));
    return lines;
  }

  invalidate(): void {
    // Stateless render; live data is read from ActiveWorkflow.
  }

  dispose(): void {
    this.unsubscribe();
  }

  private visibleRows(rows: InspectorRow[]): Array<{ row: InspectorRow; index: number }> {
    if (rows.length <= WorkflowInspector.MAX_VISIBLE_ROWS) {
      return rows.map((row, index) => ({ row, index }));
    }
    const start = Math.max(
      0,
      Math.min(
        this.selected - Math.floor(WorkflowInspector.MAX_VISIBLE_ROWS / 2),
        rows.length - WorkflowInspector.MAX_VISIBLE_ROWS,
      ),
    );
    return rows
      .slice(start, start + WorkflowInspector.MAX_VISIBLE_ROWS)
      .map((row, offset) => ({ row, index: start + offset }));
  }

  private renderInspectorRow(row: InspectorRow, selected: boolean): string {
    const prefix = selected ? "› " : "  ";
    if (row.type === "phase") {
      const phase = row.phase ?? "";
      const agents = agentsForPhase(this.workflow.getSnapshot(), phase);
      const expanded = this.isPhaseExpanded(phase);
      const stats = agentStats(agents);
      return `${prefix}${expanded ? "▾" : "▸"} ${phaseStatusIcon(stats)} ${phase} ${stats.done}/${agents.length}${stats.running ? ` · ${stats.running} running` : ""}${stats.errors ? ` · ${stats.errors} errors` : ""}${stats.skipped ? ` · ${stats.skipped} skipped` : ""}`;
    }

    if (row.type === "agent" && row.agent) {
      const agent = row.agent;
      const expanded = this.expandedAgents.has(agent.id);
      const detail = expanded
        ? ""
        : agent.resultPreview
          ? ` — ${agent.resultPreview}`
          : agent.error
            ? ` — ${agent.error}`
            : "";
      let text = `${prefix}  ${expanded ? "▾" : "▸"} #${agent.id} ${statusIcon(agent.status)} ${agent.label}${detail}`;
      if (expanded) {
        const bits = [`status: ${agent.status}`];
        if (agent.error) bits.push(`error: ${agent.error}`);
        if (agent.resultPreview) bits.push(`result: ${agent.resultPreview}`);
        text += ` — ${bits.join(" · ")}`;
      }
      return text;
    }

    return `${prefix}${row.key}`;
  }

  private rows(): InspectorRow[] {
    const snapshot = this.workflow.getSnapshot();
    const rows: InspectorRow[] = [];
    for (const phase of phaseNames(snapshot)) {
      const agents = agentsForPhase(snapshot, phase);
      if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
      rows.push({ type: "phase", key: `phase:${phase}`, phase });
      if (this.isPhaseExpanded(phase)) {
        for (const agent of agents) rows.push({ type: "agent", key: `agent:${agent.id}`, phase, agent });
      }
    }

    const phased = new Set(phaseNames(snapshot));
    const unphased = snapshot.agents.filter((agent) => !agent.phase || !phased.has(agent.phase));
    if (unphased.length > 0) {
      const phase = "Unphased";
      rows.push({ type: "phase", key: "phase:Unphased", phase });
      if (this.isPhaseExpanded(phase)) {
        for (const agent of unphased) rows.push({ type: "agent", key: `agent:${agent.id}`, phase, agent });
      }
    }
    return rows;
  }

  private toggle(row: InspectorRow): void {
    if (row.type === "phase" && row.phase) {
      this.setPhaseExpanded(row.phase, !this.isPhaseExpanded(row.phase));
    } else if (row.type === "agent" && row.agent) {
      if (this.expandedAgents.has(row.agent.id)) this.expandedAgents.delete(row.agent.id);
      else this.expandedAgents.add(row.agent.id);
    }
  }

  private setExpanded(row: InspectorRow, expanded: boolean): void {
    if (row.type === "phase" && row.phase) this.setPhaseExpanded(row.phase, expanded);
    else if (row.type === "agent" && row.agent) {
      if (expanded) this.expandedAgents.add(row.agent.id);
      else this.expandedAgents.delete(row.agent.id);
    }
  }

  private isPhaseExpanded(phase: string): boolean {
    return this.phaseOverrides.get(phase) ?? this.globalExpanded;
  }

  private setPhaseExpanded(phase: string, expanded: boolean): void {
    if (expanded === this.globalExpanded) this.phaseOverrides.delete(phase);
    else this.phaseOverrides.set(phase, expanded);
    this.clampSelection();
  }

  private clampSelection(): void {
    this.selected = Math.min(this.selected, Math.max(0, this.rows().length - 1));
  }
}

function headerText(snapshot: WorkflowSnapshot): string {
  const state =
    snapshot.errorCount > 0
      ? `${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `${snapshot.runningCount} running`
        : "idle";
  const duration = snapshot.durationMs === undefined ? "" : ` · ${(snapshot.durationMs / 1000).toFixed(1)}s`;
  return `${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done · ${state}${duration}`;
}

function phaseNames(snapshot: WorkflowSnapshot): string[] {
  return unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...snapshot.agents.map((agent) => agent.phase).filter((phase): phase is string => Boolean(phase)),
  ]);
}

function agentsForPhase(snapshot: WorkflowSnapshot, phase: string): WorkflowAgentSnapshot[] {
  if (phase === "Unphased") return snapshot.agents.filter((agent) => !agent.phase);
  return snapshot.agents.filter((agent) => agent.phase === phase);
}

function agentStats(agents: WorkflowAgentSnapshot[]) {
  return {
    done: agents.filter((agent) => agent.status === "done").length,
    running: agents.filter((agent) => agent.status === "running").length,
    errors: agents.filter((agent) => agent.status === "error").length,
    skipped: agents.filter((agent) => agent.status === "skipped").length,
  };
}

function phaseStatusIcon(stats: ReturnType<typeof agentStats>): string {
  if (stats.errors > 0) return "✗";
  if (stats.running > 0) return "▶";
  if (stats.skipped > 0) return "-";
  return "✓";
}

function statusIcon(status: WorkflowAgentStatus): string {
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
