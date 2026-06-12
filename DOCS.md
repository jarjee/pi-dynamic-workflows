# pi-dynamic-workflows — Workflow Tool Reference

This is the primary reference for writing workflow scripts. Read this file before writing any workflow. For advanced features, follow the links to detailed docs.

## Script shape

A workflow is plain JavaScript (no TypeScript, no imports, no `require`, no `fs`). The first statement must export literal metadata:

```js
export const meta = { name: 'my_workflow', description: 'What this workflow does' }
```

`name` and `description` are required. `meta.phases` is optional static documentation — live progress is driven by `phase()` calls at runtime. The script must call `agent()` or `spawn()` at least once.

`Date.now()`, `new Date()`, and `Math.random()` are unavailable — workflow orchestration logic must be deterministic. Subagents can use any tools they're given. Built-in coding tools are 'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'. Extension tools (MCP, project-specific) registered at the pi host level are also available by name in the `tools` array.

## Globals

| Global | Description |
|--------|-------------|
| `agent(prompt, opts)` | Run a subagent and await its result. Returns text, or a validated object with `opts.schema`. |
| `spawn(prompt, opts)` | Start a subagent, return a handle `{ id, label, status(), result }`. For teams/mailbox. |
| `parallel(thunks)` | Run `() => agent(...)` functions concurrently. **Takes functions, not promises.** Returns results in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages; items fan out concurrently. Each stage: `(prev, original, index)`. |
| `handoff(value, opts)` | Serialize a value for passing between agents. Small values inline, large values written to temp file. **Synchronous — no await needed.** |
| `phase(title)` | Mark the current progress phase. Drives live UI grouping. |
| `log(message)` | Append a workflow-level log line. |
| `mailbox` | Supervisor API for communicating agents: `allow`, `connect`, `send`. See [teams docs](docs/teams.md). |
| `args` | Optional JSON passed via the tool's `args` parameter. |
| `policy` | Frozen runtime policy (tools, concurrency, model routing). |
| `cwd` / `process.cwd()` | Working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |
| `isUncatchable(error)` | Check if an error is an abort signal that must be re-thrown. |

## Agent options

```js
await agent('Your task prompt here.', {
  label: 'short label',           // required — 2-5 words, unique, drives progress display
  tools: ['read', 'grep', 'ls'],  // tool name allowlist; omit for defaults; [] for none
  // Extension tools (MCP, project-specific) are available by name just like built-ins.
  stream: 'light',                // 'light' | 'medium' | 'heavy' — policy routes to a model
  model: 'provider/model-id',     // explicit model (overrides stream)
  thinkingLevel: 'high',          // 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  role: 'package:reviewer',       // prepend a reusable role prompt
  schema: { /* JSON Schema */ },  // subagent must call structured_output; returns validated object
  retry: { attempts: 3 },         // retry on failure before returning null
  timeoutSeconds: 300,            // per-attempt wall-clock timeout
  mailbox: true,                  // enable mailbox tools (use with spawn())
})
```

Default tools are read-only: `read`, `grep`, `find`, `ls`, plus any extension tools registered at the pi host level. Add `bash`, `edit`, `write` only for side-effectful agents.

## Failure handling

Failed `agent()`, `parallel()`, and `pipeline()` branches return `null` — they do not throw. Always check for nulls before using results or passing them to synthesis.

If a workflow script itself fails (runtime error, not a subagent failure), the tool returns a **recovery result** with paths to completed agent results on disk. You can write a new workflow that reads those recovery files to continue from where the previous one failed.

## Abort handling

When the user presses Esc, all active subagents are aborted. Abort errors are tagged as **uncatchable** — if you use `try/catch` in a workflow script, re-throw uncatchable errors:

```js
try {
  await agent('risky work', { label: 'risky' })
} catch (error) {
  if (isUncatchable(error)) throw error
  log('agent failed, continuing...')
}
```

## Examples

### Example 1: Fan-out review (simple team)

Three agents review different aspects, results synthesized. The most common workflow shape.

```js
export const meta = { name: 'review_modules', description: 'Multi-perspective module review' }

phase('Scan')
const inventory = await agent('List all source modules, their purpose, and key exports.', {
  label: 'repo scan',
  stream: 'light',
})

phase('Review')
const ref = handoff(inventory)
const aspects = ['error handling', 'test coverage', 'API consistency']
const reviews = await parallel(aspects.map(aspect => () =>
  agent(`Review the codebase for ${aspect}. Repo context:\n${ref}`, {
    label: `review ${aspect}`,
    stream: 'medium',
  })
))

phase('Synthesize')
const valid = reviews.filter(Boolean)
const allRef = handoff(valid)
return await agent(`Synthesize these reviews into actionable findings:\n${allRef}`, {
  label: 'synthesis',
  stream: 'heavy',
  thinkingLevel: 'high',
})
```

### Example 2: Coordinated team (architect + workers + QA)

Agents communicate via mailbox. The architect designs, workers implement and test, QA reviews.

