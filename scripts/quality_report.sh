#!/usr/bin/env bash
# Quality Report — quantifiable metrics for all layers.
# Outputs a structured summary suitable for CI dashboards and release gates.
# Exit code: 0 if all gates pass, 1 if any threshold is breached.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACTS="$ROOT/artifacts"
mkdir -p "$ARTIFACTS"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Thresholds (release gates)
BACKEND_COV_MIN=88
FRONTEND_COV_MIN=78
BACKEND_TEST_MIN=250
FRONTEND_TEST_MIN=180
DESKTOP_TEST_MIN=10
E2E_SPEC_MIN=5

GATE_FAILURES=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; GATE_FAILURES=$((GATE_FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }

echo "══════════════════════════════════════════════════════════════"
echo " Zvec Studio — Quality Report"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ─── Backend ───────────────────────────────────────────────────────
echo "┌─ Backend (Python / pytest)"
echo "│"

BACKEND_RESULT=$(cd "$ROOT/apps/backend" && source .venv/bin/activate && python -m pytest tests/ -q --tb=no --no-header --co 2>/dev/null | tail -1)
BACKEND_TESTS=$(echo "$BACKEND_RESULT" | grep -oE '[0-9]+' | head -1)
BACKEND_TESTS=${BACKEND_TESTS:-0}

if [ "$BACKEND_TESTS" -ge "$BACKEND_TEST_MIN" ]; then
  pass "Test count: $BACKEND_TESTS (min: $BACKEND_TEST_MIN)"
else
  fail "Test count: $BACKEND_TESTS (min: $BACKEND_TEST_MIN)"
fi

# Run with coverage
BACKEND_COV_OUT=$(cd "$ROOT/apps/backend" && source .venv/bin/activate && python -m pytest tests/ -q --tb=no --no-header --cov=zvec_studio --cov-report=term-missing --cov-fail-under=$BACKEND_COV_MIN 2>&1)
BACKEND_COV_EXIT=$?
BACKEND_COV=$(echo "$BACKEND_COV_OUT" | grep "^TOTAL" | awk '{print $NF}' | tr -d '%')
BACKEND_COV=${BACKEND_COV:-0}

BACKEND_PASS=$(echo "$BACKEND_COV_OUT" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')
BACKEND_FAIL=$(echo "$BACKEND_COV_OUT" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
BACKEND_FAIL=${BACKEND_FAIL:-0}

if [ "$BACKEND_FAIL" -eq 0 ]; then
  pass "All tests passing: ${BACKEND_PASS:-$BACKEND_TESTS} passed, 0 failed"
else
  fail "Test failures: $BACKEND_FAIL failed"
fi

if [ "$BACKEND_COV_EXIT" -eq 0 ]; then
  pass "Coverage: ${BACKEND_COV}% (min: ${BACKEND_COV_MIN}%)"
else
  if [ "$(echo "$BACKEND_COV < $BACKEND_COV_MIN" | bc -l 2>/dev/null || echo 1)" = "1" ] && [ "$BACKEND_COV" != "0" ]; then
    fail "Coverage: ${BACKEND_COV}% (min: ${BACKEND_COV_MIN}%)"
  else
    pass "Coverage: ${BACKEND_COV}% (min: ${BACKEND_COV_MIN}%)"
  fi
fi

echo "│"

# ─── Frontend ──────────────────────────────────────────────────────
echo "├─ Frontend (TypeScript / vitest)"
echo "│"

FRONTEND_OUT=$(cd "$ROOT/apps/frontend" && npx vitest run --coverage --coverage.reporter=text 2>&1)
FRONTEND_TESTS=$(echo "$FRONTEND_OUT" | grep "Tests" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')
FRONTEND_TESTS=${FRONTEND_TESTS:-0}
FRONTEND_FILES=$(echo "$FRONTEND_OUT" | grep "Test Files" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')
FRONTEND_FILES=${FRONTEND_FILES:-0}
FRONTEND_COV=$(echo "$FRONTEND_OUT" | grep "^All files" | awk '{print $4}')
FRONTEND_COV=${FRONTEND_COV:-0}

if [ "$FRONTEND_TESTS" -ge "$FRONTEND_TEST_MIN" ]; then
  pass "Test count: $FRONTEND_TESTS across $FRONTEND_FILES files (min: $FRONTEND_TEST_MIN)"
else
  fail "Test count: $FRONTEND_TESTS across $FRONTEND_FILES files (min: $FRONTEND_TEST_MIN)"
fi

FRONTEND_FAIL=$(echo "$FRONTEND_OUT" | grep "Tests" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
FRONTEND_FAIL=${FRONTEND_FAIL:-0}
if [ "$FRONTEND_FAIL" -eq 0 ]; then
  pass "All tests passing: $FRONTEND_TESTS passed, 0 failed"
else
  fail "Test failures: $FRONTEND_FAIL failed"
fi

# Compare coverage float
FRONTEND_COV_INT=$(echo "$FRONTEND_COV" | cut -d. -f1)
if [ "${FRONTEND_COV_INT:-0}" -ge "$FRONTEND_COV_MIN" ]; then
  pass "Coverage: ${FRONTEND_COV}% (min: ${FRONTEND_COV_MIN}%)"
else
  fail "Coverage: ${FRONTEND_COV}% (min: ${FRONTEND_COV_MIN}%)"
fi

# Typecheck
TYPECHECK_OUT=$(cd "$ROOT/apps/frontend" && npx tsc --noEmit 2>&1)
TYPECHECK_EXIT=$?
if [ "$TYPECHECK_EXIT" -eq 0 ]; then
  pass "TypeScript: zero type errors"
else
  TYPECHECK_ERRORS=$(echo "$TYPECHECK_OUT" | grep -c "error TS")
  fail "TypeScript: $TYPECHECK_ERRORS type errors"
fi

echo "│"

# ─── Desktop ──────────────────────────────────────────────────────
echo "├─ Desktop (Rust / cargo test)"
echo "│"

DESKTOP_OUT=$(cd "$ROOT/apps/desktop/src-tauri" && cargo test 2>&1)
DESKTOP_TESTS=$(echo "$DESKTOP_OUT" | grep "test result:" | head -1 | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')
DESKTOP_TESTS=${DESKTOP_TESTS:-0}
DESKTOP_FAIL=$(echo "$DESKTOP_OUT" | grep "test result:" | head -1 | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
DESKTOP_FAIL=${DESKTOP_FAIL:-0}

if [ "$DESKTOP_TESTS" -ge "$DESKTOP_TEST_MIN" ]; then
  pass "Test count: $DESKTOP_TESTS (min: $DESKTOP_TEST_MIN)"
else
  fail "Test count: $DESKTOP_TESTS (min: $DESKTOP_TEST_MIN)"
fi

if [ "$DESKTOP_FAIL" -eq 0 ]; then
  pass "All tests passing: $DESKTOP_TESTS passed, 0 failed"
else
  fail "Test failures: $DESKTOP_FAIL failed"
fi

# Cargo check (compilation)
CARGO_CHECK=$(cd "$ROOT/apps/desktop/src-tauri" && cargo check 2>&1)
if [ $? -eq 0 ]; then
  pass "Rust: compiles without errors"
else
  fail "Rust: compilation errors"
fi

echo "│"

# ─── E2E ──────────────────────────────────────────────────────────
echo "├─ E2E (Playwright)"
echo "│"

E2E_SPECS=$(find "$ROOT/apps/frontend/tests/e2e" -name "*.spec.ts" 2>/dev/null | wc -l | tr -d ' ')
E2E_TEST_COUNT=$(grep -r "test(" "$ROOT/apps/frontend/tests/e2e/" 2>/dev/null | grep -v "test.describe\|test.beforeEach\|test.afterEach" | wc -l | tr -d ' ')

if [ "$E2E_TEST_COUNT" -ge "$E2E_SPEC_MIN" ]; then
  pass "E2E specs: $E2E_TEST_COUNT tests in $E2E_SPECS file(s) (min: $E2E_SPEC_MIN)"
else
  fail "E2E specs: $E2E_TEST_COUNT tests in $E2E_SPECS file(s) (min: $E2E_SPEC_MIN)"
fi

echo "│"

# ─── Summary ──────────────────────────────────────────────────────
echo "└─ Summary"
echo ""
echo "┌────────────────────────────────────────────────────────────┐"
printf "│  %-20s %8s %8s %10s     │\n" "Layer" "Tests" "Coverage" "Status"
echo "│──────────────────────────────────────────────────────────  │"
B_STATUS="✓"; [ "$BACKEND_FAIL" -ne 0 ] && B_STATUS="✗"
F_STATUS="✓"; [ "$FRONTEND_FAIL" -ne 0 ] && F_STATUS="✗"
D_STATUS="✓"; [ "$DESKTOP_FAIL" -ne 0 ] && D_STATUS="✗"
printf "│  %-20s %8s %8s %10s     │\n" "Backend (Python)" "$BACKEND_TESTS" "${BACKEND_COV}%" "$B_STATUS"
printf "│  %-20s %8s %8s %10s     │\n" "Frontend (TS)" "$FRONTEND_TESTS" "${FRONTEND_COV}%" "$F_STATUS"
printf "│  %-20s %8s %8s %10s     │\n" "Desktop (Rust)" "$DESKTOP_TESTS" "—" "$D_STATUS"
printf "│  %-20s %8s %8s %10s     │\n" "E2E (Playwright)" "$E2E_TEST_COUNT" "—" "—"
echo "└────────────────────────────────────────────────────────────┘"
echo ""

# Write machine-readable JSON
cat > "$ARTIFACTS/quality-metrics.json" <<ENDJSON
{
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "backend": {
    "tests": $BACKEND_TESTS,
    "failures": $BACKEND_FAIL,
    "coverage_pct": $BACKEND_COV
  },
  "frontend": {
    "tests": $FRONTEND_TESTS,
    "files": $FRONTEND_FILES,
    "failures": $FRONTEND_FAIL,
    "coverage_pct": $FRONTEND_COV
  },
  "desktop": {
    "tests": $DESKTOP_TESTS,
    "failures": $DESKTOP_FAIL
  },
  "e2e": {
    "spec_files": $E2E_SPECS,
    "test_count": $E2E_TEST_COUNT
  },
  "gates": {
    "failures": $GATE_FAILURES,
    "thresholds": {
      "backend_coverage_min": $BACKEND_COV_MIN,
      "frontend_coverage_min": $FRONTEND_COV_MIN,
      "backend_tests_min": $BACKEND_TEST_MIN,
      "frontend_tests_min": $FRONTEND_TEST_MIN,
      "desktop_tests_min": $DESKTOP_TEST_MIN,
      "e2e_specs_min": $E2E_SPEC_MIN
    }
  }
}
ENDJSON

echo "Metrics written to: artifacts/quality-metrics.json"
echo ""

if [ "$GATE_FAILURES" -eq 0 ]; then
  echo -e "${GREEN}══ ALL QUALITY GATES PASSED ═══════════════════════════════════${NC}"
  exit 0
else
  echo -e "${RED}══ $GATE_FAILURES QUALITY GATE(S) BREACHED ═════════════════════════════${NC}"
  exit 1
fi
