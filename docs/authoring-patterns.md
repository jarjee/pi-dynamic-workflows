# Workflow Authoring Patterns

Composable shapes for multi-subagent workflows: when each pattern pays off, a worked example in the workflow DSL, and how it composes with `registerPhase()` gates. Read [DOCS.md](../DOCS.md) for the script format and globals, and [workflow-api.md](workflow-api.md) for full API semantics. This doc is the catalog in between — how to arrange lanes, subagents, and phases so a workflow is comprehensive rather than merely parallel.

Vocabulary (see [CONTEXT.md](../CONTEXT.md)): a **Phase** is a top-level `registerPhase()` work unit, a **Lane** is one `parallel()` branch, a **Subagent** is an agent started by `agent()` or `spawn()`, a **Handoff** serializes data within a phase, and a **gate** validates a phase's output and drives retries.

Every example follows the authoring rules: deterministic orchestration (no `Date.now()` or `Math.random()`), prompts built by string concatenation, explicit `provider/model-id` refs, unique 2-5 word labels, and null-filtering after every `parallel()` or `pipeline()` — failed lanes and items return `null`, they do not throw.

## The barrier rule: default to pipeline()

`pipeline(items, ...stages)` runs each item through all stages with **no barrier between stages**. Items fan out concurrently, and each item's stages run in order, independently of every other item: item A can be in its final stage while item B is still in its first. Wall-clock time is the slowest single-item chain, not the sum of the slowest stages. This is the **default** for multi-stage work.

`parallel(thunks)` is a **barrier**: it awaits every lane before returning. It is correct only when the next step genuinely needs cross-lane context from all prior results:

- Dedup or merge across the full result set before expensive downstream work — verify each *unique* finding, not each raw one.
- Early exit when the total is zero — zero findings means skip verification entirely.
- A synthesis subagent whose prompt references the other lanes' findings.

A barrier is **not** justified by:

- Needing to flatten, map, or filter between steps — do the transform inside a pipeline stage.
- The stages being conceptually separate — that is exactly what `pipeline()` models. Separate stages are not synchronized stages.
- Cleaner code — barrier latency is real.

Concretely: five finder lanes where the slowest takes 3x the fastest (say 6 minutes vs 2). A barrier between find and verify holds the four fast lanes' results idle for 4 minutes — two thirds of their wall clock wasted — before verification starts. With `pipeline()`, each item's verification starts the moment its own finding lands, and total time approaches the slowest single chain instead of slowest lane plus everything after it.

Default shape — each file flows analyze → migrate independently:

```js
const results = await pipeline(
  files,
  (prev, file) => agent('Analyze ' + file + ' for Express API usage. Report call sites and risks.', {
    label: 'analyze ' + file,
    model: 'provider/light-model',
  }),
  (analysis, file) => agent('Migrate ' + file + ' from Express to Hono. Analysis:\n' + analysis, {
    label: 'migrate ' + file,
    tools: ['read', 'edit', 'write'],
    model: 'provider/code-model',
  }),
)
const migrated = results.filter(Boolean)
if (migrated.length < files.length) {
  log(files.length - migrated.length + ' file lane(s) failed and returned null')
}
```

Barrier genuinely correct — dedup across all finder lanes before paying for verification:

```js
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
        },
        required: ['path', 'line', 'description'],
      },
    },
  },
  required: ['findings'],
}

const rounds = await parallel(dimensions.map(d => () =>
  agent('Find ' + d + ' defects in the auth module.', {
    label: 'find ' + d,
    model: 'provider/code-model',
    schema: FINDINGS,
    retry: { attempts: 2 },
  })
))
const raw = rounds.filter(Boolean).flatMap(r => r.findings)
if (raw.length === 0) return 'No findings; verification skipped.' // early exit needs the full set
const seen = new Set()
const unique = raw.filter(f => {
  const key = f.path + ':' + f.line
  if (seen.has(key)) return false
  seen.add(key)
  return true
})
const verified = await pipeline(unique, (prev, f) =>
  agent('Confirm or refute this finding by reading the code:\n' + f.path + ':' + f.line + ' ' + f.description, {
    label: 'verify ' + f.path,
    model: 'provider/reasoning-model',
  })
)
```

