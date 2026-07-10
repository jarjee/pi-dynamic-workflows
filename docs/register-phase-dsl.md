# Phase Registration DSL

## Overview

The current workflow DSL intersperses `phase()` calls with `await agent()` chains — the DAG shape is invisible until execution completes. The `registerPhase()` DSL makes phases top-level declarations with automatic data flow. The full workflow shape is known before the first subagent runs, eliminating the `[object Promise]` footgun.

## Core API

### `registerPhase(name, body, options?)`

Registers a phase by name. Phases execute in declaration order. `body` receives the previous phase's return value. The body's return value flows to the next phase.

```js
registerPhase("Name", async (input) => {
  // input = previous phase's return value
  // All existing primitives work here: agent(), spawn(), parallel(), handoff(), log()
  return await agent("do work", {
    model: "provider/code-model",
    tools: ["read", "edit", "write", "bash"]
  })
}, {
  gate: async (output, upstreamOutput) => {
    // Validates the phase output. Returns null (pass) or string (fail).
    const result = await agent("run tests", { model: "provider/fast-model", tools: ["bash"] })
    return result.includes("FAIL") ? result : null
  },
  maxIterations: 3,
  skipIf: (input) => input.shouldSkip,
})
```

#### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `name` | `string` | Phase name — appears in progress UI. Must be unique within the workflow. |
| `body` | `(input: any) => Promise<any>` | Phase body. Receives preceding phase's return value. Undefined for first phase. Return flows to next phase. |
| `options.gate` | `(output: any, upstreamOutput: any) => Promise<string \| null>` | Validates phase output. `null` → pass (advance to next phase). `string` → fail (retry). On retry, the failure string is injected into the body's subagent prompt as `<retry>` context. |
| `options.maxIterations` | `number` | Max attempts including first run. Default 1. Gate present → default 3. After exhaustion, phase returns last output with `__phaseMeta.exhausted = true`. |
| `options.skipIf` | `(input: any) => boolean` | If returns true, phase is skipped (does not run, shows "skipped" in UI). |

### `handoff(value)` — unchanged

Still available WITHIN a phase body for passing data to subagents inside that phase:

```js
registerPhase("Scan", async () => {
  const data = await agent("scan", { model: "provider/fast-model" })
  const ref = handoff(data)   // serializes large outputs for downstream agents
  await agent("analyze: " + ref, { model: "provider/code-model" })
  return data   // flows to next phase
})
```

### Other globals — unchanged

`agent()`, `spawn()`, `parallel()`, `pipeline()`, `log()`, `mailbox`, `phase()` all work inside phase bodies exactly as they do today.

`phase("Label")` inside a body is a progress marker (sub-phase), not a new top-level phase.

## Gate iteration model

The runtime wraps the body's subagent prompts with iteration context. The body writes ONE prompt. The runtime adds `<iteration:N/M>` and, on retry, `<retry>` context containing the gate's failure string.

### What the subagent sees

**Iteration 0:**
```
<iteration:0/3>
Implement the plan. Write code and run tests.
</iteration>
```

**Iteration 1 (gate failed):**
```
<iteration:1/3>
Implement the plan. Write code and run tests.
<retry>Gate check failed and the phase is retrying. Fix:
  FAIL: src/auth.ts:42 - expected token, got null
</retry>
</iteration>
```

The subagent self-heals by reading the `<retry>` block. The body has no `if (error)` branch — no manual prompt construction for retries.

### Exhausted iterations

When `maxIterations` is exhausted (all attempts failed gate), the phase completes with metadata:

```
phase output = { ...actualBodyReturn, __phaseMeta: { exhausted: true, iteration: 3, gateError: "..." } }
```

Downstream phases check `input.__phaseMeta?.exhausted` to decide whether to halt or continue.

## Complete workflow example

```js
export const meta = { name: "implement_feature", description: "Plan, implement with gate, validate, synthesize" }

// Phase 1: Plan
registerPhase("Plan", async () => {
  return await agent("Create a detailed migration plan", {
    model: "provider/reasoning-model", thinkingLevel: "high", role: "package:planner"
  })
})

// Phase 2: Implement (with gate + retry)
registerPhase("Implement", async (plan) => {
  const ref = handoff(plan)
  return await parallel(["auth", "billing", "notifications"].map(mod => () =>
    agent("Implement " + mod + " from plan:\n" + ref, {
      model: "provider/code-model",
      label: "impl-" + mod,
      tools: ["read", "edit", "write"],
    })
  ))
}, {
  gate: async (output, plan) => {
    const result = await agent("Run `npm test` and report failures verbatim with line numbers", {
      model: "provider/fast-model", tools: ["bash"]
    })
    return result.includes("FAIL") ? result : null
  },
  maxIterations: 3,
})

// Phase 3: Validate
registerPhase("Validate", async (implOutput) => {
  return await agent("Review implementation quality:\n" + handoff(implOutput), {
    model: "provider/reasoning-model", role: "package:reviewer", thinkingLevel: "high"
  })
})

// Phase 4: Synthesize
registerPhase("Synthesize", async (review) => {
  return await agent("Executive summary from review:\n" + handoff(review), {
    model: "provider/reasoning-model", role: "package:synthesizer"
  })
})
```

## Team/work pattern (spawn + mailbox)

```js
registerPhase("Implement with team", async (plan) => {
  const arch = spawn("Design interface from plan:\n" + plan, {
    label: "architect", mailbox: true,
    model: "provider/reasoning-model", thinkingLevel: "high",
  })
  const workers = ["auth", "billing", "notifications"].map(mod =>
    spawn("Implement " + mod, {
      label: "worker-" + mod, mailbox: true,
      model: "provider/code-model",
      tools: ["read", "edit", "write"],
    })
  )
  // Wire communication
  for (const w of workers) mailbox.connect(arch.id, w.id)

  // Await all
  await parallel([() => arch.result, ...workers.map(w => () => w.result)])
  return arch.result  // just the design — or aggregate as needed
})
```

## What changes from the current DSL

| Current | New |
|---------|-----|
| `phase("Name"); await agent(...)` interspersed | `registerPhase("Name", async (input) => { ... })` at top level |
| `handoff()` used between phases → `[object Promise]` | `handoff()` stays WITHIN a phase; cross-phase data flows automatically |
| DAG shape invisible until execution | All phases collected synchronously; full shape known before first agent runs |
| Ad-hoc model hints | `model: "provider/model-id"` — explicit model ref on every agent/spawn call |
| Validation gates ad-hoc | `gate` sub-lambda on phase, runtime-managed iteration+retry context |

## What stays the same

- `agent()`, `spawn()`, `parallel()`, `pipeline()`, `handoff()`, `log()`, `mailbox` — all unchanged inside phase bodies
- `tools`, `label`, `thinkingLevel`, `role`, `schema`, `retry`, `timeoutSeconds` — all unchanged on `agent()`/`spawn()` calls
- `policy` — unchanged
- `args`, `cwd`, `budget`, `console` — unchanged

## Model reference guide

| Role | Recommended model ref |
|------|------------------------|
| Cheap scans, grep, classification, fan-out | a fast configured model via `provider/fast-model` |
| Code generation, review, implementation | a stronger configured code model via `provider/code-model` |
| Architecture, adversarial review, final synthesis | a configured reasoning/frontier model via `provider/reasoning-model` |

Use `thinkingLevel: "high"` with heavy models for complex reasoning tasks.