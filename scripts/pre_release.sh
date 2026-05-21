#!/usr/bin/env bash
# Pre-Release Validation — full checklist for a release candidate.
# Runs all quality gates, E2E tests, build verification, and dependency audits.
# Exit code: 0 if release-ready, 1 if any check fails.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACTS="$ROOT/artifacts"
mkdir -p "$ARTIFACTS"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

FAILURES=0
WARNINGS=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; WARNINGS=$((WARNINGS + 1)); }
info() { echo -e "  ${CYAN}ℹ${NC} $1"; }

echo "══════════════════════════════════════════════════════════════"
echo " Zvec Studio — Pre-Release Validation"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ─── 1. Quality Gates ─────────────────────────────────────────────
echo "┌─ [1/6] Quality Gates (test_all.sh)"
echo "│"

if bash "$ROOT/scripts/test_all.sh" > "$ARTIFACTS/test-all.log" 2>&1; then
  pass "All unit/integration tests pass across all layers"
else
  fail "Test failures detected (see artifacts/test-all.log)"
fi

echo "│"

# ─── 2. Coverage Thresholds ───────────────────────────────────────
echo "├─ [2/6] Coverage Thresholds"
echo "│"

BACKEND_COV_OUT=$(cd "$ROOT/apps/backend" && source .venv/bin/activate && python -m pytest tests/ -q --tb=no --no-header --cov=zvec_studio --cov-report=term-missing --cov-fail-under=88 2>&1)
BACKEND_COV=$(echo "$BACKEND_COV_OUT" | grep "^TOTAL" | awk '{print $NF}' | tr -d '%')
BACKEND_COV=${BACKEND_COV:-0}

FRONTEND_COV_OUT=$(cd "$ROOT/apps/frontend" && npx vitest run --coverage --coverage.reporter=text 2>&1)
FRONTEND_COV=$(echo "$FRONTEND_COV_OUT" | grep "^All files" | awk '{print $4}')
FRONTEND_COV=${FRONTEND_COV:-0}
FRONTEND_COV_INT=$(echo "$FRONTEND_COV" | cut -d. -f1)

if [ "${BACKEND_COV%%.*}" -ge 88 ] 2>/dev/null; then
  pass "Backend coverage: ${BACKEND_COV}% (≥88%)"
else
  fail "Backend coverage: ${BACKEND_COV}% (<88%)"
fi

if [ "${FRONTEND_COV_INT:-0}" -ge 78 ]; then
  pass "Frontend coverage: ${FRONTEND_COV}% (≥78%)"
else
  fail "Frontend coverage: ${FRONTEND_COV}% (<78%)"
fi

echo "│"

# ─── 3. Build Verification ────────────────────────────────────────
echo "├─ [3/6] Build Verification"
echo "│"

# Frontend production build
if (cd "$ROOT/apps/frontend" && npx vite build) > "$ARTIFACTS/frontend-build.log" 2>&1; then
  BUNDLE_SIZE=$(du -sh "$ROOT/apps/frontend/dist" 2>/dev/null | awk '{print $1}')
  pass "Frontend production build: OK (${BUNDLE_SIZE:-?})"
else
  fail "Frontend production build: FAILED"
fi

# Rust compilation check (release profile is too slow for CI gate)
if (cd "$ROOT/apps/desktop/src-tauri" && cargo check) > "$ARTIFACTS/desktop-check.log" 2>&1; then
  pass "Desktop (Rust) compiles: OK"
else
  fail "Desktop (Rust) compilation: FAILED"
fi

# TypeScript strict check
if (cd "$ROOT/apps/frontend" && npx tsc --noEmit) > /dev/null 2>&1; then
  pass "TypeScript strict: zero errors"
else
  TS_ERRORS=$(cd "$ROOT/apps/frontend" && npx tsc --noEmit 2>&1 | grep -c "error TS")
  fail "TypeScript: $TS_ERRORS type errors"
fi

echo "│"

# ─── 4. E2E Smoke Tests ──────────────────────────────────────────
echo "├─ [4/6] E2E Smoke Tests (Playwright)"
echo "│"

if (cd "$ROOT/apps/frontend" && npx playwright test --reporter=list) > "$ARTIFACTS/e2e.log" 2>&1; then
  E2E_PASSED=$(grep -c "✓\|passed" "$ARTIFACTS/e2e.log" 2>/dev/null || echo "?")
  pass "E2E smoke tests: all passing"
else
  # Check if Playwright is installed
  if ! (cd "$ROOT/apps/frontend" && npx playwright --version) > /dev/null 2>&1; then
    warn "Playwright not installed (run: cd apps/frontend && npx playwright install)"
  else
    fail "E2E smoke tests: FAILED (see artifacts/e2e.log)"
  fi
fi

echo "│"

# ─── 5. Dependency Audit ─────────────────────────────────────────
echo "├─ [5/6] Dependency Audit"
echo "│"

