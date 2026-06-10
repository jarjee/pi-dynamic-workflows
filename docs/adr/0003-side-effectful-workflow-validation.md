# 0003: Side-effectful workflows require ownership and validation guidance

## Status

Accepted

## Context

Workflows can coordinate many subagents and can edit files when agents receive side-effectful tools. Parallel edits create coordination risk: overlapping file ownership can cause conflicts, and generated workflows can prematurely report success before formatting, linting, typechecking, or tests pass.

A session review showed repeated validation failures after implementation steps and visible progress text exposing scratchpad-style notes rather than user-facing status.

## Decision

Workflow guidance must require side-effectful workflows to define explicit non-overlapping file or directory ownership for parallel write-capable lanes. If ownership overlaps, lanes should be serialized or have explicit dependencies.

Side-effectful workflows should include a final validation gate that runs the appropriate formatter, linter, typecheck, and tests for the project. Validation failures should be repaired before final synthesis or completion claims, unless the user explicitly asks to skip validation.

Workflow progress and summaries should be user-facing: report concrete actions, evidence, validation failures, fixes, and next steps rather than scratchpad notes.

## Consequences

- Generated workflows are less likely to create parallel edit conflicts.
- Workflows are less likely to claim completion while checks are failing.
- Workflow prompts become more prescriptive for side-effectful work.
- Some small implementation tasks may be better handled directly instead of incurring workflow coordination overhead.
