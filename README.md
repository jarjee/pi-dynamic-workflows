# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, adversarial claim checking, repeatable quality gates, and fan-out research. Workflows are best when the task can be split into independent streams with clear scope, deliverables, and — for side-effectful work — non-overlapping file ownership.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Install

```bash
pi install npm:pi-dynamic-workflows
# or from a local checkout
pi install /path/to/pi-dynamic-workflows
```

Then in Pi:

```text
/reload
```

That's it. The extension registers a `workflow` tool and activates it on session start.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Press `Esc` to cancel a running workflow. Active subagents are aborted immediately; after a short grace period the runtime disposes any still-active in-memory sessions so stuck work does not keep running in the background.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata. `name` and `description` are required; `phases` is optional documentation for an expected outline. The live progress view is driven by `phase(...)` calls at runtime:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. If a branch is skipped, its phase does not show up as an empty progress row.

### Editor IntelliSense

Reusable workflow files can opt into editor hints for workflow globals:

```js
/// <reference types="pi-dynamic-workflows/workflow" />
```

This declares `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, and `budget` for TypeScript-aware editors.

### Available globals

| Global | Description |
| --- | --- |
| `spawn(prompt, opts)` | Start an isolated subagent and return a handle `{ id, label, status(), result }` immediately. Use for mailbox communication and status tracking. |
| `agent(prompt, opts)` | Spawn an isolated subagent and await its result. Returns final text or, with `opts.schema`, a validated object. `opts.tools` can allowlist built-in coding tools. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. |
| `handoff(value, opts)` | Return small values inline, or write large values to a mode-0600 temp artifact and return read instructions. |
| `mailbox` | Supervisor mailbox API for spawned communicating agents: `allow`, `connect`, and `send`. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `policy` | Runtime-enforced workflow policy selected by the host/tool call. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

### Determinism rules

Workflow scripts are evaluated inside a Node `vm` sandbox. The following are intentionally unavailable:

- `Date.now()`, `new Date()`
- `Math.random()`
- `require`, `import`, `fs`, network APIs
- spreads, computed keys, template interpolation, function calls inside `meta`

This keeps `meta` parseable, runs reproducible, and the surface area small.

### Workflow fit and composition

Before using a workflow, gate whether the task has real independent streams of work. Good fits include broad audits, multi-perspective review, debugging with competing hypotheses, research across alternatives, migrations with separable file sets, and repeatable quality gates. Poor fits include small one-step tasks, mostly sequential work, tightly coupled edits, and tasks likely to need user input midway.

For side-effectful implementation workflows, make each lane's file or directory ownership explicit and non-overlapping. If ownership overlaps, serialize those lanes or add dependencies rather than running them in parallel. Good subagent prompts include mission, concrete tasks, scope/out-of-scope, dependencies, quality standards, and expected deliverable shape.

Side-effectful workflows should end with an explicit validation gate: run the formatter/linter/typecheck/tests that are appropriate for the project, repair failures, and only then report completion. Keep workflow progress and final summaries user-facing: describe concrete actions, evidence, failures, and next steps rather than scratchpad notes.

### Runtime policy

The `workflow` tool accepts an optional host-enforced `policy` object:

```json
{
  "policy": {
    "defaultTools": ["read", "grep", "find", "ls"],
    "maxConcurrency": 4,
    "hardAbortGraceMs": 2000,
    "projectRoles": "deny",
    "modelsByStream": {
      "light": "provider/light-model",
      "medium": "provider/code-model",
      "heavy": "provider/frontier-model"
    }
  }
}
```

Workflow scripts can read the frozen `policy` global, but enforcement happens in the runtime. Script-level requests such as `agent(..., { tools })` can narrow or request capabilities; the host policy controls defaults and trust gates.

### Communicating workflow agents

Use `spawn()` instead of `agent()` when the workflow needs handles, status, or directed mailbox communication:

```js
const architect = spawn('Define the API contract.', {
  label: 'architect',
  mailbox: true,
})

const worker = spawn('Implement once the contract is ready.', {
  label: 'worker',
  mailbox: true,
})

mailbox.connect(architect.id, worker.id)
await mailbox.send(worker.id, 'Wait for the architect contract before editing.')

const [contract, implementation] = await parallel([
  () => architect.result,
  () => worker.result,
])
```

Mailbox-enabled agents receive `mailbox_peers`, `mailbox_send`, and `mailbox_pause` tools plus an identity/protocol prompt. Messages are automatically injected into the receiver's next/resume turn and are framed as peer/supervisor communication, not system instructions. If any spawned agent is still running or paused when the workflow returns, the workflow fails with a leak report and cleans up active agents.

When mailbox is used, the runtime writes a full JSONL transcript artifact and returns its path in workflow details.

### Subagent tool allowlists

By default, subagents receive the read-only coding tools `read`, `grep`, `find`, and `ls`. Use `opts.tools` to request an explicit built-in tool allowlist for a specific subagent:

```js
const review = await agent('Review the docs without editing.', {
  label: 'docs review',
  tools: ['read', 'grep', 'find', 'ls'],
})

