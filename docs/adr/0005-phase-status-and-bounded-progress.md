# 0005: Phase status and bounded progress rendering

## Status

Accepted

## Context

Two user-facing warts in the live workflow UI:

1. **Phases were revealed one at a time.** `WorkflowSnapshot.phases` was a plain `string[]` of titles that grew as phases started, so the user only ever saw work that had already begun. Even for workflows whose full shape is known before the first subagent runs (`registerPhase()` declarations, or a `meta.phases` outline), the UI hid the plan until each phase was already underway. Users watching a long workflow had no sense of what was still coming — unlike dynamic workflows in Claude Code, which show the full outline up front and let the user watch it fill in.

2. **Progress rendering grew unboundedly.** The inline renderer emitted roughly 5-6 lines per phase (a phase line plus agent rows beneath it), so a ten-phase workflow with fan-out could consume 50+ lines of the editor area. Nothing capped the display for large workflows.

Additionally, phases had no recorded outcome: a gate-exhausted phase and a cleanly finished phase looked identical in the compact view, and hosts embedding the runtime had no callback to observe phase completion (only phase starts).

## Decision

**Phase snapshots carry status.** `WorkflowSnapshot.phases` changes from `string[]` to `WorkflowPhaseSnapshot[]` (`{ title, status }`), where `WorkflowPhaseStatus` is `'pending' | 'running' | 'done' | 'skipped' | 'exhausted'`. Completed phases render as exactly one summary line each (`✓` done, `-` skipped, `⚠` exhausted); the interactive `/workflow` inspector remains the surface for per-agent detail on completed phases.

**The full outline is visible before it runs.** `createWorkflowSnapshot(meta)` seeds phases from `meta.phases` as pending entries. The runtime fires `onPhaseRegistered` for `meta.phases` titles before the sandboxed script body runs, then for `registerPhase()` titles before the first phase executes — deduplicated, so a title announced from `meta.phases` is not announced again. Pending phases render with a distinct marker (`○`) so users see the whole plan up front, like Claude Code's dynamic workflows.

**Phase outcomes are observable.** `WorkflowRunOptions` gains `onPhaseOutcome(title, status)`, fired after each phase finishes: `skipIf` triggered → `'skipped'`, gate iterations exhausted → `'exhausted'`, normal completion (including a gate that passed) → `'done'`. Existing `onPhase` and `onPhaseRegistered` behavior is unchanged, and `WorkflowRunResult.phases` stays `string[]`.

**Progress rendering is bounded.** `WorkflowDisplayOptions` gains `maxLines` (default 20); `renderWorkflowLines` never returns more than `maxLines` lines for any input size. Within the budget: the header, one summary line per completed phase, the running phase with up to `maxAgents` agent rows, one line per pending phase, and the last `maxLogs` log lines. When content overflows, it is shed in a fixed order until it fits: pending phases beyond the first two (collapsed into a `… +N more phases` line), completed phases beyond the most recent two (collapsed into a `… +N earlier phases` line), agent rows under the running phase down to two, then logs. The header and the running phase line are never dropped.

**The inspector shows pending phases.** The `/workflow` inspector renders pending phases as selectable phase rows (using the snapshot status for the icon) instead of hiding phases that have not started, while preserving its viewport-safety behavior.

## Consequences

- **Positive:** users see the complete phase outline as soon as the workflow starts and can watch pending phases light up in order — progress reads as a plan being executed rather than a log being appended.
- **Positive:** the inline display has a hard ceiling regardless of workflow size; large fan-out workflows no longer crowd the editor.
- **Positive:** gate exhaustion and skips are visible at a glance (`⚠` / `-`), and hosts can react to phase outcomes via `onPhaseOutcome` instead of polling snapshots.
- **Negative (breaking):** `WorkflowSnapshot.phases` changes shape from `string[]` to `WorkflowPhaseSnapshot[]`; every consumer that treated phases as plain strings (renderers, tool details, tests) must read `.title` / `.status`. For TypeScript consumers this is a compile-time break, which is preferred over a silent behavioral change.
- **Trade-off:** completed phases lose their inline per-agent rows. This is acceptable because the compact view is for orientation and the inspector is the detail surface; the line budget depends on this collapse.
- **Trade-off:** when the budget is tight, pending phases beyond the first two are collapsed, so the tail of a very large outline may be elided inline. The next phases to run are prioritized over the distant tail, and the inspector always shows the full outline.
