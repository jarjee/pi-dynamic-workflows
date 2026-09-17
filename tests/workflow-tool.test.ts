import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowSnapshot } from "../src/index.js";
import { renderWorkflowLines } from "../src/index.js";
import { createWorkflowTool, type WorkflowToolOptions } from "../src/workflow-tool.js";

// ---------------------------------------------------------------------------
// Stubs and helpers
// ---------------------------------------------------------------------------

/** Deterministic subagent runner so tests never start real Pi sessions. */
const fakeAgent = {
  async run(prompt: string, _opts?: Record<string, unknown>): Promise<string> {
    return `result:${prompt}`;
  },
};

type ToolUpdate = { content: Array<{ type: "text"; text: string }>; details: unknown };

interface ExecOutcome {
  result?: { content?: Array<{ type: string; text: string }>; details?: unknown };
  error?: unknown;
  updates: ToolUpdate[];
}

interface RunningTool {
  updates: ToolUpdate[];
  done(): Promise<ExecOutcome>;
}

function makeCtx() {
  return {
    cwd: "/tmp",
    ui: { getToolsExpanded: () => false },
    modelRegistry: undefined,
    model: undefined,
  };
}

function startTool(options: WorkflowToolOptions, script: string, signal?: AbortSignal): RunningTool {
  const tool = createWorkflowTool(options);
  const updates: ToolUpdate[] = [];
  const promise = tool.execute("call_1", { script }, signal, (update) => updates.push(update), makeCtx() as never);
  return {
    updates,
    async done(): Promise<ExecOutcome> {
      try {
        const result = await promise;
        return { result, updates };
      } catch (error) {
        return { error, updates };
      }
    },
  };
}

async function execTool(options: WorkflowToolOptions, script: string): Promise<ExecOutcome> {
  return await startTool(options, script).done();
}

function updateSnapshots(outcome: ExecOutcome): WorkflowSnapshot[] {
  return outcome.updates.map((update) => update.details as WorkflowSnapshot);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Tool metadata / prompt guidance
// ---------------------------------------------------------------------------

test("createWorkflowTool describes workflow rules and documentation", () => {
  const tool = createWorkflowTool();

  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name, description \}/);
  assert.match(tool.promptSnippet ?? "", /registerPhase/);
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Plain JavaScript only")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("parallel() accepts")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("handoff()")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Do NOT embed backtick template literals")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Minimal valid workflow")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Workflow with gate")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Advanced reference")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("register-phase-dsl.md")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Subagent:")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Model:")));
});

test("createWorkflowTool guidance mentions the up-front phase outline and bounded rendering", () => {
  const tool = createWorkflowTool();

  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes("renders as pending phases")),
    "guidance should tell the model the phase outline renders up front",
  );
  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes("never exceeds a fixed line budget")),
    "guidance should tell the model progress rendering is bounded",
  );
});

test("createWorkflowTool guidance covers authoring patterns", () => {
  const tool = createWorkflowTool();

  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes("# Authoring Patterns")),
    "guidance should have an Authoring Patterns section",
  );
  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes("parallel() is a BARRIER")),
    "guidance should explain the pipeline-default / barrier rule",
  );
  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes("REFUTE")),
    "guidance should teach adversarial verification",
  );
  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes("budget.total")),
    "guidance should guard loops on budget.total",
  );
  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes("log()")),
    "guidance should require logging dropped coverage",
  );
  assert.ok(
    tool.promptGuidelines?.some((line) => line.includes("authoring-patterns.md")),
    "guidance should point at the full pattern catalog",
  );
});

test("createWorkflowTool accepts runtime policy arguments", () => {
  const tool = createWorkflowTool();

  const prepared = tool.prepareArguments?.({
    script: "export const meta = { name: 'policy', description: 'policy' }\nreturn 1",
    policy: {
      defaultTools: ["read"],
      maxConcurrency: 2,
      hardAbortGraceMs: 0,
      projectRoles: "allow",
      hostTools: ["ext_search"],
    },
  });

  assert.deepEqual((prepared as any).policy, {
    defaultTools: ["read"],
    maxConcurrency: 2,
    hardAbortGraceMs: 0,
    projectRoles: "allow",
    mailboxPauseTimeoutSeconds: undefined,
    hostTools: ["ext_search"],
  });
});

// ---------------------------------------------------------------------------
// Phase status wiring
// ---------------------------------------------------------------------------

test("workflow tool seeds the meta.phases outline as pending and marks the running phase", async () => {
  const outcome = await execTool(
    { agent: fakeAgent },
    `export const meta = {
  name: 'outline_demo',
  description: 'Seeded phase outline',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Synthesize' }]
}
registerPhase('Scan', async () => {
  return await agent('scan', { label: 'scan' })
})
registerPhase('Review', async () => {
  return await agent('review', { label: 'review' })
})
registerPhase('Synthesize', async () => {
  return await agent('synthesize', { label: 'synthesize' })
})
`,
  );

  assert.ok(outcome.result, `workflow should complete: ${String(outcome.error)}`);
  const snapshots = updateSnapshots(outcome);
  assert.ok(snapshots.length > 0, "at least one progress update should be emitted");

  // The very first update already carries the full outline: Scan running,
  // later phases still pending (seeded from meta.phases by createWorkflowSnapshot).
  assert.deepEqual(snapshots[0].phases, [
    { title: "Scan", status: "running" },
    { title: "Review", status: "pending" },
    { title: "Synthesize", status: "pending" },
  ]);
  assert.equal(snapshots[0].currentPhase, "Scan");
});

