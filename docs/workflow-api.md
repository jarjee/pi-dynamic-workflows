# Workflow API Reference

Full reference for all workflow globals, agent options, and runtime behavior. For a quick introduction and examples, see [DOCS.md](../DOCS.md).

## Script format

### Meta export

The first statement must be a literal `export const meta`:

```js
export const meta = {
  name: 'short_snake_case',       // required
  description: 'What this does',  // required
  phases: [                       // optional — static documentation only
    { title: 'Scan' },
    { title: 'Review' },
  ],
}
```

`meta.phases` is optional documentation for expected phases. Live progress is driven by `phase()` calls at runtime, not by `meta.phases`. Most workflows should omit `meta.phases` and call `phase()` as work starts — this way conditional or loop-created phases appear naturally and skipped branches don't show as empty rows.

### Determinism rules

Workflow scripts run in a Node.js `vm` sandbox. The following are intentionally unavailable:

- `Date.now()`, `new Date()`, `Math.random()`
- `require`, `import`, `fs`, network APIs
- Direct file tools (`read()`, `grep()`, `find()`, `ls()`, `bash()`) — delegate to subagents via their `tools` option
- Spread, computed keys, template interpolation, and function calls inside `meta`

Standard JS control flow (`if`, `for`, `while`, `try/catch`), `async/await`, `Promise`, and all collection types (`Array`, `Object`, `Map`, `Set`) are available.

## Globals reference

### agent(prompt, opts)

Spawn an isolated subagent and await its result. Returns the final assistant text, or a validated object when `opts.schema` is provided. Returns `null` on failure (does not throw).

```js
const result = await agent('Review the auth module for security issues.', {
  label: 'auth review',
  tools: ['read', 'grep', 'find', 'ls'],
  weight: 'medium',
})
```

### spawn(prompt, opts)

Start a subagent and return a handle immediately. Use when you need `id` (for mailbox wiring), `status()` checks, or non-blocking setup.

```js
const handle = spawn('Design the API contract.', {
  label: 'architect',
  mailbox: true,
  weight: 'heavy',
})
// handle.id, handle.label, handle.status(), handle.result (Promise)
```

**Important:** All spawned handles must reach a terminal state (`completed`, `failed`, `aborted`) before the workflow returns. Leaked running or paused handles cause a workflow error and cleanup.

### parallel(thunks)

Run an array of functions or promises concurrently. Results are returned in input order. Failed branches return `null`.

**Preferred:** pass functions (thunks) so `parallel` controls when work starts:

```js
const results = await parallel(items.map(item => () => agent(`Review ${item}`, { label: item })))
```

**Also accepted:** pass already-started promises directly. `parallel` will `await` each one:

```js
const results = await parallel(items.map(item => agent(`Review ${item}`, { label: item })))
```

**Either way, always filter nulls before downstream use:**

```js
const clean = results.filter(Boolean)
```

Results are returned in input order. Failed branches return `null`.

### pipeline(items, ...stages)

Run each item through sequential stages. Items fan out concurrently, but stages for each item run in order.

```js
const results = await pipeline(
  files,
  // Stage 1: analyze (receives the item)
  (prev, file, index) => agent(`Analyze ${file}`, { label: `analyze ${file}` }),
  // Stage 2: fix (receives stage 1 result, plus original item)
  (analysis, file, index) => agent(`Fix issues in ${file}: ${analysis}`, { label: `fix ${file}` }),
)
```

Each stage receives `(previousStageResult, originalItem, index)`. Failed items return `null`.

### handoff(value, opts)

Serialize a value for passing between agents. **Synchronous** — no `await` needed.

```js
const ref = handoff(largeUpstreamResult)
await agent(`Use this context:\n${ref}`, { label: 'downstream' })
```

Small values (≤ `inlineLimit`, default 100KB) are returned as inline text. Larger values are written to a mode-0600 temp file and replaced with read instructions containing the file path.

Options: `{ inlineLimit: 100000 }` — byte threshold for inline vs file.

`handoff(value)` is synchronous and returns a string. Do not await it; instead await upstream `agent()` or `spawn().result` values before handing them off. Template interpolation `${handoff(data)}` is safe.

### phase(title)

Mark the current progress phase. Drives the live UI grouping.

```js
phase('Scan')
// ... agents run here appear under "Scan"
phase('Review')
// ... agents run here appear under "Review"
```

Phases are discovered as the script runs. Conditional and loop-created phases work naturally.

### log(message)

Append a workflow-level log line. Visible in the progress display.

### mailbox

Supervisor API for wiring communication between spawned agents. See [teams docs](teams.md).

