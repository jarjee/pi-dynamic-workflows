# pi-dynamic-workflows — Workflow Tool Reference

This is the primary reference for writing workflow scripts. Read this file before writing any workflow. For advanced features, follow the links to detailed docs.

## Script shape

A workflow is plain JavaScript (no TypeScript, no imports, no `require`, no `fs`). The first statement must export literal metadata:

```js
export const meta = { name: 'my_workflow', description: 'What this workflow does' }
```

`name` and `description` are required. `meta.phases` is an optional upfront outline — its titles are announced before the script body runs and appear as pending phases in the live view. `registerPhase()` declarations are announced the same way (deduplicated against `meta.phases`), and runtime `phase()` calls still group agents as work starts. The script must call `agent()` or `spawn()` at least once.

`Date.now()`, `new Date()`, and `Math.random()` are unavailable — workflow orchestration logic must be deterministic. Subagents can use any tools they're given. Built-in coding tools are 'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'. Extension tools (MCP, project-specific) registered at the pi host level are also available by name in the `tools` array.

## Globals

| Global | Description |
|--------|-------------|
| `agent(prompt, opts)` | Run a subagent and await its result. Returns text, or a validated object with `opts.schema`. |
| `spawn(prompt, opts)` | Start a subagent, return a handle `{ id, label, status(), result }`. For teams/mailbox. |
| `registerPhase(name, body, opts)` | Declare a top-level phase with automatic data flow. Supports `gate`, `maxIterations`, `skipIf`. |
| `parallel(thunks)` | Run `() => agent(...)` functions (or already-started promises) concurrently. Returns results in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages; items fan out concurrently. Each stage: `(prev, original, index)`. |
| `handoff(value, opts)` | Serialize a value for passing between agents. Small values inline, large values written to temp file. **Synchronous — no await needed.** |
| `phase(title)` | Mark the current progress phase. Drives live UI grouping. |
| `log(message)` | Append a workflow-level log line. |
| `mailbox` | Supervisor API for communicating agents: `allow`, `connect`, `send`. See [teams docs](docs/teams.md). |
| `args` | Optional JSON passed via the tool's `args` parameter. |
| `policy` | Frozen runtime policy (tools, concurrency). |
| `cwd` / `process.cwd()` | Working directory for subagents. |
| `console` | Deterministic console shim (`log`/`info`/`warn`/`error` append to workflow logs). |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

## Agent options

```js
await agent('Your task prompt here.', {
  label: 'short label',           // required — 2-5 words, unique, drives progress display
  tools: ['read', 'grep', 'ls'],  // tool name allowlist; omit for defaults; [] for none
  // Extension tools (MCP, project-specific) are available by name just like built-ins.
  model: 'provider/model-id',     // explicit provider/model ref (required to pick a model)
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

When the user presses Esc, all active subagents are aborted. Workflow scripts should not use `try/catch` around `agent()` to handle subagent failures — failed `agent()` calls return `null` rather than throwing. Abort errors propagate out of the workflow runtime automatically; there is no `isUncatchable` global to call.

## Composition: parallel() vs pipeline()

`pipeline(items, ...stages)` is the default for multi-stage work. Items fan out concurrently and each flows through the stages independently — there is no barrier between stages, so one item can be in its last stage while another is still in its first. Wall-clock time is the slowest single-item chain, not the sum of the slowest stages.

`parallel(thunks)` is a barrier: it awaits every lane before returning. Use it only when the next step genuinely needs cross-lane context from all prior results — deduping or merging across the full set before expensive downstream work, exiting early when the total is zero, or a synthesis prompt that references the other lanes' findings. Needing to flatten, map, or filter between steps is not a reason to barrier: do the transform inside a pipeline stage. Conceptually separate stages are not synchronized stages.

The full decision guide — wall-clock examples plus the quality patterns that build on this choice (adversarial verify, judge panel, loop-until-dry, budget-scaled fan-out) — is in [Workflow Authoring Patterns](docs/authoring-patterns.md).

## Phase status and live progress

Every phase in the live progress view carries a status:

| Status | Marker | Meaning |
|--------|--------|---------|
| `pending` | `○` | Declared (via `meta.phases` or `registerPhase`) but not started yet. |
| `running` | `▶` | Currently executing. |
| `done` | `✓` | Finished normally, including a gate that passed on a retry. |
| `skipped` | `-` | `skipIf` returned true, or the workflow was aborted mid-phase. |
| `exhausted` | `⚠` | Gate retries ran out (`__phaseMeta.exhausted`). |

The full phase outline is announced before the first subagent runs: `meta.phases` titles are announced before the script body starts, and `registerPhase()` declarations are announced (deduplicated) before the first phase executes. Pending phases are visible from the start, so progress reads as a plan being executed rather than a log being appended.

Progress rendering is bounded. The inline view never exceeds a line budget (`maxLines`, default 20), no matter how many phases or subagents the workflow has. Completed phases render as one summary line each, and when content overflows the budget it is shed in a fixed order: pending phases beyond the first two collapse into a `… +N more phases` line, completed phases beyond the most recent two collapse into a `… +N earlier phases` line, then agent rows under the running phase shrink (down to two), then logs. The header and the running phase line are never dropped. Use the `/workflow` inspector for per-agent detail on any phase, including completed ones.

## Examples

### Example 1: Fan-out review

Three agents review different aspects, results synthesized. The most common workflow shape.

```js
export const meta = { name: 'review_modules', description: 'Multi-perspective module review' }

phase('Scan')
const inventory = await agent('List all source modules, their purpose, and key exports.', {
  label: 'repo scan',
  model: 'provider/light-model',
})

