import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActiveWorkflow } from "./active-workflow.js";
import {
  phaseStatusIcon,
  statusIcon,
  type WorkflowAgentSnapshot,
  type WorkflowPhaseStatus,
  type WorkflowSnapshot,
} from "./display.js";
import { uniqueStrings } from "./validators.js";

interface InspectorRow {
  type: "phase" | "agent" | "agent-detail" | "log" | "result";
  key: string;
  phase?: string;
  agent?: WorkflowAgentSnapshot;
  detail?: { label: string; value: string };
}

export function createWorkflowInspector(
  workflow: ActiveWorkflow,
  tui: Pick<TUI, "requestRender"> & { terminal?: Pick<TUI["terminal"], "rows"> },
  keybindings: KeybindingsManager,
  done: () => void,
  getToolsExpanded: () => boolean,
): Component & { dispose(): void } {
  return new WorkflowInspector(workflow, tui, keybindings, done, getToolsExpanded);
}

class WorkflowInspector implements Component {
  private static readonly MAX_PANEL_ROWS = 34;
  private static readonly MAX_VISIBLE_ROWS = 18;
  private static readonly DESIRED_LOG_PANEL_ROWS = 8;
  private static readonly MIN_LOG_PANEL_ROWS = 3;

  private selected = 0;
  private selectedKey: string | undefined;
  private globalExpanded: boolean;
  private readonly phaseOverrides = new Map<string, boolean>();
  private readonly expandedAgents = new Set<number>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly workflow: ActiveWorkflow,
    private readonly tui: Pick<TUI, "requestRender"> & { terminal?: Pick<TUI["terminal"], "rows"> },
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    getToolsExpanded: () => boolean,
  ) {
    this.globalExpanded = getToolsExpanded();
    this.unsubscribe = workflow.subscribe(() => {
      this.restoreSelection();
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
      this.restoreSelection();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.pageSelection(-1);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.pageSelection(1);
      return;
    }
    if (matchesKey(data, "home")) {
      this.selectFirst();
      return;
    }
    if (matchesKey(data, "end")) {
      this.selectLast();
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
    const height = this.panelHeight();
    if (height < 9 || width < 2) {
      return [truncateToWidth(`Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount})`, width)];
    }

    const innerW = Math.max(0, width - 2);
    const lines: string[] = [];
    const border = (left: string, fill: string, right: string) => left + fill.repeat(innerW) + right;
    const row = (content = "") => `│${truncateToWidth(` ${content}`, innerW, "…", true)}│`;
    const showDescription = Boolean(snapshot.description) && height >= 12;
    const headerRows = showDescription ? 5 : 4;
    const footerRows = 3;
    const { visibleRowCount, logPanelRows } = this.layout(height - headerRows - footerRows);

    const title = truncateToWidth(` Workflow ${this.workflow.isCompleted() ? "completed" : "running"} `, innerW, "");
    const borderWidth = Math.max(0, innerW - visibleWidth(title));
    const left = Math.floor(borderWidth / 2);
    const right = borderWidth - left;
    lines.push(`╭${"─".repeat(left)}${title}${"─".repeat(right)}╮`);
    lines.push(row(`name: ${snapshot.name}`));
    lines.push(row(headerStatus(snapshot)));
    if (showDescription && snapshot.description) lines.push(row(snapshot.description));
    lines.push(border("├", "─", "┤"));

    const rows = this.rows();
    const visibleRows = this.visibleRows(rows, visibleRowCount);
    if (rows.length === 0 && visibleRowCount > 0) {
      lines.push(row("No phases or subagents yet."));
    } else {
      for (const { row: inspectorRow, index } of visibleRows) {
        const selected = index === this.selected;
        lines.push(row(this.renderInspectorRow(inspectorRow, selected)));
      }
    }
    while (lines.length < headerRows + visibleRowCount) lines.push(row());

    if (logPanelRows > 0) {
      const maxLogRows = Math.max(0, logPanelRows - WorkflowInspector.MIN_LOG_PANEL_ROWS);
      const recentLogs = snapshot.logs.slice(-maxLogRows);
      lines.push(border("├", "─", "┤"));
      lines.push(row("Recent logs"));
      for (const log of recentLogs) lines.push(row(`  ${log}`));
      while (lines.length < headerRows + visibleRowCount + logPanelRows) lines.push(row());
    }

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

  private panelHeight(): number {
    const terminalRows = this.tui.terminal?.rows;
    if (!Number.isFinite(terminalRows) || terminalRows === undefined) return WorkflowInspector.MAX_PANEL_ROWS;
    return Math.max(1, Math.min(WorkflowInspector.MAX_PANEL_ROWS, terminalRows));
  }

  private layout(availableRows: number): { visibleRowCount: number; logPanelRows: number } {
    if (availableRows < WorkflowInspector.MIN_LOG_PANEL_ROWS + 1) {
      return { visibleRowCount: Math.max(0, availableRows), logPanelRows: 0 };
    }

    const visibleRowCount = Math.max(
      1,
      Math.min(WorkflowInspector.MAX_VISIBLE_ROWS, availableRows - WorkflowInspector.DESIRED_LOG_PANEL_ROWS),
    );
    return { visibleRowCount, logPanelRows: availableRows - visibleRowCount };
  }

  private visibleRows(rows: InspectorRow[], maxRows: number): Array<{ row: InspectorRow; index: number }> {
    if (maxRows <= 0) return [];
    if (rows.length <= maxRows) {
      return rows.map((row, index) => ({ row, index }));
    }
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), rows.length - maxRows));
    return rows.slice(start, start + maxRows).map((row, offset) => ({ row, index: start + offset }));
  }

  private renderInspectorRow(row: InspectorRow, selected: boolean): string {
    const prefix = selected ? "› " : "  ";
    if (row.type === "phase") {
      const phase = row.phase ?? "";
      const snapshot = this.workflow.getSnapshot();
      const agents = agentsForPhase(snapshot, phase);
      const expanded = this.isPhaseExpanded(phase);
      const stats = agentStats(agents);
      const declared = declaredPhaseStatus(snapshot, phase);
      // Declared snapshot phases carry an explicit status; runtime-created
      // phases (agent phase labels never declared) fall back to agent stats.
      const icon = declared ? phaseStatusIcon(declared) : statsPhaseIcon(stats);
      const counts = agents.length > 0 ? ` ${stats.done}/${agents.length}` : "";
      const details = [
        stats.running ? `${stats.running} running` : "",
        stats.errors ? `${stats.errors} errors` : "",
        stats.skipped ? `${stats.skipped} skipped` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const suffix = details ? ` · ${details}` : "";
      const pendingHint = declared === "pending" && agents.length === 0 ? " (pending)" : "";
      return `${prefix}${expanded ? "▾" : "▸"} ${icon} ${phase}${counts}${pendingHint}${suffix}`;
    }

    if (row.type === "agent" && row.agent) {
      const agent = row.agent;
      const expanded = this.expandedAgents.has(agent.id);
      const detail =
        !expanded && agent.resultPreview
          ? ` — ${agent.resultPreview}`
          : !expanded && agent.error
            ? ` — ${agent.error}`
            : "";
      return `${prefix}  ${expanded ? "▾" : "▸"} #${agent.id} ${statusIcon(agent.status)} ${agent.label}${detail}`;
    }

    if (row.type === "agent-detail" && row.detail) {
      return `${prefix}    ${row.detail.label}: ${row.detail.value}`;
    }

    return `${prefix}${row.key}`;
  }

  private rows(): InspectorRow[] {
    const snapshot = this.workflow.getSnapshot();
    const rows: InspectorRow[] = [];
    const declaredTitles = new Set(snapshot.phases.map((phase) => phase.title));
    for (const phase of phaseNames(snapshot)) {
      const agents = agentsForPhase(snapshot, phase);
      // Hide only phases with no evidence: not declared in the snapshot phase
      // outline, not current, and with no agents. Declared phases stay visible
      // as selectable pending rows before they run.
      if (agents.length === 0 && snapshot.currentPhase !== phase && !declaredTitles.has(phase)) continue;
      rows.push({ type: "phase", key: `phase:${phase}`, phase });
      if (this.isPhaseExpanded(phase)) {
        for (const agent of agents) this.pushAgentRows(rows, phase, agent);
      }
    }

    const phased = new Set(phaseNames(snapshot));
    const unphased = snapshot.agents.filter((agent) => !agent.phase || !phased.has(agent.phase));
    if (unphased.length > 0) {
      const phase = "Unphased";
      rows.push({ type: "phase", key: "phase:Unphased", phase });
      if (this.isPhaseExpanded(phase)) {
        for (const agent of unphased) this.pushAgentRows(rows, phase, agent);
      }
    }
    return rows;
  }

  private pushAgentRows(rows: InspectorRow[], phase: string, agent: WorkflowAgentSnapshot): void {
    rows.push({ type: "agent", key: `agent:${agent.id}`, phase, agent });
    if (!this.expandedAgents.has(agent.id)) return;

    rows.push({
      type: "agent-detail",
      key: `agent:${agent.id}:status`,
      phase,
      agent,
      detail: { label: "status", value: agent.status },
    });
    if (agent.model) {
      rows.push({
        type: "agent-detail",
        key: `agent:${agent.id}:model`,
        phase,
        agent,
        detail: { label: "model", value: agent.model },
      });
    }
    if (agent.error) {
      rows.push({
        type: "agent-detail",
        key: `agent:${agent.id}:error`,
        phase,
        agent,
        detail: { label: "error", value: agent.error },
      });
    }
    if (agent.resultPreview) {
      rows.push({
        type: "agent-detail",
        key: `agent:${agent.id}:result`,
        phase,
        agent,
        detail: { label: "result", value: agent.resultPreview },
      });
    }
  }

  private toggle(row: InspectorRow): void {
    if (row.type === "phase" && row.phase) {
      this.setPhaseExpanded(row.phase, !this.isPhaseExpanded(row.phase));
    } else if ((row.type === "agent" || row.type === "agent-detail") && row.agent) {
      if (this.expandedAgents.has(row.agent.id)) this.expandedAgents.delete(row.agent.id);
      else this.expandedAgents.add(row.agent.id);
      this.restoreSelection();
    }
  }

  private setExpanded(row: InspectorRow, expanded: boolean): void {
    if (row.type === "phase" && row.phase) this.setPhaseExpanded(row.phase, expanded);
    else if ((row.type === "agent" || row.type === "agent-detail") && row.agent) {
      if (expanded) this.expandedAgents.add(row.agent.id);
      else this.expandedAgents.delete(row.agent.id);
      this.restoreSelection();
    }
  }

  private isPhaseExpanded(phase: string): boolean {
    return this.phaseOverrides.get(phase) ?? this.globalExpanded;
  }

  private setPhaseExpanded(phase: string, expanded: boolean): void {
    if (expanded === this.globalExpanded) this.phaseOverrides.delete(phase);
    else this.phaseOverrides.set(phase, expanded);
    this.restoreSelection();
  }

  private moveSelection(delta: -1 | 1): void {
    const rows = this.rows();
    let index = this.selected;
    while (true) {
      index += delta;
      if (index < 0 || index >= rows.length) return;
      if (isSelectable(rows[index])) {
        this.selectIndex(index, rows);
        return;
      }
    }
  }

  private pageSelection(delta: -1 | 1): void {
    const rows = this.rows();
    const selectable = rows.map((row, index) => ({ row, index })).filter(({ row }) => isSelectable(row));
    if (selectable.length === 0) return;
    const current = Math.max(
      0,
      selectable.findIndex(({ index }) => index === this.selected),
    );
    const next = Math.max(0, Math.min(selectable.length - 1, current + delta * this.pageSize()));
    this.selectIndex(selectable[next].index, rows);
  }

  private pageSize(): number {
    const snapshot = this.workflow.getSnapshot();
    const headerRows = snapshot.description && this.panelHeight() >= 12 ? 5 : 4;
    const { visibleRowCount } = this.layout(this.panelHeight() - headerRows - 3);
    return Math.max(1, visibleRowCount);
  }

  private selectFirst(): void {
    const rows = this.rows();
    const index = rows.findIndex(isSelectable);
    if (index >= 0) this.selectIndex(index, rows);
  }

  private selectLast(): void {
    const rows = this.rows();
    for (let index = rows.length - 1; index >= 0; index--) {
      if (isSelectable(rows[index])) {
        this.selectIndex(index, rows);
        return;
      }
    }
  }

  private restoreSelection(): void {
    const rows = this.rows();
    if (rows.length === 0) {
      this.selected = 0;
      this.selectedKey = undefined;
      return;
    }

    if (this.selectedKey) {
      const byKey = rows.findIndex((row) => row.key === this.selectedKey && isSelectable(row));
      if (byKey >= 0) {
        this.selectIndex(byKey, rows);
        return;
      }
    }

    const clamped = Math.max(0, Math.min(this.selected, rows.length - 1));
    for (let index = clamped; index >= 0; index--) {
      if (isSelectable(rows[index])) {
        this.selectIndex(index, rows);
        return;
      }
    }
    for (let index = clamped + 1; index < rows.length; index++) {
      if (isSelectable(rows[index])) {
        this.selectIndex(index, rows);
        return;
      }
    }
    this.selected = 0;
    this.selectedKey = undefined;
  }

  private selectIndex(index: number, rows = this.rows()): void {
    this.selected = index;
    this.selectedKey = rows[index]?.key;
  }
}

