# ADR 0004: Resolve Conflicting `tools` Fields

## Status

Proposed

## Context

Three interfaces in `pi-dynamic-workflows` use a field named `tools`, but with incompatible types:

| Interface | Location | Type | Purpose |
|-----------|----------|------|---------|
| `WorkflowAgentOptions` | `src/agent.ts:20` | `ToolDefinition[]` | Custom tool definitions registered at constructor time; stored as `this.customTools` |
| `AgentOptions` | `src/workflow.ts:72` | `string[]` | Per-call built-in coding tool name allowlist (e.g. `["read", "grep"]`) |
| `AgentRunOptions` | `src/agent.ts:35` | `string[]` | Same allowlist concept, carried into `WorkflowAgent.run()` |

Additionally, `WorkflowRunOptions extends WorkflowAgentOptions` (workflow.ts:27), so it inherits `tools: ToolDefinition[]` — but `WorkflowRunOptions` is only used internally in `runWorkflow`, never exposed to workflow scripts.

The ambient `.d.ts` declaration (`types/workflow.d.ts:54`) declares the script-level type as `tools?: Array<"read" | ... | string>` (the allowlist). This is the correct public API and does not conflict at the type level (it's in a global namespace, while the exports are module-scoped).

The real pain point is **semantic**: workflow script authors see `tools` and naturally think "the tools my subagent can use," but the exported `WorkflowAgentOptions.tools` means "custom tool definitions the host registers at construction time." These are completely unrelated concepts sharing the same name in the same package.

Additionally, the future `extensionTools` field (`never` for now, line 80-81 of workflow.ts and line 65 of workflow.d.ts) is a close cousin of `AgentOptions.tools` — it will control extension tool grants. Keeping `tools` as the allowlist name keeps a clean `tools` / `extensionTools` / `callerSkills` cluster for subagent tool access control.

## Decision

### Primary: Rename `WorkflowAgentOptions.tools` → `customTools`

This is the only rename needed. Aligns the public API name with the internal field name (`this.customTools`) and with `AgentRunOptions.customTools`, which already exists as `customTools?: ToolDefinition[]`.

### Do NOT rename `AgentOptions.tools` or `AgentRunOptions.tools`

These are already internally consistent (both `string[]`, same concept), match the ambient `.d.ts` declaration, and form a natural cluster with the future `extensionTools` and `callerSkills` fields. Renaming them would be cosmetic churn with no type-safety benefit.

### Rationale

1. **Fixes the actual conflict.** The only incompatible type is `WorkflowAgentOptions.tools` (ToolDefinition[] vs everyone else's string[]). This is the only rename that eliminates a type-level name collision.

2. **Matches existing patterns.** The internal field is already called `this.customTools`. The per-call option `AgentRunOptions.customTools` already exists. The JSDoc already says "Additional custom tools always available to subagents." This rename just completes the alignment.

3. **Preserves the public script API.** Every workflow script, every doc example, every test uses `agent(prompt, { tools: ['read', 'edit'] })`. That API is stable and correct.

4. **Clear conceptual separation.** Post-rename:
   - `customTools` / `defaultTools`: what the host embeds (ToolDefinition[]) and what default allowlist to use (string[])
   - `tools`: what the workflow script requests per subagent call (string[])
   - `extensionTools` / `callerSkills`: future grant fields, naturally grouped with `tools`

5. **Future compatibility.** When `extensionTools` graduates from `never`, it belongs next to `tools` (both are tool-access grants the script requests). Keeping `tools` as the script-level allowlist name lets the three grant fields (`tools`, `extensionTools`, `callerSkills`) live together cleanly.

## Changes Required

### Source files (4 lines in 2 files)

**`src/agent.ts`**
- Line 20: `tools?: ToolDefinition[];` → `customTools?: ToolDefinition[];`
- Line 20 JSDoc: update comment to reflect new name
- Line 64: `this.customTools = options.tools ?? [];` → `this.customTools = options.customTools ?? [];`

**`src/agent.ts` JSDoc updates** — update the comment on line 19:
```
/** Additional custom tools always available to subagents. */
```
This is already correct; the field name just needs to match.

**`src/workflow.ts`** (only JSDoc)
- Line 10: `import { WorkflowAgent, type WorkflowAgentOptions }` — no change needed, but `WorkflowRunOptions extends WorkflowAgentOptions` on line 27 transparently picks up the rename.

### No changes needed

- `types/workflow.d.ts`: The ambient `WorkflowAgentOptions` already has `tools` as the correct script-level allowlist type. No change.
- `src/workflow.ts AgentOptions` (line 72): Already correct (`string[]`), and already called `tools`. No change.
- `src/index.ts`: Re-exports the renamed type automatically. No manual change needed.
- `tests/`: Zero tests construct `WorkflowAgent` with `tools` (ToolDefinition[]). No test breakage.
- `docs/DOCS.md`, `docs/workflow-api.md`, `docs/teams.md`, `docs/side-effects.md`: All use the script-level `tools` (string[]). No change.
- `agents/*.md`: All define `tools: read, grep, ...` — script-level. No change.
- `docs/adr/*.md`: Only references to `tools` are describing the user-facing API. No change.
- `extensions/`: No references. No change.

### Migration risk: NONE

The `WorkflowAgentOptions.tools` (ToolDefinition[]) field is:
1. Only consumed at constructor time (line 64)
2. Not used in any test
3. Not documented in any user-facing doc
4. Not accessed by any workflow script
5. Only available to host integrators who embed the `WorkflowAgent` class directly

If any external consumer references `WorkflowAgentOptions.tools`, they'll get a compile-time TypeScript error on upgrade — a safe, detectable break rather than a silent behavioral change.

## Rejected Alternatives

### Option B: `toolDefinitions` / `toolNames`

Rejected because:
- `AgentOptions.tools` → `toolNames` would break every workflow script's API surface
- `customTools` is already the established name in the codebase (`AgentRunOptions.customTools`, `this.customTools`)
- `toolDefinitions` is longer and less conventional than `customTools`

### Option C: `registeredTools` / `enabledTools`

Rejected because:
- "registered" vs "enabled" implies a two-stage lifecycle (register then enable), which isn't the model here — `customTools` are always registered AND enabled
- `enabledTools` is confusing next to `defaultTools` (are default tools "enabled" or just... defaults?)
- Breaks the established `customTools` precedent in `AgentRunOptions`

### Option A (full): renaming ALL three

Rejected for `AgentOptions.tools` and `AgentRunOptions.tools` because:
- No type conflict exists between them (both `string[]`)
- The ambient `.d.ts` uses `tools` for script-level API — renaming internal types would diverge from the published type contract
- Zero benefit, pure churn in internal plumbing

## Consequences

- **Positive:** `WorkflowAgentOptions` now has `customTools` (ToolDefinition[]) — clearly distinct from the script-level `tools` (string[]). No more semantic collision.
- **Positive:** Future `extensionTools` field lives naturally alongside `tools` in the script-level API, forming a clean tool-grant cluster.
- **Neutral:** `WorkflowRunOptions` inherits `customTools` instead of `tools`, but this type is only used internally and the rename is transparent.
- **Negative:** None. No breaking changes to any documented or used API.