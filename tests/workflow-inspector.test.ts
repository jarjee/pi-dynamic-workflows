import assert from "node:assert/strict";
import test from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import type { WorkflowSnapshot } from "../src/index.js";
import { createActiveWorkflowStore, createWorkflowInspector, recomputeWorkflowSnapshot } from "../src/index.js";

// ---------------------------------------------------------------------------
// Arrow key constants — explicitly constructed to avoid any source-level
// escape-sequence ambiguity.
// ---------------------------------------------------------------------------
const ESC = "\u001b";
const KEY_RIGHT = `${ESC}[C`;
const KEY_LEFT = `${ESC}[D`;
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;

// Sanity: these must match the tui's matchesKey expectations.
assert.ok(matchesKey(KEY_RIGHT, "right"), "KEY_RIGHT must match");
assert.ok(matchesKey(KEY_LEFT, "left"), "KEY_LEFT must match");
assert.ok(matchesKey(KEY_UP, "up"), "KEY_UP must match");
assert.ok(matchesKey(KEY_DOWN, "down"), "KEY_DOWN must match");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return recomputeWorkflowSnapshot({
    name: "demo_workflow",
    description: "Demo workflow",
    phases: ["Scan"],
    logs: [],
    agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "running" }],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    ...overrides,
  });
}

function keybindings(overrides: Partial<Record<string, string>> = {}) {
  const map = { "ctrl+o": "app.tools.expand", ...overrides };
  return {
    matches(data: string, keybinding: string) {
      return map[data] === keybinding;
    },
  };
}

function render(inspector: ReturnType<typeof createWorkflowInspector>): string[] {
  return inspector.render(96);
}

function bodyLines(inspector: ReturnType<typeof createWorkflowInspector>): string[] {
  return render(inspector).slice(4);
}

function makeInspector(opts?: { snapshotOverrides?: Partial<WorkflowSnapshot>; getToolsExpanded?: () => boolean }) {
  const store = createActiveWorkflowStore();
  const active = store.create(snapshot(opts?.snapshotOverrides ?? {}));
  return {
    inspector: createWorkflowInspector(
      active,
      { requestRender() {} },
      keybindings() as never,
      () => {},
      opts?.getToolsExpanded ?? (() => true),
    ),
    active,
    store,
  };
}

function findLine(lines: string[], substr: string): string | undefined {
  return lines.find((l) => l.includes(substr));
}

function hasCursor(inspector: ReturnType<typeof createWorkflowInspector>): boolean {
  return bodyLines(inspector).some((l) => l.includes("›"));
}

// ---------------------------------------------------------------------------
// Phase expansion / collapse
// ---------------------------------------------------------------------------

test("phase renders expanded when globalExpanded is true", () => {
  const { inspector } = makeInspector({ getToolsExpanded: () => true });
  const lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ▶ Scan"), "phase should be expanded with ▾");
  assert.ok(findLine(lines, "#1 ● scan repo"), "agent row should be visible");
});

test("phase renders collapsed when globalExpanded is false", () => {
  const { inspector } = makeInspector({ getToolsExpanded: () => false });
  const lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▸ ▶ Scan"), "phase should be collapsed with ▸");
  assert.ok(!findLine(lines, "#1 ● scan repo"), "agent row should be hidden");
});

test("space toggles a single phase expansion", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => false,
    snapshotOverrides: {
      agents: [
        { id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "running" },
        { id: 2, label: "review diff", phase: "Review", prompt: "Review", status: "running" },
      ],
      phases: ["Scan", "Review"],
    },
  });

  let lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▸ ▶ Scan"), "Scan collapsed");
  assert.ok(findLine(lines, "▸ ▶ Review"), "Review collapsed");
  assert.ok(!findLine(lines, "#1"), "agent 1 hidden");
  assert.ok(!findLine(lines, "#2"), "agent 2 hidden");

  inspector.handleInput(" ");
  lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ▶ Scan"), "Scan now expanded");
  assert.ok(findLine(lines, "#1 ● scan repo"), "agent 1 now visible");
  assert.ok(findLine(lines, "▸ ▶ Review"), "Review still collapsed");
  assert.ok(!findLine(lines, "#2"), "agent 2 still hidden");

  inspector.handleInput(" ");
  lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▸ ▶ Scan"), "Scan collapsed again");
  assert.ok(!findLine(lines, "#1 ● scan repo"), "agent 1 hidden again");
});