function isSelectable(row: InspectorRow | undefined): row is InspectorRow {
  return row?.type === "phase" || row?.type === "agent";
}

function headerStatus(snapshot: WorkflowSnapshot): string {
  const state =
    snapshot.errorCount > 0
      ? `${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `${snapshot.runningCount} running`
        : "idle";
  const duration = snapshot.durationMs === undefined ? "" : ` · ${(snapshot.durationMs / 1000).toFixed(1)}s`;
  return `status: ${snapshot.doneCount}/${snapshot.agentCount} done · ${state}${duration}`;
}

function phaseNames(snapshot: WorkflowSnapshot): string[] {
  return uniqueStrings([
    ...snapshot.phases.map((phase) => phase.title),
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...snapshot.agents.map((agent) => agent.phase).filter((phase): phase is string => Boolean(phase)),
  ]);
}

function declaredPhaseStatus(snapshot: WorkflowSnapshot, phase: string): WorkflowPhaseStatus | undefined {
  return snapshot.phases.find((entry) => entry.title === phase)?.status;
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

function statsPhaseIcon(stats: ReturnType<typeof agentStats>): string {
  if (stats.errors > 0) return "✗";
  if (stats.running > 0) return "▶";
  if (stats.skipped > 0) return "-";
  return "✓";
}
