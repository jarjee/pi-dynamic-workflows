# pi-dynamic-workflows Contributor Guide

## Purpose

`pi-dynamic-workflows` is a TypeScript/ESM Pi extension and library for deterministic, multi-subagent workflows. It provides the workflow DSL/runtime, in-memory subagent runner, mailbox coordination, structured output, policy/role handling, compact progress displays, and the `/workflow` inspector.

Use the project vocabulary from `CONTEXT.md` consistently:

| Prefer | Meaning | Avoid |
| --- | --- | --- |
| **Workflow** | JavaScript script that coordinates subagents | orchestration, workflow run |
| **Subagent** | Agent started by `agent()` or `spawn()` | child agent, worker, task |
| **Model** | Explicit `provider/model-id`, optionally with `thinkingLevel` | weight, stream, tier |
| **Mailbox** | Directed subagent communication | messaging, pipe, channel |
| **Team** | Mailbox-connected subagents | group |
| **Handoff** | Synchronous serialized data passed within a phase | pass, transfer, share |
| **Phase** | Top-level `registerPhase()` work unit | step, stage |
| **Lane** | One `parallel()` branch | branch, thread, fork |
| **Policy** | Frozen runtime limits/defaults | config, settings |

## Repository map

```text
src/
  index.ts                 Public API barrel only; keep implementation elsewhere.
  workflow.ts              AST validation and sandboxed workflow runtime.
  workflow-tool.ts         Pi tool definition, LLM prompt guidance, abort/recovery.
  agent.ts                 In-memory WorkflowAgent runner.
  structured-output.ts     Terminating structured-output tool.
  active-workflow.ts       Live workflow pub/sub state.
  display.ts               Snapshot, text, widget, and tool-update renderers.
  workflow-inspector.ts    Interactive `/workflow` TUI inspector.
  policy.ts, roles.ts      Runtime policy and reusable-role resolution.
  validators.ts            Shared typed validators; error text is semi-public.
  paths.ts                 Package-root path constants.

extensions/                Pi extension entrypoints.
types/workflow.d.ts        Ambient globals for reusable workflow scripts.
agents/                    Bundled `package:` role prompts.
tests/                     `node:test` unit/integration tests.
docs/                      API, workflow, side-effect, team, and ADR documentation.
evals/                     Real-Pi end-to-end workflow evaluations.
dist/                      Generated TypeScript output; never edit by hand.
```

## Build, test, and validation

Use Node 22 and npm. The normal local gate is:

```bash
npm install
npm test                    # biome check -> tsc -> all tests
```

Use focused tests during iteration, then run the full gate before completion:

```bash
npm run check               # biome check .
npm run lint                # biome lint .
npm run format              # biome format --write .
npm run build               # tsc
npm run test:unit           # tsx --test tests/**/*.test.ts
npx tsx --test tests/workflow-parser.test.ts
npx tsx --test tests/workflow-runtime.test.ts
npx tsx --test tests/workflow-tool.test.ts
npx tsx --test tests/workflow-display.test.ts
npx tsx --test tests/workflow-inspector.test.ts
```

Select tests by seam:

- Parser/sandbox/meta validation: `workflow-parser.test.ts`
- `agent`, `spawn`, mailbox, phases, retry/gate, recovery, abort: `workflow-runtime.test.ts`
- Tool schema, prompt guidance, lifecycle, policy: `workflow-tool.test.ts`
- Compact progress and snapshots: `workflow-display.test.ts`
- `/workflow` rendering, keyboard handling, selection, and terminal sizing: `workflow-inspector.test.ts`

`evals/run.sh` runs real Pi sessions and model-judged end-to-end evals. It needs configured model refs/environment and is separate from the normal unit-test gate. Use it when changing LLM-facing workflow behavior, not for ordinary local iteration.

## Code conventions

- Strict TypeScript, ES2022, and NodeNext/ESM. Prefer `import type` for type-only imports.
- Biome enforces 2-space indentation, double quotes, semicolons, trailing commas, and a 120-column line width.
- Keep `src/index.ts` a pure barrel; do not add runtime behavior there.
- Put shared type guards/validators in `src/validators.ts`; preserve validator error shapes unless tests and callers are deliberately updated.
- Use `src/paths.ts` for package-relative paths instead of ad hoc path calculations.
- Do not edit `dist/`, `node_modules/`, `evals/results/`, or lockfile-generated artifacts manually.