test("right arrow expands a collapsed phase", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => false,
    snapshotOverrides: {
      agents: [
        { id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "done" },
        { id: 2, label: "review diff", phase: "Review", prompt: "Review", status: "running" },
      ],
      phases: ["Scan", "Review"],
    },
  });

  // Expand Scan with right arrow
  inspector.handleInput(KEY_RIGHT);
  let lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ✓ Scan"), "Scan expanded via right arrow");

  // Navigate down past the now-visible agent row to reach Review phase
  inspector.handleInput(KEY_DOWN); // to agent #1
  inspector.handleInput(KEY_DOWN); // to Review phase
  inspector.handleInput(KEY_RIGHT);
  lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ▶ Review"), "Review expanded via right arrow");
  assert.ok(findLine(lines, "#2 ● review diff"), "agent 2 visible");
});

test("left arrow collapses an expanded phase", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      agents: [
        { id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "running" },
        { id: 2, label: "review diff", phase: "Review", prompt: "Review", status: "done" },
      ],
      phases: ["Scan", "Review"],
    },
  });

  // Collapse Scan via left arrow
  inspector.handleInput(KEY_LEFT);
  const lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▸ ▶ Scan"), "Scan collapsed via left arrow");
  assert.ok(!findLine(lines, "#1"), "agent 1 hidden");
  assert.ok(findLine(lines, "▾ ✓ Review"), "Review stays expanded (no override)");
  assert.ok(findLine(lines, "#2"), "agent 2 still visible");
});

test("return key also toggles phase expansion", () => {
  const { inspector } = makeInspector({ getToolsExpanded: () => false });

  inspector.handleInput("\r");
  let lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ▶ Scan"), "Scan expands on return");
  assert.ok(findLine(lines, "#1 ● scan repo"), "agent visible");

  inspector.handleInput("\r");
  lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▸ ▶ Scan"), "Scan collapses on return");
});

test("expanded phase shows done agents with checkmark", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      agents: [
        {
          id: 1,
          label: "scan repo",
          phase: "Scan",
          prompt: "Scan",
          status: "done",
          resultPreview: "found 42 files",
        },
      ],
    },
  });

  const lines = bodyLines(inspector);
  assert.ok(findLine(lines, "#1 ✓ scan repo"), "done agent shows ✓ icon");
});

// ---------------------------------------------------------------------------
// Agent inline detail expansion / collapse
// ---------------------------------------------------------------------------

test("agent detail toggles with space when selected", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      agents: [
        {
          id: 1,
          label: "scan repo",
          phase: "Scan",
          prompt: "Scan",
          status: "done",
          resultPreview: "42 results",
        },
      ],
    },
  });

  // Navigate to agent row
  inspector.handleInput(KEY_DOWN);

  // Initially collapsed with preview
  let lines = bodyLines(inspector);
  const agentLine = findLine(lines, "#1");
  assert.ok(agentLine);
  assert.ok(agentLine?.includes("▸"), "agent collapsed by default shows ▸");
  assert.ok(agentLine?.includes("— 42 results"), "collapsed agent shows result preview");

  // Toggle expansion
  inspector.handleInput(" ");
  lines = bodyLines(inspector);
  const expandedLine = findLine(lines, "#1");
  assert.ok(expandedLine);
  assert.ok(expandedLine?.includes("▾"), "agent shows ▾ when expanded");
  assert.ok(expandedLine?.includes("status: done"), "expanded agent shows status detail");

  // Toggle back
  inspector.handleInput(" ");
  lines = bodyLines(inspector);
  const collapsedLine = findLine(lines, "#1");
  assert.ok(collapsedLine?.includes("▸"), "agent collapsed again");
  assert.ok(collapsedLine?.includes("— 42 results"), "preview visible again");
  assert.ok(!collapsedLine?.includes("status:"), "detail hidden when collapsed");
});

test("agent expands with right and collapses with left", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "error", error: "timeout" }],
    },
  });

  inspector.handleInput(KEY_DOWN);

  // Expand with right
  inspector.handleInput(KEY_RIGHT);
  let lines = bodyLines(inspector);
  const expandedLine = findLine(lines, "#1");
  assert.ok(expandedLine?.includes("▾"), "agent expanded");
  assert.ok(expandedLine?.includes("error: timeout"), "expanded agent shows error detail");

  // Collapse with left
  inspector.handleInput(KEY_LEFT);
  lines = bodyLines(inspector);
  const collapsedLine = findLine(lines, "#1");
  assert.ok(collapsedLine?.includes("▸"), "agent collapsed");
  assert.ok(collapsedLine?.includes("— timeout"), "collapsed shows error preview");
});

