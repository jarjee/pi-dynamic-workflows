# Side-Effectful Workflows

Patterns for workflows that edit code, run commands, or modify files. For basic workflow usage, see [DOCS.md](../DOCS.md). For team coordination, see [teams.md](teams.md).

## File ownership

When multiple agents can write files, each agent must own a non-overlapping set of files or directories. State this explicitly in the agent prompt.

```js
const results = await parallel([
  () => agent('Migrate the auth module. You own src/auth/ and tests/auth/.', {
    label: 'migrate auth',
    tools: ['read', 'edit', 'write'],
  }),
  () => agent('Migrate the billing module. You own src/billing/ and tests/billing/.', {
    label: 'migrate billing',
    tools: ['read', 'edit', 'write'],
  }),
])
```

### Rules

1. **Ownership must be explicit in the prompt.** Don't rely on agents inferring scope.
2. **Ownership must not overlap.** Two write-capable agents should never touch the same file.
3. **Read-only agents can read anything.** Only write access creates conflicts.
4. **Shared utilities need a single owner.** If a shared file needs changes, assign one agent to own it, or serialize the work.

### When ownership overlaps

If two work streams genuinely need the same file:

**Option A: Serialize.** Make one agent go first, then the other reads the updated file.

```js
// Agent 1 finishes first
const types = await agent('Update shared types in src/types/. You own src/types/.', {
  label: 'update types', tools: ['read', 'edit'],
})

// Agent 2 reads the updated types
await agent('Migrate auth using the updated types. You own src/auth/.', {
  label: 'migrate auth', tools: ['read', 'edit'],
})
```

**Option B: Architect pattern.** An architect owns the shared file, workers read it.

```js
const architect = spawn('Design and write shared types to src/types/. You own src/types/.', {
  label: 'architect', mailbox: true, tools: ['read', 'write'], stream: 'heavy',
})

const workers = modules.map(mod =>
  spawn(`Wait for architect. Migrate ${mod}. You own src/${mod}/.`, {
    label: `migrate ${mod}`, mailbox: true, tools: ['read', 'edit'],
  })
)

for (const w of workers) mailbox.connect(architect.id, w.id)
await parallel([() => architect.result, ...workers.map(w => () => w.result)])
```

**Option C: Pipeline stages.** Each stage owns the file exclusively for its turn.

```js
await pipeline(
  [sharedFile],
  (file) => agent(`Apply formatting changes to ${file}.`, { label: 'format', tools: ['read', 'edit'] }),
  (_, file) => agent(`Apply migration changes to ${file}.`, { label: 'migrate', tools: ['read', 'edit'] }),
)
```

## Validation gates

Side-effectful workflows should validate their work before reporting success. Add a validation agent at the end that runs the project's formatter, linter, type checker, and/or test suite.

### Simple gate

```js
phase('Validate')
const validation = await agent(
  'Run the linter, type checker, and test suite. Fix any failures. Report pass/fail.', {
  label: 'validate',
  tools: ['read', 'edit', 'bash'],
  stream: 'medium',
})
```

### Per-lane gates

For multi-lane implementations, validate each lane independently before final integration:

```js
phase('Implement')
const results = await parallel(modules.map(mod => () =>
  pipeline(
    [mod],
    // Stage 1: Implement
    async (mod) => agent(`Implement ${mod.name}. You own ${mod.dir}.`, {
      label: `impl ${mod.name}`, tools: ['read', 'edit', 'write'],
    }),
    // Stage 2: Validate (per-lane gate)
    async (_, mod) => agent(`Run tests for ${mod.name}: npm test -- ${mod.tests}. Fix failures.`, {
      label: `test ${mod.name}`, tools: ['read', 'edit', 'bash'],
    }),
  )
))

phase('Integration')
await agent('Run the full test suite. Fix integration failures.', {
  label: 'integration', tools: ['read', 'edit', 'bash'],
})
```

### Structured validation

Use `schema` for machine-readable validation results:

```js
const result = await agent('Run the test suite. Report results.', {
  label: 'validation gate',
  tools: ['bash', 'read'],
  schema: {
    type: 'object',
    properties: {
      passed: { type: 'boolean' },
      tests_run: { type: 'number' },
      failures: { type: 'array', items: { type: 'string' } },
      lint_clean: { type: 'boolean' },
      typecheck_clean: { type: 'boolean' },
    },
    required: ['passed', 'tests_run', 'failures'],
  },
  retry: { attempts: 2 },
})

if (result && !result.passed) {
  // Repair phase
  await agent(`Fix these failures: ${result.failures.join(', ')}`, {
    label: 'repair', tools: ['read', 'edit', 'bash'],
  })
}
```

## Multi-cycle workflow pattern

A full implementation workflow chains team cycles with gates:

```
fan-out (implement) → per-lane gate (test) → fan-in (collect)
  → fan-out (repair failures) → gate (re-test) → fan-in
  → final integration gate
```

```js
export const meta = { name: 'full_migration', description: 'Multi-cycle migration with gates' }

// Cycle 1: Plan
phase('Plan')
const plan = await agent('Create a migration plan.', {
  label: 'plan', stream: 'heavy', role: 'package:planner',
})

// Cycle 2: Implement + validate per module
phase('Implement')
const planRef = handoff(plan)
const results = await parallel(modules.map(mod => () =>
  pipeline(
    [mod],
    async (mod) => {
      await agent(`Implement migration for ${mod.name}. You own ${mod.dir}.\n${planRef}`, {
        label: `impl ${mod.name}`, tools: ['read', 'edit', 'write'], stream: 'medium',
      })
      return mod
    },
    async (mod) => {
      return await agent(`Test ${mod.name}: cd ${mod.dir} && npm test. Fix failures.`, {
        label: `test ${mod.name}`, tools: ['read', 'edit', 'bash'], stream: 'medium',
        schema: {
          type: 'object',
          properties: { module: { type: 'string' }, passed: { type: 'boolean' } },
          required: ['module', 'passed'],
        },
      })
    },
  )
))

// Cycle 3: Integration gate
phase('Integration')
const passed = results.filter(r => r && r.passed)
const failed = results.filter(r => r && !r.passed)

if (failed.length > 0) {
  log(`${failed.length} module(s) failed validation — repairing`)
  await parallel(failed.map(f => () =>
    agent(`Fix failures in ${f.module}. You own the module directory.`, {
      label: `repair ${f.module}`, tools: ['read', 'edit', 'bash'],
    })
  ))
}

return await agent('Run the full integration test suite. Report final status.', {
  label: 'final integration', tools: ['bash', 'read'], stream: 'heavy',
  role: 'package:critic',
})
```

## Progress reporting

Keep workflow progress user-facing:

- **Do:** "Migrated auth module (12 files changed, tests passing)"
- **Don't:** "Need biome" / "Run commit" / "Step 3 done"

Use `log()` for important status updates visible in the progress display. Use `phase()` to group work into meaningful stages.

## Tool allowlist reference

| Tools | Use case |
|-------|----------|
| `['read', 'grep', 'find', 'ls']` | Read-only review, analysis, scanning (default) |
| `['read', 'grep', 'find', 'ls', 'edit']` | Targeted file edits |
| `['read', 'grep', 'find', 'ls', 'edit', 'write']` | Create new files + edit existing |
| `['read', 'bash']` | Run tests, linters, build commands |
| `['read', 'edit', 'bash']` | Edit + run validation (repair cycles) |
| `['read', 'edit', 'write', 'bash']` | Full implementation + validation |
| `[]` | No tools (pure reasoning, synthesis from provided context) |