## Workflow DSL rules

Read `DOCS.md` before authoring workflow scripts. Read `docs/workflow-api.md` for detailed API semantics.

- The first statement is a literal `export const meta = { name, description }`.
- Register all top-level `registerPhase()` calls synchronously before any top-level `await`.
- Cross-phase data flows through the previous phase return value. Use `handoff()` only **within** a phase after awaiting the upstream result; `handoff()` itself is synchronous.
- Workflow scripts must be deterministic: no `Date.now()`, `new Date()`, `Math.random()`, `require`, `import`, filesystem/network APIs, or direct coding tools.
- Use explicit `provider/model-id` refs. Do not reintroduce legacy weight/stream routing.
- `parallel()` accepts independent lanes only; failed branches become `null`, so filter/handle them before synthesis.
- Side-effectful parallel lanes must have explicit, non-overlapping file ownership. Otherwise serialize them.
- Side-effectful workflows end with a validation gate that runs the relevant formatter, typecheck, and tests.
- Ensure every spawned handle settles before the workflow returns.

When changing workflow semantics, keep these aligned: `DOCS.md`, `docs/workflow-api.md`, related specialized docs/ADRs, `src/workflow-tool.ts` LLM prompt guidance, ambient declarations, and parser/runtime tests.

## Pi TUI guidelines

### Choose the least fragile surface

1. Use `ctx.ui.setStatus()` for a short persistent status indicator.
2. Use `ctx.ui.setWidget()` for compact, live, non-interactive progress.
3. Use normal `ctx.ui.custom()` for a detailed interactive view such as `/workflow`; it temporarily replaces the editor and returns it on close.
4. Treat `{ overlay: true }` as experimental. **Do not use an overlay for a view that updates while the transcript or tool output is streaming.** The workflow inspector deliberately uses non-overlay custom UI because transcript compositing caused redraw artifacts.

### Custom component requirements

- `render(width)` must return lines whose ANSI-aware `visibleWidth()` never exceeds `width`.
- Use `truncateToWidth()` for every dynamic row, including borders/help text.
- Make layout terminal-height-aware when it has a bounded viewport. The inspector reads `tui.terminal.rows`, caps its height, and reduces visible rows instead of rendering past the viewport.
- Call `tui.requestRender()` after input-driven or subscription-driven state changes.
- Use `matchesKey()` for raw keys and the injected `keybindings.matches()` for configurable application bindings.
- Keep live-update subscriptions/listeners paired with cleanup in `dispose()`.
- Preserve selection when live data changes; clamp it if rows disappear.
- Use the supplied theme in components that add styling. Do not bake a global theme into cached strings; invalidate/rebuild themed caches on theme changes.

### UI test requirements

For changes to `workflow-inspector.ts` or display renderers, add/update targeted tests for the affected behavior:

- Render width bounds: `visibleWidth(line) <= width`
- Render height bounds for constrained terminals
- Long labels, descriptions, logs, and result previews
- Keyboard navigation and configured bindings
- Collapse/expand, selection clamping, page/home/end behavior where applicable
- Live workflow updates and listener cleanup

The inspector test suite intentionally exercises a 40-agent workflow and a matrix of narrow widths/heights. Preserve or extend those cases rather than replacing them with only happy-path snapshots.

## Documentation and architecture

- `CONTEXT.md`: controlled vocabulary and ADR index.
- `DOCS.md`: canonical workflow authoring guide.
- `docs/workflow-api.md`: full DSL/API behavior.
- `docs/teams.md`: mailbox/team patterns.
- `docs/side-effects.md`: ownership and validation requirements.
- `docs/register-phase-dsl.md`: phase/gate/retry semantics.
- `docs/authoring-patterns.md`: composition patterns (pipeline vs parallel barriers, adversarial verify, judge panel, loop-until-dry, budget scaling).
- `docs/adr/`: decisions. Keep superseded ADRs with their rationale; new decisions use numbered markdown files and include Status, Context, Decision, and Consequences.
- `agents/*.md`: bundled role behavior. Role frontmatter documents intent; actual tool access is enforced by the `agent()` call.

Before finalizing a source change, run the focused tests and `npm test`. For DSL, documentation, or LLM prompt changes, verify that source, tests, prompt guidance, and docs all tell the same story.
