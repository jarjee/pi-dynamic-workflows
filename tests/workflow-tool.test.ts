import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTool } from "../src/workflow-tool.js";

test("createWorkflowTool describes phases as optional and dynamic", () => {
  const tool = createWorkflowTool();

  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name: 'short_snake_case', description:/);
  assert.doesNotMatch(tool.promptSnippet ?? "", /phases: \[/);
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("meta.phases is optional metadata")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Phase names may be conditional or built in a loop")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("file ownership")));
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
      modelsByStream: { light: "provider/light-model" },
    },
  });

  assert.deepEqual((prepared as any).policy, {
    defaultTools: ["read"],
    maxConcurrency: 2,
    hardAbortGraceMs: 0,
    projectRoles: "allow",
    modelsByStream: { light: "provider/light-model" },
  });
});
