# pi-dynamic-workflows

A pi extension that adds a `workflow` tool for orchestrating multiple subagents in JavaScript workflow scripts. Workflow scripts use `agent()`, `spawn()`, `parallel()`, and `pipeline()` to coordinate subagents with fan-out, mailbox communication, and validation gates.

## Language

**Workflow**:
A JavaScript script that orchestrates multiple subagents, executed by the `workflow` tool.
_Avoid_: workflow run, orchestration

**Subagent**:
An agent spawned within a workflow via `agent()` (awaited) or `spawn()` (handle-returning). Subagents receive their own tools and can communicate via mailbox.
_Avoid_: child agent, worker, task

**Model**:
An explicit model-id string for a subagent call (e.g. `deepseek-v4-flash`). Matched to task complexity. Combined with `thinkingLevel` for effort control.
_Avoid_: weight, stream, tier, routing

**Mailbox**:
A communication channel between spawned subagents. Exposed to subagents as `mailbox_peers`, `mailbox_send`, and `mailbox_pause` tools. The workflow supervisor configures channels via `mailbox.allow()`, `mailbox.connect()`, and `mailbox.send()`.
_Avoid_: messaging, pipe, channel

**Team**:
A set of subagents communicating via mailbox, coordinated by the workflow supervisor.
_Avoid_: group

**Handoff**:
Serialized data passed between workflow stages. A synchronous function (no await) that returns a string — either the value inline (under ~100KB) or a temp-file path. Used to pass upstream results to downstream subagents.
_Avoid_: pass, transfer, share

**Phase**:
A labelled progress section in a workflow. Set via `phase(title)`. Drives live UI grouping of subagents.
_Avoid_: step, stage

**Lane**:
A parallel branch of work — one function in a `parallel()` call. Each lane runs concurrently.
_Avoid_: branch, thread, fork

**Policy**:
A frozen runtime policy object exposed to workflow scripts. Controls `defaultTools`, `maxConcurrency`, `projectRoles`, and `hardAbortGraceMs`.
_Avoid_: config, settings

## Architecture Decisions

Documented in [docs/adr/](docs/adr/):

- [0001: Runtime policy and weight-based model routing](docs/adr/0001-runtime-policy-and-stream-routing.md)
- [0002: Communicating workflow agents with runtime mailboxes](docs/adr/0002-communicating-workflow-agents.md)
- [0003: Side-effectful workflows require ownership and validation guidance](docs/adr/0003-side-effectful-workflow-validation.md)