phase('Review')
const ref = handoff(inventory)
const aspects = ['error handling', 'test coverage', 'API consistency']
const reviews = await parallel(aspects.map(aspect => () =>
  agent(`Review the codebase for ${aspect}. Repo context:\n${ref}`, {
    label: `review ${aspect}`,
    model: 'provider/medium-model',
  })
))

phase('Synthesize')
const valid = reviews.filter(Boolean)
const allRef = handoff(valid)
return await agent(`Synthesize these reviews into actionable findings:\n${allRef}`, {
  label: 'synthesis',
  model: 'provider/heavy-model',
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
  { label: 'architect', mailbox: true, tools: ['read', 'find', 'write'], model: 'provider/heavy-model' }
)

const tester = spawn(
  `You are the test agent. Wait for the architect to send you the interface contract.
   Write tests based on the contract to tests/preferences/. When the implementer notifies
   you, run the tests and report red/green results.`,
  { label: 'tester', mailbox: true, tools: ['read', 'write', 'bash'], model: 'provider/medium-model' }
)

const implementer = spawn(
  `You are the implementation agent. Wait for the architect contract via mailbox.
   Implement the preferences API in src/api/preferences/ and src/db/preferences/.
   When done, notify the tester via mailbox_send.`,
  { label: 'implementer', mailbox: true, tools: ['read', 'write', 'edit'], model: 'provider/medium-model' }
)

const qa = spawn(
  `Review the architect's design for gaps, then review the implementation for correctness.
   Check code quality and consistency. You own no files — read only.`,
  { label: 'qa reviewer', mailbox: true, tools: ['read', 'grep', 'find'], model: 'provider/heavy-model' }
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
  model: 'provider/medium-model',
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
  model: 'provider/heavy-model',
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
        model: 'provider/medium-model',
      })
      return { mod, result }
    },
    // Stage 2: Validate (gate)
    async ({ mod, result }) => {
      const validation = await agent(
        `Run tests for ${mod.name}: cd ${mod.tests} && npm test. Fix any failures. You own ${mod.dir} and ${mod.tests}.`, {
        label: `validate ${mod.name}`,
        tools: ['read', 'edit', 'bash'],
        model: 'provider/medium-model',
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
  model: 'provider/heavy-model',
  role: 'package:critic',
  thinkingLevel: 'high',
})
```

## Detailed documentation

### [Workflow API Reference](docs/workflow-api.md)

Full reference for all globals, agent/spawn options, and runtime behavior.

**Read this when:** using `pipeline()`, `schema`, `retry`, `timeoutSeconds`, `role`, runtime `policy`, `budget`, or `handoff()` with custom `inlineLimit`. Also covers the determinism rules, meta format, and structured output contract.

**Keywords:** pipeline stages, JSON Schema, structured_output, retry backoff, timeout, reusable roles (package:reviewer, package:critic, package:planner, package:synthesizer, package:scout, package:worker), policy maxConcurrency, defaultTools, projectRoles, token budget, handoff inlineLimit, meta.phases, determinism sandbox.

### [Phase Registration DSL](docs/register-phase-dsl.md)

Top-level phase declarations with automatic data flow, gate/retry semantics, and the phase status lifecycle.

**Read this when:** using `registerPhase()`, `gate`, `maxIterations`, or `skipIf`, or when you care about how phases appear in the live progress view (pending outline, skipped/exhausted markers).

**Keywords:** registerPhase, phase status, pending, running, done, skipped, exhausted, gate, maxIterations, skipIf, onPhaseOutcome, phase outline, bounded progress.

### [Workflow Authoring Patterns](docs/authoring-patterns.md)

The barrier rule for choosing `parallel()` vs `pipeline()`, and the quality-pattern catalog: adversarial verify, perspective-diverse verify, judge panel, loop-until-dry, budget-scaled fan-out, multi-modal sweep, completeness critic, no silent caps, and composing them with gates.

**Read this when:** deciding between `parallel()` and `pipeline()`, verifying findings adversarially before reporting them, discovering unknown-size work (bugs, edge cases, coverage gaps), scaling fan-out to a token budget, or bounding coverage without hiding what was dropped.

**Keywords:** barrier rule, pipeline vs parallel, wall clock, adversarial verify, skeptic, refuter, verdict schema, judge panel, lens, loop-until-dry, seen-set, budget scaling, fleet size, multi-modal sweep, completeness critic, silent caps, coverage log, tournament, self-repair.

### [Team Composition & Mailbox](docs/teams.md)

How to plan and coordinate teams of communicating agents using `spawn()` and the mailbox system.

**Read this when:** building workflows where agents need to communicate, coordinate on shared work, wait for each other, or operate as a team with directed message passing. Also covers when to use `spawn()` vs `agent()`, file ownership planning, and prompt templates for team members.

**Keywords:** spawn, mailbox, mailbox.connect, mailbox.allow, mailbox.send, mailbox_peers, mailbox_send, mailbox_pause, team composition, architect pattern, worker pattern, file ownership, directed channels, pause/resume, transcript debugging, communicating agents, TDD team, competing hypotheses.

### [Side-Effectful Workflows](docs/side-effects.md)

File ownership rules, validation gates, and patterns for workflows that edit code.

**Read this when:** writing workflows where agents use `edit`, `write`, or `bash` to modify files. Covers how to define non-overlapping file ownership, when to serialize vs parallelize lanes, and how to add validation gates (lint, typecheck, test) before reporting completion.

**Keywords:** file ownership, non-overlapping directories, validation gate, lint, typecheck, test suite, implementation lanes, side effects, edit, write, bash, tools allowlist, serialize dependencies, repair failures, progress reporting.