Smell test: if you wrote `await parallel(...)`, then a plain transform (flatten, map, filter — no cross-item dependency), then `await parallel(...)` again, the middle transform did not need the barrier. Rewrite it as a `pipeline()` with the transform inside a stage. When in doubt, pipeline.

Composing with gates: `parallel()` and `pipeline()` both live inside a phase body, and the gate validates the phase's final output whatever shape produced it. Barrier decisions are therefore local to the body — `registerPhase('Migrate', body, { gate, maxIterations })` wraps a pipeline without changing how the pipeline behaves.

## Adversarial verify

**When to use:** findings will be acted on or reported as fact, and the failure mode is plausible-but-wrong output. Spawn N independent skeptic subagents per finding, each prompted to *refute* it — defaulting to refuted when uncertain — and kill the finding when a majority refute. This is what prevents confident-sounding hallucinations from surviving into the final report.

```js
registerPhase('Verify', async (findings) => {
  const VERDICT = {
    type: 'object',
    properties: {
      refuted: { type: 'boolean' },
      reasoning: { type: 'string' },
    },
    required: ['refuted', 'reasoning'],
  }

  const survives = async (finding, index) => {
    const votes = await parallel([0, 1, 2].map(i => () =>
      agent(
        'You are a skeptic. Read the code and try to REFUTE this finding. ' +
          'Default to refuted=true unless you can concretely confirm it.\nFinding:\n' + finding,
        {
          label: 'refute ' + index + '.' + i,
          model: 'provider/reasoning-model',
          schema: VERDICT,
          retry: { attempts: 2 },
        },
      )
    ))
    const valid = votes.filter(Boolean)
    const refuters = valid.filter(v => v.refuted).length
    return valid.length > 0 && refuters * 2 <= valid.length // killed only when a majority refute
  }

  const verdicts = await parallel(findings.map((f, i) => () => survives(f, i)))
  const confirmed = findings.filter((f, i) => verdicts[i])
  log(findings.length - confirmed.length + ' finding(s) killed by majority refute')
  return confirmed
})
```

Structured lanes need `retry` (an LLM can fail to call `structured_output`) and downstream null-checks — a finding with zero valid votes is killed here rather than promoted.

**Gate composition:** the whole verify pass can be one phase, or it can be the gate itself — a phase whose gate rejects its own output while unverified claims remain in it.

## Perspective-diverse verify

**When to use:** a finding can fail in more than one way. Instead of N identical refuters, give each verifier a distinct lens — correctness, security, does-it-reproduce. Diversity catches failure modes redundancy cannot: three clones of the same skeptic share the same blind spot.

```js
const LENSES = [
  {
    name: 'correctness',
    ask: 'Is the claim true of this code as written? Check the exact lines and logic.',
  },
  {
    name: 'security',
    ask: 'Assuming the claim is technically true, is it actually exploitable or policy-relevant?',
  },
  {
    name: 'reproduction',
    ask: 'Does the failure reproduce from the stated inputs and preconditions?',
  },
]

// VERDICT is the schema from the adversarial-verify example above.
const verdicts = await parallel(LENSES.map(lens => () =>
  agent(
    'Verify this finding through exactly one lens: ' + lens.ask + '\nFinding:\n' + finding,
    {
      label: 'lens ' + lens.name,
      model: 'provider/reasoning-model',
      schema: VERDICT,
      retry: { attempts: 2 },
    },
  )
))
const valid = verdicts.filter(Boolean)
const confirmed = valid.length > 0 && valid.every(v => !v.refuted)
```

Pick lenses that map to the real failure modes of the claim, and drop a lens that does not apply rather than prompting a verifier to invent an opinion. `every()` here is the strict choice — any lens refuting kills the finding; relax it to a majority if partial confirmation is useful. As with adversarial verify, a panel that returned no valid verdicts at all fails closed: the finding is not confirmed.

## Judge panel

