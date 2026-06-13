#!/usr/bin/env bash
# run.sh — pi-dynamic-workflows eval runner.
#
# Usage:
#   ./evals/run.sh [--test-model <model>] [--judge-model <model>] [--timeout N] [all|<eval-name>]
#
# Examples:
#   ./evals/run.sh all
#   ./evals/run.sh --test-model deepseek-v4-flash --judge-model gpt-5.5 01-registerPhase-basic
#   PI_EVAL_TEST_MODEL=deepseek-v4-pro ./evals/run.sh all
#
# Model references are provider-agnostic. Use any model id from your Pi model registry.
# The workflow extension is loaded from ../extensions/workflow.ts relative to this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env if present
[ -f "$SCRIPT_DIR/.env" ] && source "$SCRIPT_DIR/.env"

# Source libs
source "$SCRIPT_DIR/lib/judge.sh"
source "$SCRIPT_DIR/lib/fixtures.sh"
source "$SCRIPT_DIR/lib/report.sh"

# --- Defaults ---
TEST_MODEL="${PI_EVAL_TEST_MODEL:-}"
JUDGE_MODEL="${PI_EVAL_JUDGE_MODEL:-}"
LIGHT_MODEL="${PI_EVAL_LIGHT_MODEL:-${PI_EVAL_TEST_MODEL:-}}"
MEDIUM_MODEL="${PI_EVAL_MEDIUM_MODEL:-${PI_EVAL_TEST_MODEL:-}}"
HEAVY_MODEL="${PI_EVAL_HEAVY_MODEL:-${PI_EVAL_TEST_MODEL:-}}"
TIMEOUT="${PI_EVAL_TIMEOUT:-300}"
MAX_CONCURRENCY="${PI_EVAL_MAX_CONCURRENCY:-4}"
POLICY="${PI_EVAL_POLICY:-}"
WORKFLOW_EXT="${PI_EVAL_WORKFLOW_EXT:-$ROOT_DIR/extensions/workflow.ts}"
REPORT_FILE="${PI_EVAL_REPORT:-$SCRIPT_DIR/results/report-$(date +%Y%m%d-%H%M%S).json}"

# --- Parse CLI ---
usage() {
  cat <<EOF
Usage: run.sh [options] [all|all-with-edge|<eval-name>]

Options:
  --test-model <model>     Model to run workflow with (required unless set in .env)
  --judge-model <model>    Model to evaluate output with (required unless set in .env)
  --timeout <seconds>      Per-eval timeout (default: 300)
  --light-model <model>    Model ref prompt guidance for cheap subagents
  --medium-model <model>   Model ref prompt guidance for normal subagents
  --heavy-model <model>    Model ref prompt guidance for synthesis/team/planning
  --policy <json>          Workflow policy JSON
  --workflow-ext <path>    Path to workflow extension (default: ../extensions/workflow.ts)
  --report <path>          Report output path
  --max-concurrency <n>    Max concurrent subagents (default: 4)
  --help, -h               Show this help

Selectors:
  all              Run Type B judge-evaluated evals (default)
  all-with-edge    Run Type B evals plus the slower Type A edge-case suite
  <eval-name>      Run one eval, e.g. 01-basic-scan or 14-edge-cases

Model references are provider-agnostic. Use any model id in your Pi registry.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test-model)       TEST_MODEL="$2"; shift 2 ;;
    --judge-model)      JUDGE_MODEL="$2"; shift 2 ;;
    --timeout)          TIMEOUT="$2"; shift 2 ;;
    --light-model)      LIGHT_MODEL="$2"; shift 2 ;;
    --medium-model)     MEDIUM_MODEL="$2"; shift 2 ;;
    --heavy-model)      HEAVY_MODEL="$2"; shift 2 ;;
    --policy)           POLICY="$2"; shift 2 ;;
    --workflow-ext)     WORKFLOW_EXT="$2"; shift 2 ;;
    --report)           REPORT_FILE="$2"; shift 2 ;;
    --max-concurrency)  MAX_CONCURRENCY="$2"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    --)                 shift; break ;;
    *)                  break ;;
  esac
done

EVAL_FILTER="${1:-all}"
# all = Type B evals only (main suite). all-with-edge = include slower Type A edge suite.

