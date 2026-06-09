import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("runWorkflow applies policy default tool allowlists to omitted agent tools", async () => {
  const calls: Array<{ tools?: string[] }> = [];
  const agentRunner = {
    async run(_prompt: string, options: { tools?: string[] }): Promise<string> {
      calls.push({ tools: options.tools });
      return "ok";
    },
  };

  await runWorkflow(
    `export const meta = {
  name: 'policy_default_tools',
  description: 'Use policy default tools'
}

return await agent('do work', { label: 'worker' })
`,
    { agent: agentRunner, policy: { defaultTools: ["read"] } },
  );

  assert.deepEqual(calls, [{ tools: ["read"] }]);
});

test("runWorkflow forwards requested model refs to subagents", async () => {
  const calls: Array<{ model?: string }> = [];
  const agentRunner = {
    async run(_prompt: string, options: { model?: string }): Promise<string> {
      calls.push({ model: options.model });
      return "ok";
    },
  };

  await runWorkflow(
    `export const meta = {
  name: 'model_ref',
  description: 'Request a model'
}

return await agent('deep review', { label: 'review', model: 'anthropic/claude-opus-4-6' })
`,
    { agent: agentRunner },
  );

  assert.deepEqual(calls, [{ model: "anthropic/claude-opus-4-6" }]);
});

test("WorkflowAgent rejects unresolved model refs before launching", async () => {
  const agentRunner = new WorkflowAgent({
    session: { modelRegistry: { find: () => undefined } as any },
  });

  await assert.rejects(
    () => agentRunner.run("do work", { model: "anthropic/missing-model" }),
    /Unknown workflow subagent model: anthropic\/missing-model/,
  );
});

test("runWorkflow retries failed agent attempts before returning a result", async () => {
  let attempts = 0;
  const logs: string[] = [];
  const agentRunner = {
    async run(): Promise<string> {
      attempts++;
      if (attempts < 3) throw new Error(`temporary failure ${attempts}`);
      return "ok after retry";
    },
  };

  const result = await runWorkflow(
    `export const meta = {
  name: 'retry_agent',
  description: 'Retry a flaky subagent'
}

return await agent('flaky', { label: 'flaky', retry: { attempts: 3, delayMs: 0 } })
`,
    { agent: agentRunner, onLog: (message) => logs.push(message) },
  );

  assert.equal(attempts, 3);
  assert.equal(result.result, "ok after retry");
  assert.ok(logs.some((line) => line.includes("agent flaky attempt 1/3 failed: temporary failure 1")));
});

test("runWorkflow times out an agent attempt and returns null after retries are exhausted", async () => {
  const signals: AbortSignal[] = [];
  const logs: string[] = [];
  const agentRunner = {
    async run(_prompt: string, options: { signal?: AbortSignal }): Promise<string> {
      if (!options.signal) throw new Error("expected child signal");
      signals.push(options.signal);
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("child aborted")), { once: true });
      });
      return "unreachable";
    },
  };

  const result = await runWorkflow(
    `export const meta = {
  name: 'timeout_agent',
  description: 'Timeout a stuck subagent'
}

return await agent('stuck', { label: 'stuck', timeoutSeconds: 0.001, retry: { attempts: 1 } })
`,
    { agent: agentRunner, onLog: (message) => logs.push(message) },
  );

  assert.equal(result.result, null);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  assert.ok(logs.some((line) => line.includes("agent stuck failed: child aborted")));
});

test("runWorkflow prepends source-qualified role prompts to subagent instructions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-roles-"));
  try {
    await writeFile(join(dir, "reviewer.md"), "You are a careful reviewer.");
    const calls: Array<{ instructions?: string }> = [];
    const agentRunner = {
      async run(_prompt: string, options: { instructions?: string }): Promise<string> {
        calls.push({ instructions: options.instructions });
        return "ok";
      },
    };

    await runWorkflow(
      `export const meta = {
  name: 'role_prompt',
  description: 'Use a package role'
}

return await agent('review this', { label: 'review', role: 'package:reviewer' })
`,
      { agent: agentRunner, roles: { packageDir: dir } },
    );

    assert.equal(calls.length, 1);
    assert.match(calls[0].instructions ?? "", /Role package:reviewer/);
    assert.match(calls[0].instructions ?? "", /You are a careful reviewer\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkflow denies project roles unless explicitly allowed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-project-roles-"));
  try {
    await writeFile(join(dir, "worker.md"), "Project-controlled worker.");
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = {
  name: 'project_role_denied',
  description: 'Deny project role by default'
}

return await agent('work', { label: 'worker', role: 'project:worker' })
`,
          { agent: fakeAgent, roles: { projectDir: dir } },
        ),
      /Project workflow roles are denied by policy: project:worker/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkflow hard-aborts active subagents when the parent signal aborts", async () => {
  const controller = new AbortController();
  let abortAllCalls = 0;
  let disposeAllCalls = 0;
  const agentRunner = {
    async run(_prompt: string, options: { signal?: AbortSignal }): Promise<string> {
      setTimeout(() => controller.abort(), 1);
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("child aborted")), { once: true });
      });
      return "unreachable";
    },
    abortAll() {
      abortAllCalls++;
    },
    disposeAll() {
      disposeAllCalls++;
    },
  };

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'abort_workflow',
  description: 'Abort active work'
}

return await agent('stuck', { label: 'stuck' })
`,
        { agent: agentRunner, signal: controller.signal, hardAbortGraceMs: 0 },
      ),
    /child aborted/,
  );

  assert.equal(abortAllCalls, 1);
  assert.equal(disposeAllCalls, 1);
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
