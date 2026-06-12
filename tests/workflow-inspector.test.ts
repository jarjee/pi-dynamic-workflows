import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowSnapshot } from "../src/index.js";
import { createActiveWorkflowStore, createWorkflowInspector, recomputeWorkflowSnapshot } from "../src/index.js";

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

function keybindings() {
  return {
    matches(data: string, keybinding: string) {
      return data === "ctrl+o" && keybinding === "app.tools.expand";
    },
  };
}

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

test("workflow inspector ctrl+o resets local phase overrides to the global baseline", () => {
  const store = createActiveWorkflowStore();
  const active = store.create(snapshot());
  const inspector = createWorkflowInspector(
    active,
    { requestRender() {} },
    keybindings() as never,
    () => {},
    () => false,
  );

  assert.ok(inspector.render(96).some((line) => line.includes("▸ ▶ Scan")));
  inspector.handleInput(" ");
  assert.ok(inspector.render(96).some((line) => line.includes("#1 ● scan repo")));
  inspector.handleInput("ctrl+o");
  assert.ok(inspector.render(96).some((line) => line.includes("#1 ● scan repo")));
});