**When to use:** the solution space is wide — design, architecture, migration strategy, naming. One attempt iterated tends to anchor on its first framing; N independent attempts from different angles explore more of the space. Generate the attempts, score them with parallel judge subagents, then synthesize from the winner while grafting the best ideas from the runners-up.

```js
registerPhase('Design', async (brief) => {
  const angles = [
    'MVP-first — the smallest design that ships the core loop',
    'risk-first — the design that minimizes migration and data-loss risk',
    'user-first — the design that optimizes the primary user journey',
  ]
  const proposals = (await parallel(angles.map(angle => () =>
    agent('Propose an architecture for this brief. Angle: ' + angle + '\nBrief:\n' + handoff(brief), {
      label: 'proposal ' + angle.split(' ')[0],
      model: 'provider/reasoning-model',
      thinkingLevel: 'high',
    })
  ))).filter(Boolean)

  const SCORE = {
    type: 'object',
    properties: {
      score: { type: 'number' },
      strengths: { type: 'array', items: { type: 'string' } },
      weaknesses: { type: 'array', items: { type: 'string' } },
    },
    required: ['score', 'strengths', 'weaknesses'],
  }
  const scored = await parallel(proposals.map((p, i) => () =>
    agent('Score this proposal 1-10 on correctness, cost, and evolvability. Be harsh.\nProposal:\n' + p, {
      label: 'judge ' + i,
      model: 'provider/reasoning-model',
      schema: SCORE,
      retry: { attempts: 2 },
    })
  ))
  const ranked = scored
    .map((s, i) => ({ i, score: s ? s.score : -1 }))
    .filter(x => x.score >= 0)
  if (ranked.length === 0) {
    log('judge panel: no proposal survived scoring; failing the phase')
    return null
  }
  let best = 0
  for (let i = 1; i < ranked.length; i++) {
    if (ranked[i].score > ranked[best].score) best = i // ties break to the earliest proposal
  }
  const winner = proposals[ranked[best].i]
  const runnersUp = proposals.filter((p, i) => i !== ranked[best].i)
  return agent(
    'Write the final design from the winning proposal, grafting the best ideas from the runners-up where they clearly improve it.' +
      '\nWinning proposal:\n' + handoff(winner) + '\nRunners-up:\n' + handoff(runnersUp),
    { label: 'final design', model: 'provider/reasoning-model', thinkingLevel: 'high' },
  )
})
```

Both barriers are genuine: the judges need the complete proposal set to exist, and the final synthesis references every proposal. A judge that scored all proposals comparatively (ranking the full set in one verdict) is a stronger but costlier alternative — use it when the proposals are close.

## Loop-until-dry

**When to use:** discovery of unknown size — bugs, edge cases, coverage gaps. A fixed counter (`while count < N`) stops at an arbitrary number and misses the tail. Keep spawning finder lanes until K consecutive rounds surface nothing new.

The load-bearing detail is the **seen-set**: dedupe each round against everything ever surfaced, not against the accepted list. Judge-rejected findings must stay in the seen-set, or they reappear every round and the loop never converges.

```js
export const meta = {
  name: 'hunt_bugs',
  description: 'Spawn finder lanes until two consecutive dry rounds',
}

registerPhase('Hunt', async () => {
  // FINDINGS is the schema from the barrier-rule example above.
  const seen = new Set()
  const accepted = []
  let round = 0
  let dryRounds = 0
  while (dryRounds < 2) {
    round += 1
    const known = handoff(accepted)
    const lanes = await parallel(
      ['error handling', 'concurrency', 'input validation'].map(area => () =>
        agent('Hunt for bugs involving ' + area + '. These are already known — do not resurface them:\n' + known, {
          label: 'hunt ' + area + ' r' + round,
          model: 'provider/code-model',
          schema: FINDINGS,
          retry: { attempts: 2 },
        })
      )
    )
    const surfaced = lanes.filter(Boolean).flatMap(r => r.findings)
    const fresh = surfaced.filter(f => {
      const key = f.path + ':' + f.line
      if (seen.has(key)) return false
      seen.add(key) // seen-set, not the accepted list
      return true
    })
    if (fresh.length === 0) {
      dryRounds += 1
      log('round ' + round + ' dry (' + dryRounds + '/2)')
      continue
    }
    dryRounds = 0
    for (const f of fresh) accepted.push(f)
    log('round ' + round + ': ' + fresh.length + ' new, ' + accepted.length + ' total')
  }
  return accepted
})
```

