# 0001: Runtime policy and weight-based model routing

## Status

**Superseded** — the `weight`/`stream`/`modelsByWeight` routing layer was removed. Subagents now select a model via the explicit `model: "provider/model-id"` option on every `agent()`/`spawn()` call. The runtime `policy` object is retained for `defaultTools`, `hostTools`, `maxConcurrency`, `hardAbortGraceMs`, `projectRoles`, and `mailboxPauseTimeoutSeconds`.

## Context

Workflow scripts are generated dynamically and should remain portable across Pi installations. Earlier design exploration considered embedding concrete local model names in the workflow package guidance, but provider/model names can be private, installation-specific, or unsuitable for contribution upstream.

At the same time, workflow authors need a way to express that some subagents are cheap fan-out lanes while others are high-value synthesis, review, or architecture lanes. Pi models also have a separate concept of thinking effort, so the routing concept must not reuse the term "effort". We use **Weight** for this model-routing size so it is not confused with a workflow **Lane**.

## Decision (historical)

Use a host-controlled runtime `policy` object for defaults and trust gates. For model routing, expose `weight` on `agent()`/`spawn()` with the values:

- `light`
- `medium`
- `heavy`

Map weights to concrete provider/model refs through `policy.modelsByWeight`.

`stream` and `policy.modelsByStream` remain supported as deprecated aliases for compatibility with existing workflow scripts.

Keep model thinking effort separate as `thinkingLevel`.

Explicit `model: "provider/model-id"` remains supported and overrides weight routing for that subagent.

## Why it was superseded

The weight indirection duplicated the explicit `model` option, required every host to configure a `modelsByWeight` mapping before any model routing worked, and advertised a dead concept to the LLM through the tool schema. In practice generated scripts and evals migrated to explicit `provider/model` refs, and the `weight` plumbing became self-referential dead code (the only reader of `weight` was `modelForWeight`; the only reader of `modelsByWeight` was `modelForWeight`). It also masked a latent bug where a `stream:` field was written into a non-existent `AgentRunOptions` member hidden by an `as any` cast. The routing layer was removed and the cast replaced with a typed builder.

## Consequences (current)

- The package remains provider-neutral: model refs are explicit strings resolved through the host's Pi model registry.
- Workflow scripts express model intent directly with `model: "provider/model-id"`.
- `thinkingLevel` remains a separate concept from model selection.
- The `policy` object still controls non-model runtime defaults and trust gates.