test("agent expansion persists when phase is collapsed then re-expanded", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      agents: [
        {
          id: 1,
          label: "scan repo",
          phase: "Scan",
          prompt: "Scan",
          status: "done",
          resultPreview: "ok",
        },
      ],
    },
  });

  // Navigate to agent and expand it
  inspector.handleInput(KEY_DOWN);
  inspector.handleInput(KEY_RIGHT);
  assert.ok(findLine(bodyLines(inspector), "▾ #1"), "agent expanded");

  // Move back up to phase and collapse it
  inspector.handleInput(KEY_UP);
  inspector.handleInput(KEY_LEFT);
  let lines = bodyLines(inspector);
  assert.ok(!findLine(lines, "#1"), "agent row hidden");

  // Re-expand the phase
  inspector.handleInput(KEY_RIGHT);
  lines = bodyLines(inspector);
  assert.ok(findLine(lines, "#1"), "agent row visible again");
  assert.ok(findLine(lines, "▾ #1"), "agent still expanded after phase re-expand");
  assert.ok(findLine(lines, "status: done"), "agent detail preserved");
});

// ---------------------------------------------------------------------------
// Global toggle (ctrl+o / app.tools.expand)
// ---------------------------------------------------------------------------

test("ctrl+o toggles global expanded and clears phase overrides", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      agents: [
        { id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "running" },
        { id: 2, label: "review api", phase: "Review", prompt: "Review", status: "running" },
        { id: 3, label: "review ui", phase: "Review", prompt: "Review", status: "queued" },
      ],
      phases: ["Scan", "Review"],
    },
  });

  // Collapse Scan (creates override: Scan=false when global=true)
  inspector.handleInput(KEY_LEFT);
  let lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▸ ▶ Scan"), "Scan collapsed via override");

  // ctrl+o → global=false, overrides cleared
  inspector.handleInput("ctrl+o");
  lines = bodyLines(inspector);

  assert.ok(findLine(lines, "▸ ▶ Scan"), "Scan collapsed (global=false)");
  assert.ok(!findLine(lines, "#1"), "agent 1 hidden");
  assert.ok(findLine(lines, "▸ ▶ Review"), "Review collapsed (override cleared, global=false)");
  assert.ok(!findLine(lines, "#2"), "agent 2 hidden");

  // ctrl+o again → global=true (both should expand)
  inspector.handleInput("ctrl+o");
  lines = bodyLines(inspector);

  assert.ok(findLine(lines, "▾ ▶ Scan"), "Scan expanded (global=true)");
  assert.ok(findLine(lines, "#1 ● scan repo"), "agent 1 visible");
  assert.ok(findLine(lines, "▾ ▶ Review"), "Review expanded (global=true)");
  assert.ok(findLine(lines, "#2 ● review api"), "agent 2 visible");
});

test("local phase override cleared when toggled back to match global", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => false,
    snapshotOverrides: {
      agents: [
        { id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "running" },
        { id: 2, label: "review api", phase: "Review", prompt: "Review", status: "running" },
      ],
      phases: ["Scan", "Review"],
    },
  });

  // Expand Scan (creates override: Scan=true, global=false)
  inspector.handleInput(" ");
  let lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ▶ Scan"), "Scan expanded via local override");

  // Collapse Scan via space (should clear the override)
  inspector.handleInput(" ");
  lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▸ ▶ Scan"), "Scan collapsed — override cleared");

  // Now ctrl+o → global=true. Both phases should expand.
  inspector.handleInput("ctrl+o");
  lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ▶ Scan"), "Scan expands via global toggle");
  assert.ok(findLine(lines, "▾ ▶ Review"), "Review also expands via global toggle");
});

// ---------------------------------------------------------------------------
// Selection clamping
// ---------------------------------------------------------------------------

test("selection remains valid when ctrl+o collapses and agent rows disappear", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "running" }],
      phases: ["Scan"],
    },
  });

  // Move selection to agent row (index 1)
  inspector.handleInput(KEY_DOWN);

  // Collapse globally — agent row disappears, cursor stays on a valid row
  inspector.handleInput("ctrl+o");

  // Cursor must be visible (on the Scan phase row, index 0)
  assert.ok(hasCursor(inspector), "cursor should be visible after ctrl+o collapse");
});

test("space toggles the phase after ctrl+o collapse from agent row", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "running" }],
      phases: ["Scan"],
    },
  });

  inspector.handleInput(KEY_DOWN); // on agent row
  inspector.handleInput("ctrl+o"); // collapse globally — cursor moves to phase

  // Space should toggle the phase, not be swallowed
  inspector.handleInput(" ");
  const lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ▶ Scan"), "Scan phase should expand on space after ctrl+o");
  assert.ok(findLine(lines, "#1 ● scan repo"), "agent should be visible after expansion");
});

