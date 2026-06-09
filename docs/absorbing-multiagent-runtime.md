# Absorbing multi-agent runtime features

`pi-dynamic-workflows` should keep JavaScript workflow control flow as the orchestration language. The workflow script is intentionally ephemeral and model-authored, so dependencies should usually be expressed by ordinary values, `await`, `parallel(...)`, and `pipeline(...)` rather than a second explicit DAG DSL.

The runtime should absorb useful `pi-multiagent` safety and execution features around the `agent()` primitive:

- runtime-enforced tool allowlists;
- safer read-only defaults;
- per-agent timeout and retry;
- hard abort/cleanup for stuck runs;
- optional reusable roles/catalog prompts;
- later, carefully reviewed extension-tool and caller-skill grants.

## Design principles

1. **JS control flow is the DAG.** Avoid introducing a separate graph language until a concrete workflow cannot be represented clearly with ordinary JavaScript.
2. **Scripts request; runtime enforces.** A script can request tools, roles, models, and side effects, but host/runtime policy is authoritative.
3. **Default to read-only.** Subagents should not receive `bash`, `edit`, or `write` unless the workflow explicitly requests them and policy permits them.
4. **Prefer visible abortability over perfect sandboxing.** Workflows need clear progress, quick cancellation, hard cleanup, and honest reporting of what was running when stopped.
5. **No ambient power by accident.** Do not implicitly inherit extension tools, project-controlled prompts, skills, or broad coding tools.

## Absorbed features

### Runtime policy

Hosts can pass `policy` to `runWorkflow(...)` or the `workflow` tool. The normalized policy controls default tools, maximum concurrency, hard-abort grace, and project-role allowance. The workflow script can inspect the frozen `policy` global, but runtime enforcement does not trust script-authored values.

### Tool allowlists

`agent(prompt, { tools })` now accepts a built-in coding tool allowlist. If omitted, the runtime default is read-only:

```js
['read', 'grep', 'find', 'ls']
```

Use `tools: []` for a subagent with no coding tools. Unknown or unavailable names fail closed before launching the subagent.

### Hard abort cleanup

When a parent workflow abort signal fires, the runtime calls `abortAll()` on the active subagent runner immediately. After `hardAbortGraceMs` it calls `disposeAll()` so stuck in-memory sessions are cleaned up. The default grace period is 2000ms; extension hosts can override it through `createWorkflowTool({ hardAbortGraceMs })` or `runWorkflow({ hardAbortGraceMs })`.

### Reusable roles

`agent(prompt, { role })` prepends a source-qualified reusable role prompt such as `package:reviewer`. Bundled package roles cover reviewer, critic, scout, planner, synthesizer, and worker behavior. Project roles are repository-controlled and denied by default; hosts must opt in with `roles.projectRoles: 'allow'`.

### Per-agent model selection

`agent(prompt, { model: 'provider/model-id' })` resolves the ref through the active Pi model registry and passes the resolved model into the child in-memory session. Unknown refs fail before launch.

### Timeout and retry

`agent(prompt, { timeoutSeconds, retry })` caps each subagent attempt and retries failures before returning `null`:

```js
await agent('Run flaky inspection', {
  label: 'flaky inspection',
  timeoutSeconds: 900,
  retry: { attempts: 3, delayMs: 1000, backoff: 'exponential' },
})
```

`retry.attempts` includes the initial attempt. Workflow aborts still escape immediately rather than being treated as retryable branch failures.
