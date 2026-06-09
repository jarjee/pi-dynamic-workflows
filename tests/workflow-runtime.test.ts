import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowAgent } from "../src/agent.js";
import { runWorkflow } from "../src/workflow.js";

const fakeAgent = {
  async run(prompt: string): Promise<string> {
    return `result:${prompt}`;
  },
};

test("runWorkflow forwards requested tool allowlists to subagents", async () => {
  const calls: Array<{ tools?: string[] }> = [];
  const agentRunner = {
    async run(_prompt: string, options: { tools?: string[] }): Promise<string> {
      calls.push({ tools: options.tools });
      return "ok";
    },
  };

  await runWorkflow(
    `export const meta = {
  name: 'tool_allowlist',
  description: 'Request read-only tools'
}

return await agent('review docs', { label: 'review', tools: ['read', 'grep'] })
`,
    { agent: agentRunner },
  );

  assert.deepEqual(calls, [{ tools: ["read", "grep"] }]);
});

test("WorkflowAgent rejects unknown tool allowlist names before launching", async () => {
  const agentRunner = new WorkflowAgent();

  await assert.rejects(
    () => agentRunner.run("do work", { tools: ["not-a-real-tool"] }),
    /Unknown or unavailable workflow subagent tool: not-a-real-tool/,
  );
});

test("WorkflowAgent applies runtime default tool allowlists when an agent omits tools", async () => {
  const agentRunner = new WorkflowAgent({ defaultTools: ["not-a-real-default-tool"] });

  await assert.rejects(
    () => agentRunner.run("do work"),
    /Unknown or unavailable workflow subagent tool: not-a-real-default-tool/,
  );
});

test("runWorkflow accepts metadata without phases and records runtime phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.phases, ["Scan"]);
  assert.equal(result.agentCount, 1);
  assert.equal((result.result as { scan: string }).scan, "result:scan");
});

test("runWorkflow records loop-created phases without skipped conditional phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ["API", "UI"] },
      agent: fakeAgent,
    },
  );

  assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
  assert.equal(result.agentCount, 2);
});

test("runWorkflow rejects unawaited nested agent promises before returning details", async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/,
  );

  assert.equal(ended, 1);
});

test("runWorkflow rejects non-string runtime phase titles", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /phase title must be a string/,
  );
});

test("runWorkflow allows prompts that mention nondeterministic API names", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.equal(
    (result.result as { scan: string }).scan,
    "result:Catalog Date.now(), Math.random(), and new Date() usage",
  );
});