test("workflow tool upserts registerPhase-only outlines as pending before phases run", async () => {
  const outcome = await execTool(
    { agent: fakeAgent },
    `export const meta = { name: 'late_outline', description: 'registerPhase-only outline' }
registerPhase('One', async () => {
  return await agent('a', { label: 'a1' })
})
registerPhase('Two', async () => {
  return await agent('b', { label: 'b1' })
})
`,
  );

  assert.ok(outcome.result, `workflow should complete: ${String(outcome.error)}`);
  const snapshots = updateSnapshots(outcome);

  // Even without meta.phases, onPhaseRegistered upserts the outline before the
  // first phase runs: the first update announces both phases as pending.
  assert.deepEqual(snapshots[0].phases, [
    { title: "One", status: "pending" },
    { title: "Two", status: "pending" },
  ]);
  assert.equal(snapshots[0].currentPhase, undefined);

  // The next update marks the first phase running while the second stays pending.
  const oneStarted = snapshots.find((snapshot) => snapshot.currentPhase === "One");
  assert.ok(oneStarted, "an update should exist once phase One starts");
  assert.deepEqual(oneStarted.phases, [
    { title: "One", status: "running" },
    { title: "Two", status: "pending" },
  ]);
});

test("workflow tool transitions phases from running to done as later phases start", async () => {
  const outcome = await execTool(
    { agent: fakeAgent },
    `export const meta = {
  name: 'transition_demo',
  description: 'Phase transitions',
  phases: [{ title: 'Scan' }, { title: 'Review' }]
}
registerPhase('Scan', async () => {
  return await agent('scan', { label: 'scan' })
})
registerPhase('Review', async () => {
  return await agent('review', { label: 'review' })
})
`,
  );

  assert.ok(outcome.result, `workflow should complete: ${String(outcome.error)}`);
  const snapshots = updateSnapshots(outcome);

  const reviewStarted = snapshots.find((snapshot) => snapshot.currentPhase === "Review");
  assert.ok(reviewStarted, "an update should exist once Review starts");
  assert.deepEqual(reviewStarted.phases, [
    { title: "Scan", status: "done" },
    { title: "Review", status: "running" },
  ]);

  // Successful completion finalizes every phase as done.
  const final = outcome.result?.details as WorkflowSnapshot;
  assert.deepEqual(final.phases, [
    { title: "Scan", status: "done" },
    { title: "Review", status: "done" },
  ]);
});

test("workflow tool restarts a re-entered phase() title instead of leaving it stuck terminal", async () => {
  const outcome = await execTool(
    { agent: fakeAgent },
    `export const meta = { name: 'reentry_demo', description: 'Re-entered phase titles' }
for (let i = 0; i < 2; i++) {
  phase('Review')
  await agent('review ' + i, { label: 'review' + i })
  phase('Cooldown')
  await agent('cooldown ' + i, { label: 'cooldown' + i })
}
return 'ok'
`,
  );

  assert.ok(outcome.result, `workflow should complete: ${String(outcome.error)}`);
  const snapshots = updateSnapshots(outcome);

  // Second loop iteration: Cooldown (first run) is done and Review is running
  // again — not stuck at "done" from its first completion. Phase entries are
  // replaced immutably per update, so this captures the re-entry moment.
  const reviewRestarted = snapshots.find(
    (snapshot) =>
      snapshot.phases.some((entry) => entry.title === "Review" && entry.status === "running") &&
      snapshot.phases.some((entry) => entry.title === "Cooldown" && entry.status === "done"),
  );
  assert.ok(reviewRestarted, "an update should exist once Review is re-entered");
  assert.deepEqual(reviewRestarted.phases, [
    { title: "Review", status: "running" },
    { title: "Cooldown", status: "done" },
  ]);
  assert.equal(reviewRestarted.currentPhase, "Review");
  assert.ok(
    reviewRestarted.agents.some((agent) => agent.label === "review1"),
    "the re-entry snapshot should carry the second Review agent",
  );

  // The compact renderer must show the re-entered phase as a running line with
  // its agent visible beneath it, not a terminal summary line that hides the
  // live work.
  const lines = renderWorkflowLines(reviewRestarted);
  const reviewLine = lines.find((line) => line.includes("Review"));
  assert.ok(reviewLine, "the rendered output should include a Review line");
  assert.match(reviewLine, /▶ Review/, "re-entered phase renders as running");
  assert.doesNotMatch(reviewLine, /✓ Review/, "re-entered phase must not render as a terminal summary");
  assert.ok(
    lines.some((line) => line.includes("review1")),
    "the second Review agent should be visible under the re-entered phase",
  );

  // Once the workflow completes, the re-entered phase is finalized as done.
  const final = outcome.result?.details as WorkflowSnapshot;
  assert.deepEqual(final.phases, [
    { title: "Review", status: "done" },
    { title: "Cooldown", status: "done" },
  ]);
});

