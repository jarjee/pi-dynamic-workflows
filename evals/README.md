# pi-dynamic-workflows evals

End-to-end evals for the `workflow` Pi extension. These run `pi -p` with the extension explicitly loaded and judge whether the model can discover and use the workflow tool correctly.

## Goals

These evals are intentionally focused on **Type B** behavior: natural-language prompts that ask the model to use the workflow tool. The judge checks whether the model:

- actually invoked the `workflow` tool
- wrote a valid `registerPhase()` workflow script
- used correct API patterns (`agent`, `parallel`, `pipeline`, `spawn`, `mailbox`, `handoff`, `schema`, gates)
- used explicit provider/model refs instead of deprecated `weight`/`stream`
- produced sensible task results

The existing unit tests already cover most Type A runtime behavior. The retained `14-edge-cases` eval is a light full-extension regression suite for parse/validation error paths.

## Configure models

Copy `.env.example` to `.env` or pass CLI args. Model refs are provider-agnostic; use refs from your Pi model registry.

```bash
cp evals/.env.example evals/.env
$EDITOR evals/.env
```

Local `.env` is gitignored. Example local config:

```bash
PI_EVAL_TEST_MODEL=provider/code-model
PI_EVAL_JUDGE_MODEL=provider/judge-model
PI_EVAL_LIGHT_MODEL=provider/fast-model
PI_EVAL_MEDIUM_MODEL=provider/code-model
PI_EVAL_HEAVY_MODEL=provider/reasoning-model
```

The runner injects `LIGHT/MEDIUM/HEAVY` refs into prompts so generated workflow scripts use explicit `provider/model` refs.

## Run

```bash
# Run the main Type B evals
./evals/run.sh all

# Run the main evals plus slower edge-case regression suite
./evals/run.sh all-with-edge

# Run one eval
./evals/run.sh 01-basic-scan

# Override models from CLI
./evals/run.sh \
  --test-model provider/code-model \
  --judge-model provider/judge-model \
  --light-model provider/fast-model \
  --medium-model provider/code-model \
  --heavy-model provider/reasoning-model \
  04-team-mailbox
```

Reports are written to `evals/results/` (gitignored). Per-eval raw output logs are written to `evals/results/logs/`.

## Eval list

- `01-basic-scan` — basic registerPhase scan/synthesis workflow
- `02-structured-output` — schema/structured_output + validation gate
- `03-gate-retry` — registerPhase gate and retry loop
- `04-team-mailbox` — spawn + mailbox team flow
- `05-parallel-fanout` — parallel fan-out/fan-in
- `06-pipeline` — pipeline stages
- `07-side-effect-safety` — write-capable agents + file ownership + validation
- `08-roles` — package roles
- `09-full-integration` — kitchen-sink workflow
- `10-error-recovery` — recovery manifest from workflow failure
- `14-edge-cases` — full-extension error path regression (opt-in; use `14-edge-cases` or `all-with-edge`)

## Notes

- Type B evals run Pi with `--mode json` so the judge can inspect actual tool calls and tool execution events.
- The judge itself runs with `--no-tools`; it only reads the captured output and returns JSON.
- The workflow extension is loaded explicitly with `-e ../extensions/workflow.ts` and normal extension discovery is disabled with `--no-extensions`.
