#!/usr/bin/env bash
# judge.sh — LLM-as-judge evaluation for pi-dynamic-workflows evals.
# Sources: .env, then CLI args take precedence.
#
# Usage: judge_eval <eval_name> <rubric_file> <test_output> <test_prompt>
#   Returns JSON on stdout: { "overall": "PASS"|"FAIL", "criteria": [...] }
#   Exit code 0 on any valid judge response, even if verdict is FAIL.
#   Exit code 1 on judge failure (timeout, parse error, model error).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SCRIPT_DIR/.env" ] && source "$SCRIPT_DIR/.env"

JUDGE_MODEL="${PI_EVAL_JUDGE_MODEL:-openrouter/gpt-5.5}"
JUDGE_TIMEOUT="${PI_EVAL_JUDGE_TIMEOUT:-120}"

judge_eval() {
  local eval_name="$1"
  local rubric_file="$2"
  local test_output="$3"
  local test_prompt="$4"

  if [ ! -f "$rubric_file" ]; then
    echo '{"overall":"ERROR","criteria":[{"name":"judge_infra","result":"FAIL","reasoning":"rubric file not found: '"$rubric_file"'"}]}'
    return 0
  fi

  local rubric
  rubric="$(cat "$rubric_file")"

  # Truncate test output to avoid overwhelming the judge, but preserve both
  # the beginning (toolCall/script) and end (tool result/final answer).
  local truncated_output
  local output_size
  output_size=$(printf '%s' "$test_output" | wc -c | tr -d ' ')
  if [ "$output_size" -le 24000 ]; then
    truncated_output="$test_output"
  else
    truncated_output="$(printf '%s' "$test_output" | head -c 12000)

--- OUTPUT TRUNCATED: middle omitted ---

$(printf '%s' "$test_output" | tail -c 12000)"
  fi

  local judge_prompt
  judge_prompt=$(cat <<JUDGE_PROMPT
You are an automated test judge evaluating a pi-dynamic-workflows integration test.

## Test: ${eval_name}

## What was asked of the test model
\`\`\`
${test_prompt}
\`\`\`

## Evaluation Rubric
\`\`\`json
${rubric}
\`\`\`

## Actual Test Output (head+tail if truncated)
This is pi --mode json output: newline-delimited JSON events. Look for assistant toolCall events named "workflow", tool_execution_start/end events, workflow details, and final assistant text.
\`\`\`
${truncated_output}
\`\`\`

## Instructions
For each criterion in the rubric, write PASS or FAIL with a one-sentence reasoning.
Then give an overall verdict: PASS if ALL criteria pass, FAIL otherwise.
If the test model did not call the workflow tool at all (no toolCall/tool_execution_start with name/toolName "workflow" and no workflow result), mark all criteria FAIL with reasoning "No workflow tool invocation found in output".

Respond with ONLY this JSON structure (no markdown fences, no prose):
{
  "overall": "PASS" or "FAIL",
  "criteria": [
    { "name": "criterion_name", "result": "PASS", "reasoning": "brief explanation" },
    ...
  ]
}
JUDGE_PROMPT
)

  local judge_output
  if ! judge_output=$(timeout "$JUDGE_TIMEOUT" pi -p "$judge_prompt" \
    --model "$JUDGE_MODEL" \
    --no-extensions \
    --no-skills \
    --no-context-files \
    --no-prompt-templates \
    --no-tools \
    2>&1); then
    echo '{"overall":"ERROR","criteria":[{"name":"judge_infra","result":"FAIL","reasoning":"judge model call failed or timed out"}]}'
    return 0
  fi

  # Extract JSON from judge output and normalize it with jq.
  # Try, in order:
  #   1. entire output is JSON
  #   2. fenced ```json block
  #   3. first top-level-looking JSON object block
  local json
  json="$(extract_judge_json "$judge_output" || true)"

  if [ -z "$json" ]; then
    # Retry once with stronger instruction
    local retry_prompt
    retry_prompt=$(cat <<RETRY_PROMPT
Your previous response did not contain valid JSON. You MUST output ONLY a JSON object.

## Test: ${eval_name}

## Evaluation Rubric
\`\`\`json
${rubric}
\`\`\`

## Test Output (head+tail if truncated)
\`\`\`
${truncated_output}
\`\`\`

Respond with ONLY this exact JSON structure (no markdown, no backticks, no prose before or after):
{ "overall": "PASS" or "FAIL", "criteria": [ { "name": "...", "result": "PASS" or "FAIL", "reasoning": "..." } ] }
RETRY_PROMPT
)

    if ! judge_output=$(timeout "$JUDGE_TIMEOUT" pi -p "$retry_prompt" \
      --model "$JUDGE_MODEL" \
      --no-extensions \
      --no-skills \
      --no-context-files \
      --no-prompt-templates \
      --no-tools \
      2>&1); then
      echo '{"overall":"ERROR","criteria":[{"name":"judge_infra","result":"FAIL","reasoning":"judge retry failed or timed out"}]}'
      return 0
    fi

    json="$(extract_judge_json "$judge_output" || true)"

    if [ -z "$json" ]; then
      echo '{"overall":"ERROR","criteria":[{"name":"judge_infra","result":"FAIL","reasoning":"judge did not produce parseable JSON after retry"}]}'
      return 0
    fi
  fi

  # Validate JSON structure
  if ! echo "$json" | jq -e '.overall' > /dev/null 2>&1; then
    echo '{"overall":"ERROR","criteria":[{"name":"judge_infra","result":"FAIL","reasoning":"judge JSON missing .overall field: '"$(echo "$json" | head -c 200)"'"}]}'
    return 0
  fi

  echo "$json"
}

extract_judge_json() {
  local text="$1"

  # 1. Entire output is JSON.
  if printf '%s' "$text" | jq -c . > /tmp/pi-workflow-judge-json.$$ 2>/dev/null; then
    cat /tmp/pi-workflow-judge-json.$$
    rm -f /tmp/pi-workflow-judge-json.$$
    return 0
  fi
  rm -f /tmp/pi-workflow-judge-json.$$

  # 2. Fenced json block.
  local fenced
  fenced="$(printf '%s\n' "$text" | awk '
    /^```json[[:space:]]*$/ { in_block=1; next }
    /^```[[:space:]]*$/ && in_block { exit }
    in_block { print }
  ')"
  if [ -n "$fenced" ] && printf '%s' "$fenced" | jq -c . > /tmp/pi-workflow-judge-json.$$ 2>/dev/null; then
    cat /tmp/pi-workflow-judge-json.$$
    rm -f /tmp/pi-workflow-judge-json.$$
    return 0
  fi
  rm -f /tmp/pi-workflow-judge-json.$$

  # 3. Top-level-looking JSON object. This covers common model output like:
  #    "Here is the JSON:\n{ ... }\n". It assumes the final top-level closing brace
  #    is on its own line, which the judge prompt requests.
  local object
  object="$(printf '%s\n' "$text" | awk '
    /^[[:space:]]*\{/ { in_obj=1 }
    in_obj { print }
    /^[[:space:]]*\}[[:space:]]*$/ && in_obj { exit }
  ')"
  if [ -n "$object" ] && printf '%s' "$object" | jq -c . > /tmp/pi-workflow-judge-json.$$ 2>/dev/null; then
    cat /tmp/pi-workflow-judge-json.$$
    rm -f /tmp/pi-workflow-judge-json.$$
    return 0
  fi
  rm -f /tmp/pi-workflow-judge-json.$$

  return 1
}