#!/usr/bin/env bash
# Unified test runner for all layers: backend, frontend, desktop.
# Exits with non-zero if any layer fails.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILURES=0

echo "═══════════════════════════════════════════════════════"
echo " Backend (Python / pytest)"
echo "═══════════════════════════════════════════════════════"
if [ -d "$ROOT/apps/backend/.venv" ]; then
  (
    cd "$ROOT/apps/backend"
    source .venv/bin/activate
    python -m pytest tests/ -q --tb=short "$@"
  ) || FAILURES=$((FAILURES + 1))
else
  echo "⚠ Backend .venv not found — skipping. Run: cd apps/backend && uv venv && uv pip install -e '.[dev]'"
  FAILURES=$((FAILURES + 1))
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo " Frontend (TypeScript / vitest)"
echo "═══════════════════════════════════════════════════════"
(
  cd "$ROOT/apps/frontend"
  npx vitest run
) || FAILURES=$((FAILURES + 1))

echo ""
echo "═══════════════════════════════════════════════════════"
echo " Desktop (Rust / cargo test)"
echo "═══════════════════════════════════════════════════════"
(
  cd "$ROOT/apps/desktop/src-tauri"
  cargo test
) || FAILURES=$((FAILURES + 1))

echo ""
echo "═══════════════════════════════════════════════════════"
if [ $FAILURES -eq 0 ]; then
  echo " ✓ All layers passed"
else
  echo " ✗ $FAILURES layer(s) failed"
  exit 1
fi