Feed `accepted` into an adversarial-verify phase next: discovery and verification are separate concerns with different fan-out shapes.

**Gate composition:** gate retries re-run the whole phase body — the right tool when there is a known check (tests pass, critic satisfied) and a bounded retry count. Loop-until-dry is for the case where the number of rounds is genuinely unknowable up front; keep the loop inside the body and use gates for validation, not for discovery.

## Budget-scaled fan-out

**When to use:** the user set a token target, and depth should scale to it. The `budget` global offers `total`, `spent()`, and `remaining()`. Guard every budget loop on `budget.total`: when no target is set, `total` is `null` and `remaining()` returns `Infinity`, so a loop conditioned only on `remaining()` never sees the threshold crossed and runs until the workflow is stopped.

Static scaling — size the fleet before any lane starts:

```js
const PER_LANE_ESTIMATE = 100000
const fleet = budget.total ? Math.max(2, Math.floor(budget.total / PER_LANE_ESTIMATE)) : 4
const swept = await parallel(areas.slice(0, fleet).map(area => () =>
  agent('Audit ' + area + ' for regressions.', {
    label: 'audit ' + area,
    model: 'provider/code-model',
  })
))
if (areas.length > fleet) {
  log('budget-scaled to ' + fleet + ' of ' + areas.length + ' areas; ' + (areas.length - fleet) + ' not covered')
}
```

Dynamic scaling — loop while budget remains (the `budget.total` guard is load-bearing; `FINDINGS` is the schema from the barrier-rule example above):

```js
let round = 0
const findings = []
while (budget.total && budget.remaining() > 50000) {
  round += 1
  const result = await agent('Find remaining edge cases in the payment module.', {
    label: 'edge sweep r' + round,
    model: 'provider/code-model',
    schema: FINDINGS,
    retry: { attempts: 2 },
  })
  if (!result || result.findings.length === 0) break
  for (const f of result.findings) findings.push(f)
  log('round ' + round + ': ' + findings.length + ' total, ' + Math.round(budget.remaining() / 1000) + 'k tokens left')
}
```

Note the coverage log when scaling drops lanes — that is the no-silent-caps rule below.

## Multi-modal sweep

**When to use:** one search angle will not surface everything — secrets, dead code, incident reconstruction. Run parallel lanes each searching a *different way* (by-container, by-content, by-entity, by-timeline). Each lane is deliberately blind to the others; overlapping hits are merged afterward, not avoided during.

```js
const HITS = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
      },
    },
  },
  required: ['items'],
}

const ANGLES = [
  {
    name: 'by container',
    prompt: 'Find credential storage by container: env files, CI variables, Dockerfiles, compose files.',
  },
  {
    name: 'by content',
    prompt: 'Find credentials by content: search for token, key, and password patterns across the repo.',
  },
  {
    name: 'by entity',
    prompt: 'Find credentials by entity: locate every service that authenticates, then trace where its credentials come from.',
  },
  {
    name: 'by timeline',
    prompt: 'Find credentials by timeline: read recent commits touching auth or config for secrets added or rotated.',
  },
]

const sweeps = await parallel(ANGLES.map(a => () =>
  agent(a.prompt + ' Report each hit with its path and reason.', {
    label: 'sweep ' + a.name,
    tools: ['read', 'grep', 'find', 'ls'],
    model: 'provider/code-model',
    schema: HITS,
    retry: { attempts: 2 },
  })
))
const hits = sweeps.filter(Boolean).flatMap(r => r.items)

// The barrier was genuine: deep reads start from the deduped full hit set.
const deepReads = await pipeline(hits, (prev, hit) =>
  agent('Read ' + hit.path + ' and confirm whether this is a real credential exposure: ' + hit.reason, {
    label: 'confirm ' + hit.path,
    model: 'provider/reasoning-model',
  })
)
```

