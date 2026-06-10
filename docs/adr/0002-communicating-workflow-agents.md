# 0002: Communicating workflow agents with runtime mailboxes

## Status

Accepted

## Context

Dynamic workflows originally supported independent subagents through `agent()`, `parallel()`, and `pipeline()`. Some tasks need a stronger "team" shape: agents should be able to ask each other questions, pause while blocked, and resume when another agent or the workflow supervisor provides information.

This communication cannot be modeled purely in workflow script control flow because messages must be agent-dynamic. Agents need tools inside their own sessions. At the same time, global discovery and unrestricted messaging would make workflows harder to review and reason about.

## Decision

Add `spawn()` as the handle-returning primitive and keep `agent()` as sugar for awaiting a spawned result.

A spawned handle exposes:

- `id`
- `label`
- `status()`
- `result`

Mailbox-enabled agents receive runtime-injected tools:

- `mailbox_peers`
- `mailbox_send`
- `mailbox_pause`

The workflow supervisor configures directed channels dynamically:

- `mailbox.allow(fromId, toId)` for one-way permission
- `mailbox.connect(aId, bId)` for bidirectional permission
- `mailbox.send(toId, message)` for supervisor-originated messages

Mailbox messages are automatically injected into the receiving agent's next or resumed turn. Message blocks identify both sender id and label and explicitly state that mailbox content is peer/supervisor communication, not system instruction.

Paused agents keep their `result` promise pending. They resume on mailbox message or pause timeout. Public spawned handles that are still running or paused when the workflow returns cause a workflow error and cleanup.

## Consequences

- Workflow scripts can coordinate communicating agents without changing `agent()`'s simple awaited behavior.
- Agents communicate through scoped capabilities rather than a global registry.
- Dynamic channel wiring avoids creation-order problems while preserving explicit permissions.
- Mailbox transcripts can support debugging and possible future resumability.
- The runtime becomes more complex because it must manage agent lifecycle, pause/resume, mailbox injection, and leak detection.