test("selection stays valid after live subscription update adds agents", () => {
  const store = createActiveWorkflowStore();
  const active = store.create(
    snapshot({
      agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "running" }],
    }),
  );
  const inspector = createWorkflowInspector(
    active,
    { requestRender() {} },
    keybindings() as never,
    () => {},
    () => true,
  );

  active.update(
    snapshot({
      currentPhase: "Review",
      phases: ["Scan", "Review"],
      agents: [
        { id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "done", resultPreview: "ok" },
        { id: 2, label: "review api", phase: "Review", prompt: "Review", status: "running" },
      ],
    }),
  );

  // Should not throw; phase row should be togglable
  inspector.handleInput(" ");
  const lines = bodyLines(inspector);
  assert.ok(lines.length > 0, "render succeeds after subscription update");
});

// ---------------------------------------------------------------------------
// Unphased agents
// ---------------------------------------------------------------------------

test("Unphased agents grouped together and respect phase expansion", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => false,
    snapshotOverrides: {
      phases: [],
      agents: [{ id: 1, label: "ad-hoc task", phase: undefined, prompt: "task", status: "running" }],
    },
  });

  let lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▸ ▶ Unphased"), "Unphased phase renders collapsed");
  assert.ok(!findLine(lines, "#1 ● ad-hoc task"), "agent hidden when collapsed");

  inspector.handleInput(" ");
  lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ▶ Unphased"), "Unphased phase expanded");
  assert.ok(findLine(lines, "#1 ● ad-hoc task"), "agent visible when expanded");
});

test("Unphased agents show correct counts", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      phases: [],
      agents: [
        { id: 1, label: "task one", phase: undefined, prompt: "one", status: "done" },
        { id: 2, label: "task two", phase: undefined, prompt: "two", status: "running" },
      ],
    },
  });

  const lines = bodyLines(inspector);
  assert.ok(findLine(lines, "▾ ▶ Unphased 1/2 · 1 running"), "Unphased shows done/running counts");
  assert.ok(findLine(lines, "#1 ✓ task one"), "done agent visible");
  assert.ok(findLine(lines, "#2 ● task two"), "running agent visible");
});

// ---------------------------------------------------------------------------
// Phase status icons
// ---------------------------------------------------------------------------

test("phase status icon shows ✓ when all agents are done", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => true,
    snapshotOverrides: {
      agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "done" }],
    },
  });
  assert.ok(findLine(bodyLines(inspector), "▾ ✓ Scan"), "✓ icon for all-done phase");
});

test("phase status icon shows ▶ when agents are running", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => false,
    snapshotOverrides: {
      agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "running" }],
    },
  });
  assert.ok(findLine(bodyLines(inspector), "▸ ▶ Scan"), "▶ icon for running phase");
});

test("phase status icon shows ✗ when any agent has error", () => {
  const { inspector } = makeInspector({
    getToolsExpanded: () => false,
    snapshotOverrides: {
      agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "error", error: "fail" }],
    },
  });
  assert.ok(findLine(bodyLines(inspector), "▸ ✗ Scan"), "✗ icon for error phase");
});

test("phase status icon shows - when all agents are skipped", () => {
  const { inspector: ins1 } = makeInspector({
    getToolsExpanded: () => false,
    snapshotOverrides: {
      agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "queued" }],
    },
  });
  assert.ok(findLine(bodyLines(ins1), "▸ ✓ Scan"), "queued-only phase shows ✓ (not error/run/skip)");

  const { inspector: ins2 } = makeInspector({
    getToolsExpanded: () => false,
    snapshotOverrides: {
      agents: [{ id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "skipped" }],
    },
  });
  assert.ok(findLine(bodyLines(ins2), "▸ - Scan"), "- icon for skipped phase");
});

// ---------------------------------------------------------------------------
// Render stability
// ---------------------------------------------------------------------------

test("workflow inspector keeps a stable render height across live updates", () => {
  const store = createActiveWorkflowStore();
  const active = store.create(snapshot());
  const inspector = createWorkflowInspector(
    active,
    { requestRender() {} },
    keybindings() as never,
    () => {},
    () => true,
  );

  const initialLines = inspector.render(96);

  active.update(
    snapshot({
      currentPhase: "Review",
      phases: ["Scan", "Review", "Synthesize"],
      logs: ["first", "second", "third", "fourth", "fifth", "sixth"],
      agents: [
        { id: 1, label: "scan repo", phase: "Scan", prompt: "Scan", status: "done", resultPreview: "ok" },
        { id: 2, label: "review api", phase: "Review", prompt: "Review", status: "running" },
        { id: 3, label: "review ui", phase: "Review", prompt: "Review", status: "queued" },
      ],
    }),
  );

  const updatedLines = inspector.render(96);
  assert.equal(updatedLines.length, initialLines.length);
});
