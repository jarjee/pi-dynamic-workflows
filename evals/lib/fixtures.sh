#!/usr/bin/env bash
# fixtures.sh — Create and destroy temp fixtures for evals.
# Fixtures are read-only sample files for workflow subagents to analyze.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"

# Ensure sample project fixtures exist (idempotent)
ensure_fixtures() {
  local target="$1"  # directory to copy fixtures into

  if [ ! -d "$FIXTURES_DIR/sample-project" ]; then
    echo "ERROR: fixtures/sample-project/ not found at $FIXTURES_DIR/sample-project" >&2
    return 1
  fi

  mkdir -p "$target"
  cp -r "$FIXTURES_DIR/sample-project/." "$target/sample-project/"
  echo "Fixtures copied to $target/sample-project/" >&2
}

# Create a temp working directory with fixtures
create_workdir() {
  local workdir
  workdir="$(mktemp -d)"
  ensure_fixtures "$workdir"
  echo "$workdir"
}

# Clean up a workdir
destroy_workdir() {
  local workdir="$1"
  if [ -d "$workdir" ]; then
    rm -rf "$workdir"
  fi
}