const summary = await agent('Summarize the prior findings only.', {
  label: 'summary',
  tools: [],
})
```

Side-effectful tools such as `bash`, `edit`, and `write` must be requested explicitly. Unknown tool names fail closed before the subagent launches.

### Reusable subagent roles

Use `opts.role` to prepend a source-qualified reusable role prompt to a subagent:

```js
const review = await agent('Review the public API for compatibility risk.', {
  label: 'api review',
  role: 'package:reviewer',
  tools: ['read', 'grep', 'find', 'ls'],
})
```

Bundled package roles include `package:reviewer`, `package:critic`, `package:scout`, `package:planner`, `package:synthesizer`, and `package:worker`. Project roles are repository-controlled and denied by default; hosts must opt in with `roles.projectRoles: 'allow'`.

Extension tool grants and caller skill inheritance are intentionally not ambient. `extensionTools` and `callerSkills` are reserved for future explicit grant plumbing and currently fail closed if requested.

### Large handoff artifacts

Use `handoff(value, { inlineLimit })` when passing potentially large upstream results into later prompts. Small values are returned unchanged; larger values are written to a temporary mode-0600 file and replaced with instructions containing the file path.

```js
const map = await agent('Map the repository.', { label: 'repo map' })
const mapRef = await handoff(map, { inlineLimit: 100_000 })
const review = await agent('Review using this map:\n' + mapRef, {
  label: 'review',
  tools: ['read', 'grep', 'find', 'ls'],
})
```

### Per-agent model selection and stream

Use `opts.model` with a `provider/model-id` ref to run a specific subagent on a different configured model, or use `opts.stream` to let runtime policy choose the model:

```js
const summary = await agent('Summarize this subsystem.', {
  label: 'cheap summary',
  stream: 'light',
})

const critique = await agent('Deeply critique the proposed architecture.', {
  label: 'deep critique',
  stream: 'heavy',
  role: 'package:critic',
})
```

Use a light stream for cheap summarization/classification across many items, a medium stream for normal code generation and review, and a heavy stream for architecture, final synthesis, adversarial critique, and quality gates. Explicit model refs must exist in the active Pi model registry; unknown refs fail before the subagent launches.

`stream` chooses the class of work/model routing. `thinkingLevel` is separate and controls model thinking effort when the selected model supports it:

```js
const review = await agent('Review the migration plan carefully.', {
  label: 'careful review',
  stream: 'heavy',
  thinkingLevel: 'high',
})
```

### Subagent timeout and retry

Use `timeoutSeconds` to cap each subagent attempt, and `retry` to retry failures before `agent()` returns `null`:

```js
const result = await agent('Run a flaky inspection.', {
  label: 'flaky inspection',
  tools: ['read', 'bash'],
  timeoutSeconds: 900,
  retry: { attempts: 3, delayMs: 1000, backoff: 'exponential' },
})
```

`retry.attempts` includes the first attempt. Failed intermediate attempts are logged; if all attempts fail, the branch returns `null` unless the whole workflow was aborted.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under the hood this is a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call without an extra assistant turn.

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses + runs script in a vm sandbox
  → script calls agent(), parallel(), pipeline()
  → each agent() spawns an in-memory Pi subagent session
  → snapshots stream back as compact progress
  → final structured result returned to the parent assistant
```

Subagents run in fresh in-memory Pi sessions with the standard coding tools, so they can read files, run shell commands, and call structured output exactly like a normal Pi turn.

## Library modules

| File | Purpose |
| --- | --- |
| `src/workflow.ts` | AST-validated parser and sandboxed workflow runtime. |
| `src/workflow-tool.ts` | The Pi `workflow` tool, prompt guidelines, rendering, abort handling. |
| `src/agent.ts` | `WorkflowAgent`, an in-memory Pi subagent runner. |
| `src/structured-output.ts` | Terminating structured-output tool backed by TypeBox/JSON Schema. |
| `src/display.ts` | Workflow snapshots and compact text renderers. |
| `extensions/workflow.ts` | The Pi extension entrypoint. |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run dev
```

Parser unit tests live in `tests/workflow-parser.test.ts` and cover both accepted and rejected script shapes.

## Status

This is a prototype. It implements the core workflow primitive (script, subagents, parallel/pipeline, phases, abort, structured output) but does not yet implement persisted or resumable runs, or a `/workflows` manager.

## License

MIT