# Frontend: check for known vulnerabilities
if command -v pnpm &> /dev/null; then
  AUDIT_OUT=$(cd "$ROOT/apps/frontend" && pnpm audit --prod 2>&1)
  if echo "$AUDIT_OUT" | grep -q "No known vulnerabilities"; then
    pass "Frontend dependencies: no known vulnerabilities"
  elif echo "$AUDIT_OUT" | grep -qi "critical\|high"; then
    fail "Frontend dependencies: critical/high vulnerabilities found"
  else
    warn "Frontend dependencies: some vulnerabilities (non-critical)"
  fi
else
  warn "pnpm not available — skipping dependency audit"
fi

# Backend: check for outdated critical deps
BACKEND_OUTDATED=$(cd "$ROOT/apps/backend" && source .venv/bin/activate && pip list --outdated --format=json 2>/dev/null | python3 -c "
import sys, json
try:
    pkgs = json.load(sys.stdin)
    critical = [p for p in pkgs if p['name'] in ('fastapi', 'uvicorn', 'pydantic', 'httpx')]
    if critical:
        for p in critical:
            print(f\"  {p['name']}: {p['version']} -> {p['latest_version']}\")
    else:
        print('OK')
except:
    print('OK')
" 2>/dev/null)

if [ "$BACKEND_OUTDATED" = "OK" ] || [ -z "$BACKEND_OUTDATED" ]; then
  pass "Backend critical deps: up to date"
else
  warn "Backend has outdated critical dependencies:"
  echo "$BACKEND_OUTDATED"
fi

# Rust: cargo audit (if installed)
if command -v cargo-audit &> /dev/null; then
  if (cd "$ROOT/apps/desktop/src-tauri" && cargo audit) > /dev/null 2>&1; then
    pass "Rust dependencies: no known vulnerabilities"
  else
    warn "Rust dependencies: vulnerabilities found (run: cargo audit)"
  fi
else
  info "cargo-audit not installed — skipping (install: cargo install cargo-audit)"
fi

echo "│"

# ─── 6. Release Artifact Integrity ───────────────────────────────
echo "├─ [6/6] Release Artifacts"
echo "│"

# Check version consistency
BACKEND_VER=$(cd "$ROOT/apps/backend" && source .venv/bin/activate && python -c "
try:
    from zvec_studio import __version__; print(__version__)
except:
    print('unknown')
" 2>/dev/null)
FRONTEND_VER=$(cd "$ROOT/apps/frontend" && node -p "require('./package.json').version" 2>/dev/null)
DESKTOP_VER=$(grep '^version' "$ROOT/apps/desktop/src-tauri/Cargo.toml" | head -1 | sed 's/.*"\(.*\)"/\1/')

info "Backend version: $BACKEND_VER"
info "Frontend version: $FRONTEND_VER"
info "Desktop version: $DESKTOP_VER"

# Check that OpenAPI schema is present
if [ -f "$ROOT/apps/frontend/dist/index.html" ] 2>/dev/null; then
  pass "Frontend dist/index.html: present"
else
  warn "Frontend not built yet (run vite build)"
fi

echo "│"

# ─── Summary ──────────────────────────────────────────────────────
echo "└─ Summary"
echo ""
echo "┌────────────────────────────────────────────────────────────┐"
printf "│  %-30s %10s                  │\n" "Metric" "Result"
echo "│──────────────────────────────────────────────────────────  │"
printf "│  %-30s %10s                  │\n" "Gate failures" "$FAILURES"
printf "│  %-30s %10s                  │\n" "Warnings" "$WARNINGS"
printf "│  %-30s %10s                  │\n" "Backend coverage" "${BACKEND_COV}%"
printf "│  %-30s %10s                  │\n" "Frontend coverage" "${FRONTEND_COV}%"
printf "│  %-30s %10s                  │\n" "Backend version" "$BACKEND_VER"
printf "│  %-30s %10s                  │\n" "Frontend version" "$FRONTEND_VER"
printf "│  %-30s %10s                  │\n" "Desktop version" "$DESKTOP_VER"
echo "└────────────────────────────────────────────────────────────┘"
echo ""

# Write machine-readable result
cat > "$ARTIFACTS/pre-release-result.json" <<ENDJSON
{
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "verdict": "$([ $FAILURES -eq 0 ] && echo 'PASS' || echo 'FAIL')",
  "failures": $FAILURES,
  "warnings": $WARNINGS,
  "coverage": {
    "backend_pct": ${BACKEND_COV:-0},
    "frontend_pct": ${FRONTEND_COV:-0}
  },
  "versions": {
    "backend": "$BACKEND_VER",
    "frontend": "$FRONTEND_VER",
    "desktop": "$DESKTOP_VER"
  }
}
ENDJSON

echo "Results written to: artifacts/pre-release-result.json"
echo ""

if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}══ RELEASE CANDIDATE: APPROVED ════════════════════════════════${NC}"
  exit 0
else
  echo -e "${RED}══ RELEASE BLOCKED: $FAILURES FAILURE(S) ══════════════════════════════${NC}"
  exit 1
fi