# --- Validate ---
if [ -z "$TEST_MODEL" ]; then
  echo "ERROR: --test-model is required (or set PI_EVAL_TEST_MODEL in .env)" >&2
  exit 1
fi
if [ -z "$JUDGE_MODEL" ]; then
  echo "ERROR: --judge-model is required (or set PI_EVAL_JUDGE_MODEL in .env)" >&2
  exit 1
fi
if [ -z "$LIGHT_MODEL" ] || [ -z "$MEDIUM_MODEL" ] || [ -z "$HEAVY_MODEL" ]; then
  echo "ERROR: --light-model, --medium-model, and --heavy-model are required (or set PI_EVAL_LIGHT_MODEL/MEDIUM_MODEL/HEAVY_MODEL in .env)" >&2
  echo "       If you want one model for all subagents, set all three to the same provider/model ref." >&2
  exit 1
fi
if [ ! -f "$WORKFLOW_EXT" ]; then
  echo "ERROR: workflow extension not found at $WORKFLOW_EXT" >&2
  exit 1
fi

# --- Setup ---
WORKDIR="$(create_workdir)"
trap 'destroy_workdir "$WORKDIR"; exit' EXIT

PI_BASE_ARGS=(
  -p
  --no-extensions
  --no-skills
  --no-context-files
  --no-prompt-templates
  -e "$WORKFLOW_EXT"
  --model "$TEST_MODEL"
)

# When policy is set, only expose the workflow tool
if [ -n "$POLICY" ]; then
  PI_BASE_ARGS+=(--tools workflow)
else
  # Without policy, just ensure workflow is available
  PI_BASE_ARGS+=(--tools workflow)
fi

echo "=== pi-dynamic-workflows eval runner ==="
echo "  Test model:  $TEST_MODEL"
echo "  Judge model: $JUDGE_MODEL"
echo "  Timeout:     ${TIMEOUT}s"
echo "  Light model: $LIGHT_MODEL"
echo "  Medium model:$MEDIUM_MODEL"
echo "  Heavy model: $HEAVY_MODEL"
echo "  Extension:   $WORKFLOW_EXT"
echo "  Workdir:     $WORKDIR"
echo "  Filter:      $EVAL_FILTER"
echo ""

# --- Eval Registry ---
# Format: name|type|prompt_file|patterns_file|rubric_file
#   type: A (pattern-match, regression only), B (judge — tests tool copy quality)
#   Type B evals: the LLM receives a natural-language request and must
#   discover + invoke the workflow tool with correct API usage.
#   Type A evals: fast pattern-match checks for error paths. The edge case
#   suite covers parser/validation errors the unit tests can't reach.
EVAL_DEFS=(
  # Type B — LLM discovers + invokes workflow tool from natural language
  "01-basic-scan|B|$SCRIPT_DIR/prompts/01-basic-scan.txt||$SCRIPT_DIR/rubrics/01-basic-scan.json"
  "02-structured-output|B|$SCRIPT_DIR/prompts/02-structured-output.txt||$SCRIPT_DIR/rubrics/02-structured-output.json"
  "03-gate-retry|B|$SCRIPT_DIR/prompts/03-gate-retry.txt||$SCRIPT_DIR/rubrics/03-gate-retry.json"
  "04-team-mailbox|B|$SCRIPT_DIR/prompts/04-team-mailbox.txt||$SCRIPT_DIR/rubrics/04-team-mailbox.json"
  "05-parallel-fanout|B|$SCRIPT_DIR/prompts/05-parallel-fanout.txt||$SCRIPT_DIR/rubrics/05-parallel-fanout.json"
  "06-pipeline|B|$SCRIPT_DIR/prompts/06-pipeline.txt||$SCRIPT_DIR/rubrics/06-pipeline.json"
  "07-side-effect-safety|B|$SCRIPT_DIR/prompts/07-side-effect-safety.txt||$SCRIPT_DIR/rubrics/07-side-effect-safety.json"
  "08-roles|B|$SCRIPT_DIR/prompts/08-roles.txt||$SCRIPT_DIR/rubrics/08-roles.json"
  "09-full-integration|B|$SCRIPT_DIR/prompts/09-full-integration.txt||$SCRIPT_DIR/rubrics/09-full-integration.json"
  "10-error-recovery|B|$SCRIPT_DIR/prompts/10-error-recovery.txt||$SCRIPT_DIR/rubrics/10-error-recovery.json"

  # Type A — fast regression for error paths (runtime errors, parse errors)
  "14-edge-cases|edge|$SCRIPT_DIR/prompts/14-edge-cases.txt|$SCRIPT_DIR/expected/patterns/14-edge-cases.patterns|"
)

