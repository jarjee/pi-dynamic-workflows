import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTool } from "../src/workflow-tool.js";

test("createWorkflowTool describes workflow rules and documentation", () => {
  const tool = createWorkflowTool();

  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name, description \}/);
  assert.match(tool.promptSnippet ?? "", /registerPhase/);
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Plain JavaScript only")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("parallel() takes functions")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("handoff()")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Do NOT embed backtick template literals")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Minimal valid workflow")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Workflow with gate")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Advanced reference")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("register-phase-dsl.md")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Subagent:")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Model:")));
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
      modelsByWeight: { light: "provider/light-model" },
      hostTools: ["glean_search"],
    },
  });

  assert.deepEqual((prepared as any).policy, {
    defaultTools: ["read"],
    maxConcurrency: 2,
    hardAbortGraceMs: 0,
    projectRoles: "allow",
    modelsByWeight: { light: "provider/light-model" },
    modelsByStream: undefined,
    mailboxPauseTimeoutSeconds: undefined,
    hostTools: ["glean_search"],
  });
});