test("workflow tool records skipped and exhausted phase outcomes", async () => {
  const outcome = await execTool(
    { agent: fakeAgent },
    `export const meta = { name: 'outcome_demo', description: 'Phase outcomes' }
registerPhase('Warmup', async () => {
  return await agent('warm', { label: 'warmup' })
})
registerPhase('Skipped', async (input) => {
  return input
}, { skipIf: () => true })
registerPhase('Gated', async () => {
  return await agent('work', { label: 'worker' })
}, { gate: async () => 'still failing', maxIterations: 2 })
`,
  );

  assert.ok(outcome.result, `workflow should complete: ${String(outcome.error)}`);
  const snapshots = updateSnapshots(outcome);

  const gatedStarted = snapshots.find((snapshot) => snapshot.currentPhase === "Gated");
  assert.ok(gatedStarted, "an update should exist once the gated phase starts");
  assert.deepEqual(gatedStarted.phases, [
    { title: "Warmup", status: "done" },
    { title: "Skipped", status: "skipped" },
    { title: "Gated", status: "running" },
  ]);

  const final = outcome.result?.details as WorkflowSnapshot;
  assert.deepEqual(final.phases, [
    { title: "Warmup", status: "done" },
    { title: "Skipped", status: "skipped" },
    { title: "Gated", status: "exhausted" },
  ]);
});

test("workflow tool marks the running phase skipped on abort", async () => {
  const controller = new AbortController();
  const hangingAgent = {
    run(_prompt: string, opts?: Record<string, unknown>): Promise<string> {
      return new Promise((_resolve, reject) => {
        (opts?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
          reject(new Error("agent aborted"));
        });
      });
    },
  };

  const run = startTool(
    { agent: hangingAgent },
    `export const meta = {
  name: 'abort_demo',
  description: 'Abort during a phase',
  phases: [{ title: 'Scan' }, { title: 'Review' }]
}
registerPhase('Scan', async () => {
  return await agent('hang', { label: 'hanger' })
})
registerPhase('Review', async () => {
  return await agent('review', { label: 'reviewer' })
})
`,
    controller.signal,
  );

  await waitFor(() => run.updates.length > 0);
  controller.abort();
  const outcome = await run.done();

  assert.ok(outcome.error instanceof Error, "abort should reject the tool call");
  assert.match((outcome.error as Error).message, /Workflow was aborted/);
  assert.ok(outcome.updates.length > 0, "a final completed update should be emitted");

  const last = outcome.updates[outcome.updates.length - 1].details as WorkflowSnapshot;
  assert.deepEqual(last.phases, [
    { title: "Scan", status: "skipped" },
    { title: "Review", status: "pending" },
  ]);
  assert.ok(
    last.agents.every((agent) => agent.status === "skipped"),
    "running agents should be marked skipped on abort",
  );
});

test("workflow tool success details carry rich phase snapshots, not plain strings", async () => {
  const outcome = await execTool(
    { agent: fakeAgent },
    `export const meta = { name: 'details_demo', description: 'Rich details', phases: [{ title: 'Scan' }] }
registerPhase('Scan', async () => {
  return await agent('scan', { label: 'scan' })
})
`,
  );

  assert.ok(outcome.result, `workflow should complete: ${String(outcome.error)}`);
  const details = outcome.result?.details as WorkflowSnapshot;
  assert.ok(
    details.phases.every((phase) => typeof phase === "object" && phase !== null && "status" in phase),
    "details.phases must be WorkflowPhaseSnapshot[] entries",
  );
  assert.deepEqual(details.phases, [{ title: "Scan", status: "done" }]);
});

test("workflow tool progress text stays within the 20-line budget for large outlines", async () => {
  const titles = Array.from({ length: 30 }, (_, index) => `Phase ${index}`);
  const script = `export const meta = {
  name: 'bounded_demo',
  description: 'Bounded progress rendering',
  phases: [${titles.map((title) => `{ title: '${title}' }`).join(", ")}]
}
registerPhase('Phase 0', async () => {
  return await agent('work', { label: 'worker' })
})
`;

  const outcome = await execTool({ agent: fakeAgent }, script);
  assert.ok(outcome.result, `workflow should complete: ${String(outcome.error)}`);

  for (const update of outcome.updates) {
    const text = update.content[0]?.text ?? "";
    const lines = text.split("\n");
    assert.ok(
      lines.length <= 21,
      `progress text must stay within the 20-line budget (plus header), got ${lines.length}`,
    );
  }

  // The pending outline is present but collapsed: excess pending phases are
  // summarized instead of rendered one line each.
  const first = outcome.updates[0]?.content[0]?.text ?? "";
  assert.ok(first.includes("Phase 1"), "first kept pending phase is rendered");
  assert.ok(first.includes("more phases"), "excess pending phases collapse into a summary line");
});
