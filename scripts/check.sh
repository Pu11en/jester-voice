#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -d node_modules ]]; then
  npm ci --silent
fi
npm test --silent

JESTER_PYTHON="${JESTER_PYTHON:-/home/drewp/main-projects/jester-voice/bench/.venv/bin/python}"
if ! "$JESTER_PYTHON" -m pytest --version >/dev/null 2>&1; then
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$JESTER_PYTHON" pytest
  else
    echo "pytest is missing and uv is unavailable to install it into the configured Python environment" >&2
    exit 1
  fi
fi
"$JESTER_PYTHON" -m pytest -q worker/tests
