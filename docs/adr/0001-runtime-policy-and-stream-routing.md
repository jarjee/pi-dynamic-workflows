# 0001: Runtime policy and weight-based model routing

## Status

Accepted

## Context

Workflow scripts are generated dynamically and should remain portable across Pi installations. Earlier design exploration considered embedding concrete local model names in the workflow package guidance, but provider/model names can be private, installation-specific, or unsuitable for contribution upstream.

At the same time, workflow authors need a way to express that some subagents are cheap fan-out lanes while others are high-value synthesis, review, or architecture lanes. Pi models also have a separate concept of thinking effort, so the routing concept must not reuse the term "effort". We use **Weight** for this model-routing size so it is not confused with a workflow **Lane**.

## Decision

Use a host-controlled runtime `policy` object for defaults and trust gates. For model routing, expose `weight` on `agent()`/`spawn()` with the values:

- `light`
- `medium`
- `heavy`

Map weights to concrete provider/model refs through `policy.modelsByWeight`.

`stream` and `policy.modelsByStream` remain supported as deprecated aliases for compatibility with existing workflow scripts.

Keep model thinking effort separate as `thinkingLevel`.

Explicit `model: "provider/model-id"` remains supported and overrides weight routing for that subagent.

## Consequences

- The package remains provider-neutral and contribution-friendly.
- Local/private model names live in user or project instructions, not package code.
- Workflow scripts can express intent without knowing the local model registry.
- Hosts can adjust routing without changing generated scripts.
- `weight` and `thinkingLevel` are separate concepts, avoiding terminology confusion.
- The legacy `stream` alias creates temporary API duplication, but preserves existing workflow compatibility while docs move to Weight.