# --- Helper functions ---

# Run pi -p and capture output + exit code
run_pi() {
  local prompt="$1"
  local cwd="${2:-$WORKDIR}"
  local extra_args=("${@:3}")

  local output exit_code
  set +e
  local guided_prompt
  guided_prompt=$(cat <<PROMPT
${prompt}

Important eval constraints:
- Use the workflow tool; do not only describe a workflow.
- Use registerPhase() for top-level phases.
- Use explicit provider/model refs in every agent/spawn call:
  - cheap/simple subagents: ${LIGHT_MODEL}
  - normal/code-review subagents: ${MEDIUM_MODEL}
  - synthesis/team/planning subagents: ${HEAVY_MODEL}
- Do not use deprecated weight or stream options.
- Use handoff() only within phase bodies; cross-phase data flows via registerPhase input/output.
PROMPT
)
  output="$(cd "$cwd" && timeout "$TIMEOUT" pi --mode json "${PI_BASE_ARGS[@]}" "${extra_args[@]}" "$guided_prompt" 2>&1)"
  exit_code=$?
  set -e
  echo "$output"
  return "$exit_code"
}

# Type A: pattern-match eval
run_type_a() {
  local name="$1" prompt_file="$2" patterns_file="$3"

  if [ ! -f "$prompt_file" ]; then
    echo "ERROR: prompt file not found: $prompt_file" >&2
    echo "{\"overall\":\"ERROR\",\"eval\":\"$name\",\"type\":\"A\",\"checks\":[{\"pattern\":\"infra\",\"result\":\"FAIL\",\"reasoning\":\"prompt file missing\"}]}"
    return
  fi

  local prompt_text="$(cat "$prompt_file")"

  echo "  [$name] Running..." >&2
  local output exit_code
  output="$(run_pi "$prompt_text")"
  exit_code=$?

  local checks_json='['
  local all_pass=true

  if [ -f "$patterns_file" ]; then
    while IFS= read -r raw_pattern; do
      # Skip empty lines and comments
      [[ -z "$raw_pattern" || "$raw_pattern" == \#* ]] && continue

      local negate=false
      local pattern="$raw_pattern"
      # ! prefix means pattern must NOT be present
      if [[ "$raw_pattern" == !* ]]; then
        negate=true
        pattern="${raw_pattern#!}"
      fi

      # Escape double quotes and backslashes for JSON
      local escaped_pattern
      escaped_pattern="$(echo "$raw_pattern" | sed 's/\\/\\\\/g; s/"/\\"/g')"

      local found
      if echo "$output" | grep -qP "$pattern" 2>/dev/null; then
        found=true
      else
        found=false
      fi

      if [ "$negate" = true ]; then
        if [ "$found" = false ]; then
          checks_json+='{"pattern":"!'"$escaped_pattern"'","result":"PASS"},'
        else
          checks_json+='{"pattern":"!'"$escaped_pattern"'","result":"FAIL","reasoning":"unexpected pattern found in output"},'
          all_pass=false
        fi
      else
        if [ "$found" = true ]; then
          checks_json+='{"pattern":"'"$escaped_pattern"'","result":"PASS"},'
        else
          checks_json+='{"pattern":"'"$escaped_pattern"'","result":"FAIL","reasoning":"pattern not found in output"},'
          all_pass=false
        fi
      fi
    done < "$patterns_file"
  else
    checks_json+='{"pattern":"no_patterns_file","result":"SKIP","reasoning":"no patterns file found"},'
  fi

  checks_json="${checks_json%,}]"

  local overall="$([ "$all_pass" = true ] && echo "PASS" || echo "FAIL")"

  # Save output for debugging
  local log_dir="$SCRIPT_DIR/results/logs"
  mkdir -p "$log_dir"
  echo "$output" > "$log_dir/${name}.log"

  local result
  result="{\"eval\":\"$name\",\"type\":\"A\",\"overall\":\"$overall\",\"exit_code\":$exit_code,\"checks\":$checks_json}"
  echo "  [$name] $overall" >&2
  echo "$result"
}

# Type B: judge-only eval
run_type_b() {
  local name="$1" prompt_file="$2" rubric_file="$3"

  if [ ! -f "$prompt_file" ]; then
    echo "ERROR: prompt file not found: $prompt_file" >&2
    echo "{\"overall\":\"ERROR\",\"eval\":\"$name\",\"type\":\"B\",\"judge\":{\"overall\":\"ERROR\",\"criteria\":[{\"name\":\"infra\",\"result\":\"FAIL\",\"reasoning\":\"prompt file missing\"}]}}"
    return
  fi

  local prompt_text="$(cat "$prompt_file")"

  echo "  [$name] Running..." >&2
  local output
  output="$(run_pi "$prompt_text")"

  # Save output for debugging
  local log_dir="$SCRIPT_DIR/results/logs"
  mkdir -p "$log_dir"
  echo "$output" > "$log_dir/${name}.log"

  echo "  [$name] Judging..." >&2
  local judge_json
  judge_json="$(judge_eval "$name" "$rubric_file" "$output" "$prompt_text")"

  local overall
  overall="$(echo "$judge_json" | jq -r '.overall // "ERROR"')"
  echo "  [$name] $overall" >&2

  echo "{\"eval\":\"$name\",\"type\":\"B\",\"overall\":\"$overall\",\"judge\":$judge_json}"
}

# Hybrid: Type A first, then judge only if A passes
run_hybrid() {
  local name="$1" prompt_file="$2" patterns_file="$3" rubric_file="$4"

  local a_result
  a_result="$(run_type_a "$name" "$prompt_file" "$patterns_file")"
  local a_overall
  a_overall="$(echo "$a_result" | jq -r '.overall // "ERROR"')"

  if [ "$a_overall" = "FAIL" ] || [ "$a_overall" = "ERROR" ]; then
    # Type A failed — report and skip judge
    echo "$a_result" | jq --arg overall "$a_overall" '. + {overall: $overall}'
  else
    # Type A passed — run judge
    local prompt_text="$(cat "$prompt_file")"
    local output
    output="$(cat "$SCRIPT_DIR/results/logs/${name}.log" 2>/dev/null || echo "")"

    echo "  [$name] Judging..." >&2
    local judge_json
    judge_json="$(judge_eval "$name" "$rubric_file" "$output" "$prompt_text")"

    local b_overall
    b_overall="$(echo "$judge_json" | jq -r '.overall // "ERROR"')"

    # Merge: overall is judge's verdict (since structural checks already passed)
    echo "{\"eval\":\"$name\",\"type\":\"hybrid\",\"overall\":\"$b_overall\",\"type_a_checks\":$a_result,\"judge\":$judge_json}"
  fi
}

# --- Edge case eval (special: runs multiple sub-cases) ---
run_edge_cases() {
  local name="$1" prompt_file="$2" patterns_file="$3"

  # Read the prompt file: each line is a sub-case definition
  # Format: subcase_name|prompt_text
  # Or for file-based: subcase_name|@filepath
  # Blank lines and # comments skipped

  if [ ! -f "$prompt_file" ]; then
    echo "ERROR: edge cases file not found: $prompt_file" >&2
    echo "{\"overall\":\"ERROR\",\"eval\":\"$name\",\"type\":\"A\",\"checks\":[]}"
    return
  fi

  local all_pass=true
  local sub_results='['

  while IFS='|' read -r sub_name sub_prompt_raw; do
    [[ -z "$sub_name" || "$sub_name" == \#* ]] && continue

    # Resolve @file references
    local sub_prompt
    if [[ "$sub_prompt_raw" == @* ]]; then
      local ref_file="${sub_prompt_raw#@}"
      # Resolve relative to the edge-cases prompt file directory
      local edge_dir
      edge_dir="$(dirname "$prompt_file")"
      if [ -f "$edge_dir/$ref_file" ]; then
        sub_prompt="$(cat "$edge_dir/$ref_file")"
      elif [ -f "$SCRIPT_DIR/prompts/14-edge-cases/$ref_file" ]; then
        sub_prompt="$(cat "$SCRIPT_DIR/prompts/14-edge-cases/$ref_file")"
      else
        sub_results+='{"subcase":"'"$sub_name"'","result":"FAIL","reasoning":"referenced file not found: '"$ref_file"'"},'
        all_pass=false
        continue
      fi
    else
      sub_prompt="$sub_prompt_raw"
    fi

    echo "  [$name/$sub_name] Running..." >&2

    # Run pi with the sub-prompt
    local output exit_code
    set +e
    output="$(cd "$WORKDIR" && timeout 30 pi "${PI_BASE_ARGS[@]}" "$sub_prompt" 2>&1)"
    exit_code=$?
    set -e

    # Check against expected pattern for this sub-case
    local sub_patterns_file="$SCRIPT_DIR/expected/patterns/14-edge-cases/${sub_name}.pattern"
    local sub_pass=true
    local sub_fail_reason=""

    if [ -f "$sub_patterns_file" ]; then
      while IFS= read -r pattern; do
        [[ -z "$pattern" || "$pattern" == \#* ]] && continue
        if ! echo "$output" | grep -qP "$pattern" 2>/dev/null; then
          sub_pass=false
          sub_fail_reason="expected pattern not found: $pattern"
          break
        fi
      done < "$sub_patterns_file"
    else
      sub_pass=false
      sub_fail_reason="no pattern file found for sub-case $sub_name"
    fi

    if [ "$sub_pass" = true ]; then
      sub_results+='{"subcase":"'"$sub_name"'","result":"PASS"},'
      echo "    PASS" >&2
    else
      sub_results+='{"subcase":"'"$sub_name"'","result":"FAIL","reasoning":"'"$sub_fail_reason"'"},'
      all_pass=false
      echo "    FAIL ($sub_fail_reason)" >&2

      # Save failing output for debugging
      mkdir -p "$SCRIPT_DIR/results/logs"
      echo "$output" > "$SCRIPT_DIR/results/logs/${name}-${sub_name}.log"
    fi
  done < "$prompt_file"

  sub_results="${sub_results%,}]"
  local overall="$([ "$all_pass" = true ] && echo "PASS" || echo "FAIL")"
  echo "  [$name] $overall" >&2
  echo "{\"eval\":\"$name\",\"type\":\"A\",\"overall\":\"$overall\",\"sub_results\":$sub_results}"
}

# --- Main ---
RESULTS='['

for def in "${EVAL_DEFS[@]}"; do
  IFS='|' read -r name type prompt_file patterns_file rubric_file <<< "$def"

  # Apply filter
  if [ "$EVAL_FILTER" = "all" ] && [ "$type" = "edge" ]; then
    continue
  fi
  if [ "$EVAL_FILTER" != "all" ] && [ "$EVAL_FILTER" != "all-with-edge" ] && [ "$name" != "$EVAL_FILTER" ]; then
    continue
  fi

  case "$type" in
    A)
      result="$(run_type_a "$name" "$prompt_file" "$patterns_file")"
      ;;
    B)
      result="$(run_type_b "$name" "$prompt_file" "$rubric_file")"
      ;;
    hybrid)
      result="$(run_hybrid "$name" "$prompt_file" "$patterns_file" "$rubric_file")"
      ;;
    edge)
      result="$(run_edge_cases "$name" "$prompt_file" "$patterns_file")"
      ;;
    *)
      echo "WARNING: unknown eval type '$type' for $name" >&2
      result="{\"eval\":\"$name\",\"type\":\"$type\",\"overall\":\"ERROR\"}"
      ;;
  esac

  RESULTS+="$result,"
done

RESULTS="${RESULTS%,}]"

# --- Output ---
echo ""
print_summary "$RESULTS"
write_report "$RESULTS" "$REPORT_FILE"

# Exit code: non-zero if any eval failed
failed_count="$(echo "$RESULTS" | jq '[.[] | select(.overall != "PASS")] | length')"
if [ "$failed_count" -gt 0 ]; then
  exit 1
fi
exit 0