```js
export const meta = { name: 'implement_feature', description: 'Team-based feature implementation' }

phase('Design')
const architect = spawn(
  `Design the interface for user preferences. Write the types to src/types/preferences.ts.
   When done, send your contract to all peers via mailbox_send.`,
  { label: 'architect', mailbox: true, tools: ['read', 'find', 'write'], stream: 'heavy' }
)

const tester = spawn(
  `You are the test agent. Wait for the architect to send you the interface contract.
   Write tests based on the contract to tests/preferences/. When the implementer notifies
   you, run the tests and report red/green results.`,
  { label: 'tester', mailbox: true, tools: ['read', 'write', 'bash'], stream: 'medium' }
)

const implementer = spawn(
  `You are the implementation agent. Wait for the architect contract via mailbox.
   Implement the preferences API in src/api/preferences/ and src/db/preferences/.
   When done, notify the tester via mailbox_send.`,
  { label: 'implementer', mailbox: true, tools: ['read', 'write', 'edit'], stream: 'medium' }
)

const qa = spawn(
  `Review the architect's design for gaps, then review the implementation for correctness.
   Check code quality and consistency. You own no files — read only.`,
  { label: 'qa reviewer', mailbox: true, tools: ['read', 'grep', 'find'], stream: 'heavy' }
)

// Wire communication channels
mailbox.connect(architect.id, tester.id)
mailbox.connect(architect.id, implementer.id)
mailbox.connect(architect.id, qa.id)
mailbox.connect(implementer.id, tester.id)
mailbox.connect(implementer.id, qa.id)

phase('Execute')
const [design, tests, impl, review] = await parallel([
  () => architect.result,
  () => tester.result,
  () => implementer.result,
  () => qa.result,
])

phase('Validate')
return await agent('Run the full test suite and linter. Report pass/fail.', {
  label: 'final validation',
  tools: ['read', 'bash'],
  stream: 'medium',
})
```

### Example 3: Multi-cycle workflow (fan-out → gate → fix → validate)

Multiple implementation lanes, each with its own validation gate, then a final integration check.

```js
export const meta = { name: 'migrate_modules', description: 'Migrate three modules with per-module validation' }

const modules = [
  { name: 'auth', dir: 'src/auth/', tests: 'tests/auth/' },
  { name: 'billing', dir: 'src/billing/', tests: 'tests/billing/' },
  { name: 'notifications', dir: 'src/notifications/', tests: 'tests/notifications/' },
]

// Phase 1: Plan
phase('Plan')
const plan = await agent(
  'Read the codebase and create a migration plan for moving from Express to Hono.', {
  label: 'migration plan',
  stream: 'heavy',
  thinkingLevel: 'high',
  role: 'package:planner',
})

// Phase 2: Implement + validate per module (fan-out with per-lane gates)
phase('Migrate')
const planRef = handoff(plan)
const results = await parallel(modules.map(mod => () =>
  pipeline(
    [mod],
    // Stage 1: Implement
    async (mod) => {
      const result = await agent(
        `Migrate ${mod.name} from Express to Hono. You own ${mod.dir}.\nPlan:\n${planRef}`, {
        label: `migrate ${mod.name}`,
        tools: ['read', 'edit', 'write'],
        stream: 'medium',
      })
      return { mod, result }
    },
    // Stage 2: Validate (gate)
    async ({ mod, result }) => {
      const validation = await agent(
        `Run tests for ${mod.name}: cd ${mod.tests} && npm test. Fix any failures. You own ${mod.dir} and ${mod.tests}.`, {
        label: `validate ${mod.name}`,
        tools: ['read', 'edit', 'bash'],
        stream: 'medium',
        schema: {
          type: 'object',
          properties: {
            module: { type: 'string' },
            passed: { type: 'boolean' },
            failures: { type: 'array', items: { type: 'string' } },
          },
          required: ['module', 'passed'],
        },
        retry: { attempts: 2 },
      })
      return validation
    },
  )
))

// Phase 3: Integration check
phase('Integration')
const valid = results.filter(Boolean)
const resultsRef = handoff(valid)
return await agent(
  `All module migrations are done. Run the full integration test suite.
   Module results:\n${resultsRef}`, {
  label: 'integration check',
  tools: ['read', 'bash'],
  stream: 'heavy',
  role: 'package:critic',
  thinkingLevel: 'high',
})
```

## Detailed documentation

### [Workflow API Reference](docs/workflow-api.md)

Full reference for all globals, agent/spawn options, and runtime behavior.

**Read this when:** using `pipeline()`, `schema`, `retry`, `timeoutSeconds`, `role`, runtime `policy`, `budget`, or `handoff()` with custom `inlineLimit`. Also covers the determinism rules, meta format, and structured output contract.

**Keywords:** pipeline stages, JSON Schema, structured_output, retry backoff, timeout, reusable roles (package:reviewer, package:critic, package:planner, package:synthesizer, package:scout, package:worker), policy maxConcurrency, modelsByStream, defaultTools, projectRoles, token budget, handoff inlineLimit, meta.phases, determinism sandbox.

### [Team Composition & Mailbox](docs/teams.md)

How to plan and coordinate teams of communicating agents using `spawn()` and the mailbox system.

**Read this when:** building workflows where agents need to communicate, coordinate on shared work, wait for each other, or operate as a team with directed message passing. Also covers when to use `spawn()` vs `agent()`, file ownership planning, and prompt templates for team members.

**Keywords:** spawn, mailbox, mailbox.connect, mailbox.allow, mailbox.send, mailbox_peers, mailbox_send, mailbox_pause, team composition, architect pattern, worker pattern, file ownership, directed channels, pause/resume, transcript debugging, communicating agents, TDD team, competing hypotheses.

### [Side-Effectful Workflows](docs/side-effects.md)

File ownership rules, validation gates, and patterns for workflows that edit code.

**Read this when:** writing workflows where agents use `edit`, `write`, or `bash` to modify files. Covers how to define non-overlapping file ownership, when to serialize vs parallelize lanes, and how to add validation gates (lint, typecheck, test) before reporting completion.

**Keywords:** file ownership, non-overlapping directories, validation gate, lint, typecheck, test suite, implementation lanes, side effects, edit, write, bash, tools allowlist, serialize dependencies, repair failures, progress reporting.