This pattern composes with loop-until-dry when a single sweep round is not enough: the sweep becomes one round of the loop, and each round's hits join the seen-set.

## Completeness critic

**When to use:** any workflow that reports "done" — audits, reviews, research. A final subagent asks what is *missing*: a modality not run, a claim asserted without evidence, a source referenced but never read. What it finds becomes the next round of work.

Its natural home is a gate: return the critic's gap list as the failure string and the runtime injects it as `<retry>` context on the next iteration — the body's subagents repair their own output with no manual retry-prompt plumbing (see [register-phase-dsl.md](register-phase-dsl.md)).

```js
registerPhase('Report', async (findings) => {
  return agent('Write the final audit report from these findings:\n' + handoff(findings), {
    label: 'audit report',
    model: 'provider/reasoning-model',
    role: 'package:synthesizer',
  })
}, {
  gate: async (report) => {
    const GAPS = {
      type: 'object',
      properties: {
        complete: { type: 'boolean' },
        gaps: { type: 'array', items: { type: 'string' } },
      },
      required: ['complete', 'gaps'],
    }
    const critique = await agent(
      'Critique this audit report for completeness only. Name concrete gaps: claims asserted without evidence, ' +
        'files referenced but never read, angles the report admits it did not cover.\nReport:\n' + handoff(report),
      { label: 'completeness critic', model: 'provider/reasoning-model', thinkingLevel: 'high', schema: GAPS, retry: { attempts: 2 } }
    )
    if (!critique) return 'critic lane failed; regenerate the report'
    return critique.complete || critique.gaps.length === 0 ? null : 'Gaps: ' + critique.gaps.join('; ')
  },
  maxIterations: 3,
})
```

Without a gate, the same critic works as a final lane whose output you return alongside the report — but then deciding what to do about the gaps is the caller's job, not the workflow's.

## No silent caps

**When to use:** any time a workflow bounds its own coverage — top-N findings, sampled files, budget-scaled fleets, dropped lanes. Silent truncation reads as "covered everything" when it did not. `log()` what was dropped.

Failed lanes already return `null`; pair the `.filter(Boolean)` with an explicit log of what was lost:

```js
const labels = ['api surface', 'error handling', 'concurrency', 'docs']
const results = await parallel(labels.map(l => () =>
  agent('Review the module for ' + l + ' issues.', { label: 'review ' + l, model: 'provider/code-model' })
))
results.forEach((r, i) => {
  if (!r) log('lane returned null: ' + labels[i])
})
const ok = results.filter(Boolean)
```

Caps on ranked output:

```js
const CAP = 20
const RANK = { critical: 3, high: 2, medium: 1, low: 0 }
const ranked = findings.slice().sort((a, b) => RANK[b.severity] - RANK[a.severity])
const top = ranked.slice(0, CAP)
if (ranked.length > CAP) {
  log('verified top ' + CAP + ' of ' + ranked.length + ' findings by severity; ' + (ranked.length - CAP) + ' not verified')
}
```

The final summary should carry the same honesty: report what was checked, what failed, and what was left out — never present a capped result as complete coverage.

## Compose freely

These are building blocks, not a menu of fixed workflows. Real tasks want combinations: a multi-modal sweep whose hits feed adversarial verify inside one phase, a judge panel per subsystem with winners advancing to a final panel (a tournament bracket), staged escalation where cheap sweep lanes run wide and heavy verify lanes run only on survivors, or a discovery loop whose round budget comes from `budget.remaining()`.

Self-repair is already native: a `registerPhase()` gate plus `maxIterations` re-runs the body with the gate's failure string injected as `<retry>` context, so repair loops need no hand-rolled retry logic. Add patterns on top of that — a completeness critic as the gate, a judge panel as the body — rather than reimplementing iteration yourself.

Pick patterns by what the task risks: unverified claims → adversarial or perspective-diverse verify; a wide solution space → judge panel; an unknown-size tail → loop-until-dry; a hard token target → budget-scaled fan-out; a blind spot → multi-modal sweep; a premature "done" → completeness critic. Most workflows need two or three, not all ten.
