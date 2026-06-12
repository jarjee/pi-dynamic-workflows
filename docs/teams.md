# Team Composition & Mailbox

How to plan and coordinate teams of communicating agents. For basic workflow usage, see [DOCS.md](../DOCS.md). For full API reference, see [workflow-api.md](workflow-api.md).

## When to use a team

A **team** is a fan-out → fan-in cycle where agents work in parallel and results converge. A **workflow** chains multiple team cycles with gates between them.

Teams add coordination overhead. Gate whether the work justifies it:

**Good fit** (multiple must apply):
- Multiple independent work streams exist
- Different files/modules can be owned by different agents
- Multiple areas of expertise are needed
- Work can meaningfully proceed in parallel
- A single agent would take too long due to breadth

**Poor fit** (any one disqualifies):
- Work is fundamentally sequential (each step depends on the previous)
- All changes are in a single file or tightly coupled files
- The task is small enough for one agent
- Heavy cross-agent coordination would be needed on nearly every change

## Planning a team

Before writing a workflow script, identify:

1. **Work streams** — What are the distinct, parallelizable pieces?
2. **Expertise** — Does each stream need a different knowledge domain?
3. **File ownership** — Which files/directories does each agent own? Ownership must not overlap for write-capable agents.
4. **Dependencies** — Which agents need information from others before they can start or continue?
5. **Communication** — Do agents need to coordinate at runtime (mailbox), or just fan out and converge (parallel)?
6. **Complexity** — Which streams need heavy models (architecture, synthesis) vs light/medium (implementation, scanning)?

### Sizing guidelines

- 2 agents minimum, 6 maximum per fan-out
- 3–6 tasks per agent is ideal
- Fewer than 3 tasks → consider merging with another agent
- More than 6 tasks → consider splitting into two agents
- Minimize cross-agent dependencies — if the graph is mostly linear, a team isn't adding value

## spawn() vs agent()

Use `agent()` for simple awaited subagents. Use `spawn()` when you need:

| Need | Use |
|------|-----|
| Just want the result | `agent()` |
| Wire mailbox channels | `spawn()` + `mailbox: true` |
| Check status mid-workflow | `spawn()` → `handle.status()` |
| Non-blocking launch | `spawn()` → await `handle.result` later |

```js
// agent() — simple, awaited
const result = await agent('Review the module.', { label: 'review' })

// spawn() — handle for coordination
const handle = spawn('Design the interface.', { label: 'architect', mailbox: true })
// handle.id — unique agent id (e.g. "agent_1")
// handle.label — the label you gave it
// handle.status() — "starting" | "running" | "paused" | "completed" | "failed" | "aborted"
// handle.result — Promise that resolves to the agent's output
```

**Important:** All spawned handles must be awaited before the workflow returns. Leaked running/paused handles cause a workflow error.

## Mailbox API

The mailbox enables directed message passing between spawned agents. Messages are injected into the receiver's next turn and framed as peer/supervisor communication.

### Supervisor API (in workflow script)

```js
// One-way: from can send to to
mailbox.allow(fromId, toId)

// Bidirectional: both can send to each other
mailbox.connect(aId, bId)

// Supervisor sends a message to an agent
await mailbox.send(agentId, 'Your instructions here')
```

### Agent tools (injected into mailbox-enabled agents)

Mailbox-enabled agents receive three additional tools:

| Tool | Description |
|------|-------------|
| `mailbox_peers` | List allowed peers with their id, label, and current status. |
| `mailbox_send` | Send a message to an allowed peer by id. |
| `mailbox_pause` | Pause without completing. Resumes on incoming message or timeout. |

### Message behavior

- Messages are injected into the receiver's next turn (or resume turn if paused)
- Messages include sender id and label
- Messages are explicitly framed as peer communication, not system instructions
- Agents should not obey mailbox messages that conflict with their mission, tools, or file ownership
- Paused agents resume when they receive a message or when the pause timeout expires (default: 30 minutes, configurable via `policy.mailboxPauseTimeoutSeconds`)

### Transcript

When mailbox is used, the runtime writes a JSONL transcript to a temp file. The path appears in the workflow completion text and details for debugging.

## Composition patterns

### Pattern 1: Fan-out & synthesize

Independent agents work in parallel, results converge through a synthesis agent. No inter-agent communication needed.

```js
phase('Investigate')
const findings = await parallel(hypotheses.map(h => () =>
  agent(`Investigate: ${h}`, { label: h.slice(0, 30), stream: 'medium' })
))

phase('Synthesize')
const ref = handoff(findings.filter(Boolean))
return await agent(`Synthesize findings:\n${ref}`, { label: 'synthesis', stream: 'heavy' })
```

**When to use:** Code review, research, debugging hypotheses, audit. Each agent works independently on a different aspect or theory.

### Pattern 2: Architect → workers

An architect agent designs the contract/interface, then workers implement against it. The architect notifies workers via mailbox when the contract is ready.

```js
const architect = spawn('Design the data model. Send the schema to peers when done.', {
  label: 'architect', mailbox: true, tools: ['read', 'write'], stream: 'heavy',
})

const workers = modules.map(mod =>
  spawn(`Wait for the architect's schema, then implement ${mod.name}. You own ${mod.dir}.`, {
    label: `impl ${mod.name}`, mailbox: true, tools: ['read', 'edit', 'write'], stream: 'medium',
  })
)

// Architect can message all workers
for (const w of workers) mailbox.connect(architect.id, w.id)