### budget

Token budget tracker: `{ total, spent(), remaining() }`. `total` is `null` when no budget is set. `remaining()` returns `Infinity` when unbounded.

### isUncatchable(error)

Check if an error is a workflow abort signal. Re-throw these from any `try/catch` in your workflow script:

```js
try { ... } catch (e) { if (isUncatchable(e)) throw e; /* handle */ }
```

## Agent options reference

| Option | Type | Description |
|--------|------|-------------|
| `label` | `string` | **Required.** Unique 2-5 word label for progress display and recovery. |
| `tools` | `string[]` | Built-in tool allowlist. Default: `['read', 'grep', 'find', 'ls']`. Use `[]` for no tools. Add `bash`, `edit`, `write` only for side effects. |
| `weight` | `'light' \| 'medium' \| 'heavy'` | Model-routing size. Light for cheap fan-out, medium for code work, heavy for synthesis/architecture. |
| `stream` | `'light' \| 'medium' \| 'heavy'` | Deprecated alias for `weight`; kept for existing workflow scripts. |
| `model` | `string` | Explicit `provider/model-id`. Overrides weight. Must exist in the Pi model registry. |
| `thinkingLevel` | `string` | Model thinking effort: `'off'`, `'minimal'`, `'low'`, `'medium'`, `'high'`, `'xhigh'`. |
| `role` | `string` | Source-qualified reusable role: `package:reviewer`, `package:critic`, `package:planner`, `package:synthesizer`, `package:scout`, `package:worker`. |
| `schema` | `object` | JSON Schema for structured output. Subagent must call `structured_output`. Returns validated object or `null`. |
| `retry` | `object` | `{ attempts, delayMs, backoff }`. `attempts` includes first try. `backoff`: `'constant'` or `'exponential'` (default). |
| `timeoutSeconds` | `number` | Per-attempt wall-clock timeout. |
| `mailbox` | `boolean \| object` | Enable mailbox tools. `true` or `{ peers: ['agent_1'] }`. Use with `spawn()`. |
| `phase` | `string` | Override the phase for this agent (defaults to current `phase()`). |

### Structured output

When `schema` is provided, the subagent receives a `structured_output` tool and is instructed to call it as its final action. The return value is a validated object matching your schema.

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    },
    required: ['paths', 'severity'],
  },
  retry: { attempts: 2 },
})
```

Use plain JSON Schema syntax, not TypeScript types or TypeBox. Add `retry` for important structured lanes since LLMs can fail to call the tool. Always check for `null`.

### Reusable roles

Bundled `package:` roles prepend a role prompt to the subagent:

| Role | Best for |
|------|----------|
| `package:reviewer` | Code review, API review, compatibility checks |
| `package:critic` | Adversarial review, challenging assumptions |
| `package:planner` | Architecture, migration planning, scope definition |
| `package:synthesizer` | Combining multi-agent results into findings |
| `package:scout` | Broad codebase reconnaissance |
| `package:worker` | Implementation tasks with clear scope |

Project roles (`project:name`) are denied by default. Enable via `policy.projectRoles: 'allow'`.

## Runtime policy

The `policy` parameter controls runtime defaults:

```js
{
  defaultTools: ['read', 'grep', 'find', 'ls'],  // default tool allowlist
  maxConcurrency: 4,                               // max parallel agents
  hardAbortGraceMs: 2000,                          // cleanup delay after abort
  projectRoles: 'deny',                            // 'deny' | 'allow'
  mailboxPauseTimeoutSeconds: 1800,                // mailbox pause timeout
  modelsByWeight: {
    light: 'provider/cheap-model',
    medium: 'provider/code-model',
    heavy: 'provider/frontier-model',
  },
}
```

Scripts read the frozen `policy` global but cannot override enforcement. Script-level `tools`, `weight`, and `model` requests narrow within policy bounds.

## Partial recovery

When a workflow fails (script error, not abort), the tool returns a recovery result instead of throwing. The recovery includes:

- Completed agent results written to a temp directory (one JSON file per agent)
- A manifest listing completed, failed, and running agents
- Workflow logs and phase state

You can write a new workflow that reads the recovery files to continue from where the previous one failed. Each recovery file contains `{ label, result }`.

## Editor IntelliSense

For reusable `.workflow.js` files:

```js
/// <reference types="pi-dynamic-workflows/workflow" />
```

Declares `agent`, `spawn`, `parallel`, `pipeline`, `handoff`, `phase`, `log`, `mailbox`, `args`, `cwd`, `budget`, `policy`, and `isUncatchable` for TypeScript-aware editors.
