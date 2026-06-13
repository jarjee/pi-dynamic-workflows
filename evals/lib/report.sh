#!/usr/bin/env bash
# report.sh — Format and write eval reports.

set -euo pipefail

# Print a summary table from a JSON results array
print_summary() {
  local results_json="$1"

  echo ""
  echo "============================================"
  echo "  pi-dynamic-workflows Eval Results"
  echo "============================================"
  echo ""

  local total=0 passed=0 failed=0 errored=0

  while IFS=$'\t' read -r name type overall; do
    total=$((total + 1))
    case "$overall" in
      PASS)   passed=$((passed + 1));  icon="✓";;
      FAIL)   failed=$((failed + 1));  icon="✗";;
      ERROR)  errored=$((errored + 1)); icon="!";;
      *)      icon="?";;
    esac
    printf "  %s  %-45s  %s\n" "$icon" "$name" "$overall"
  done < <(echo "$results_json" | jq -r '.[] | "\(.eval)\t\(.type)\t\(.overall)"')

  echo ""
  echo "  Total: $total | Passed: $passed | Failed: $failed | Errors: $errored"
  echo ""
}

# Write full JSON report to file
write_report() {
  local results_json="$1"
  local report_file="$2"

  mkdir -p "$(dirname "$report_file")"

  # Wrap in a report envelope
  jq -n \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg test_model "${TEST_MODEL:-unknown}" \
    --arg judge_model "${JUDGE_MODEL:-unknown}" \
    --argjson results "$results_json" \
    '{
      timestamp: $timestamp,
      test_model: $test_model,
      judge_model: $judge_model,
      summary: {
        total: ($results | length),
        passed: ($results | map(select(.overall == "PASS")) | length),
        failed: ($results | map(select(.overall == "FAIL")) | length),
        errors: ($results | map(select(.overall == "ERROR")) | length),
      },
      results: $results
    }' > "$report_file"

  echo "Full report written to $report_file" >&2
}