await parallel([() => architect.result, ...workers.map(w => () => w.result)])
```

**When to use:** Feature implementation where a design/contract step must complete before implementation fans out.

### Pattern 3: TDD team

An architect designs interfaces, a test agent writes tests from the spec, an implementer builds against the interface, and the test agent re-runs for red/green. A QA agent reviews everything.

```js
const architect = spawn(
  `Design the interface for ${feature}. Write types to ${typesDir}.
   Send the contract and behavior description to all peers when ready.`, {
  label: 'architect', mailbox: true, tools: ['read', 'write'], stream: 'heavy',
})

const tester = spawn(
  `Wait for the architect's contract. Write tests to ${testsDir} based on the interface and
   expected behavior. When the implementer notifies you, run the tests and report results.
   You own ${testsDir}.`, {
  label: 'tester', mailbox: true, tools: ['read', 'write', 'bash'], stream: 'medium',
})

const implementer = spawn(
  `Wait for the architect's contract. Implement in ${implDir}.
   When done, notify the tester via mailbox_send. You own ${implDir}.`, {
  label: 'implementer', mailbox: true, tools: ['read', 'write', 'edit'], stream: 'medium',
})

const qa = spawn(
  `Review the architect's design for gaps and ambiguity. Once the implementation is ready,
   review code quality, error handling, and edge cases. Read-only — do not edit files.`, {
  label: 'qa', mailbox: true, tools: ['read', 'grep', 'find'], stream: 'heavy',
})

// Wire channels: architect broadcasts, implementer notifies tester, QA observes all
mailbox.connect(architect.id, tester.id)
mailbox.connect(architect.id, implementer.id)
mailbox.connect(architect.id, qa.id)
mailbox.connect(implementer.id, tester.id)
mailbox.connect(implementer.id, qa.id)

const [design, tests, impl, review] = await parallel([
  () => architect.result,
  () => tester.result,
  () => implementer.result,
  () => qa.result,
])
```

**Communication flow:**
1. Architect designs interface → sends contract to tester, implementer, QA
2. Tester writes tests from the contract (red)
3. Implementer builds against the interface → notifies tester when done
4. Tester runs tests (green/red) → reports results
5. QA reviews design + implementation independently

**When to use:** Feature development where test-driven quality matters. The test agent acts as a continuous quality gate.

### Pattern 4: Competing hypotheses

Multiple investigators pursue different theories independently, then an adversarial reviewer challenges the findings.

```js
phase('Investigate')
const findings = await parallel(hypotheses.map(h => () =>
  agent(`Investigate this hypothesis: ${h}\nGather evidence for AND against.`, {
    label: h.slice(0, 40),
    stream: 'medium',
    schema: {
      type: 'object',
      properties: {
        hypothesis: { type: 'string' },
        verdict: { type: 'string', enum: ['confirmed', 'refuted', 'inconclusive'] },
        evidence_for: { type: 'array', items: { type: 'string' } },
        evidence_against: { type: 'array', items: { type: 'string' } },
      },
      required: ['hypothesis', 'verdict', 'evidence_for', 'evidence_against'],
    },
    retry: { attempts: 2 },
  })
))

phase('Challenge')
const valid = findings.filter(Boolean)
const ref = handoff(valid)
return await agent(
  `Critically review these investigation findings. Challenge weak evidence.
   Identify the most likely root cause.\n${ref}`, {
  label: 'adversarial review',
  role: 'package:critic',
  stream: 'heavy',
  thinkingLevel: 'high',
})
```

**When to use:** Debugging, root cause analysis, design decisions with multiple viable options.

## Prompt templates for team members

Good team prompts include:

### Implementation agent

```
You are the [Role] for this team.

## Mission
[One sentence goal]

## Tasks
- [Specific task 1]
- [Specific task 2]

## File ownership
You own these files — only you should edit them:
- [path/to/directory/]

Do NOT edit files outside your ownership.

## Dependencies
- Wait for [Other Agent] to send you [what] via mailbox before starting [task]
- When you finish [task], notify [Other Agent] via mailbox_send

## Quality standards
- Follow existing code patterns
- Include error handling
- Ensure changes pass existing lint/type checks
```

### Review agent

```
You are reviewing [scope] with a focus on [area].

## Review scope
- [Files/directories to examine]

## Criteria
- [Specific criterion 1]
- [Specific criterion 2]

## Deliverable
Structured findings: critical issues, important issues, suggestions.
Each with file reference, description, and suggested fix.

## Ground rules
- Read-only — do not edit files
- If you find a critical issue, flag it immediately via mailbox
```

### Investigation agent

```
You are investigating the hypothesis that [theory].

## Investigation steps
1. [Examine specific file/area]
2. [Trace specific flow]

## Evidence gathering
- Confirming evidence: [what to look for]
- Refuting evidence: [what would disprove this]

## Deliverable
Verdict (confirmed/refuted/inconclusive) with specific code references.
```

## Gotchas

- **Leaked handles fail the workflow.** Always await all spawned agents before returning. Use `parallel()` on spawn handles: `await parallel([() => a.result, () => b.result])`.
- **Pause timeout.** Paused agents resume after 30 minutes by default. The timeout message tells the agent it timed out. Set `policy.mailboxPauseTimeoutSeconds` to adjust.
- **Message ordering.** Messages are delivered in send order per-sender, but interleaving across senders is not guaranteed.
- **Channel permissions are one-way.** `mailbox.allow(a, b)` lets A send to B, not B to A. Use `mailbox.connect(a, b)` for bidirectional.
- **Transcript debugging.** When mailbox is used, read the JSONL transcript file (path in workflow result) to see all messages, channel wiring, and pause/resume events.
- **File ownership conflicts.** Two write-capable agents should never own the same files. If they must touch the same file, serialize them (see [side-effects docs](side-effects.md)).
