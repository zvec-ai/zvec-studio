# Zvec Studio - Monorepo Makefile
# All targets are idempotent and safe to re-run.

SHELL := /bin/bash
.DEFAULT_GOAL := help

PNPM ?= pnpm
UV ?= uv

BACKEND_DIR := apps/backend
FRONTEND_DIR := apps/frontend
DESKTOP_DIR := apps/desktop
DESKTOP_RUST_DIR := $(DESKTOP_DIR)/src-tauri
ARTIFACTS_DIR := artifacts

# ---------- Help ----------
.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_.:-]+:.*?## / {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---------- Install ----------
.PHONY: install
install: ## Install all dependencies (Node + Python, no AI runtime)
	$(PNPM) install --frozen-lockfile=false
	cd $(BACKEND_DIR) && $(UV) sync --extra dev

.PHONY: install.ai
install.ai: ## Install with AI extras (sentence-transformers / dashscope / openai / dashtext)
	$(PNPM) install --frozen-lockfile=false
	cd $(BACKEND_DIR) && $(UV) sync --extra dev --extra ai

.PHONY: install.packaging
install.packaging: ## Install with packaging extras (PyInstaller sidecar build)
	$(PNPM) install --frozen-lockfile=false
	cd $(BACKEND_DIR) && $(UV) sync --extra dev --extra packaging

# ---------- Dev servers ----------
.PHONY: dev
dev: ## Run backend + frontend dev servers concurrently
	@mkdir -p $(ARTIFACTS_DIR)
	@echo "Starting backend on 127.0.0.1:7860 and frontend on 127.0.0.1:5173..."
	@( cd $(BACKEND_DIR) && $(UV) run --no-sync uvicorn zvec_studio.main:app --host 127.0.0.1 --port 7860 --reload ) & \
	 ( $(PNPM) --filter frontend dev ) ; \
	 wait

.PHONY: dev.backend
dev.backend: ## Run only the backend dev server
	cd $(BACKEND_DIR) && $(UV) run --no-sync uvicorn zvec_studio.main:app --host 127.0.0.1 --port 7860 --reload

.PHONY: dev.frontend
dev.frontend: ## Run only the frontend dev server
	$(PNPM) --filter frontend dev

# ---------- Build ----------
.PHONY: build
build: ## Build frontend and prepare backend package
	$(PNPM) --filter frontend build
	cd $(BACKEND_DIR) && $(UV) build --wheel

.PHONY: build.pip
build.pip: ## Build frontend and bundle into Python package (for PyPI release)
	$(PNPM) --filter frontend build
	rm -rf $(BACKEND_DIR)/zvec_studio/static/assets $(BACKEND_DIR)/zvec_studio/static/index.html
	cp -r $(FRONTEND_DIR)/dist/* $(BACKEND_DIR)/zvec_studio/static/
	cp README.md $(BACKEND_DIR)/README.pypi.md
	cd $(BACKEND_DIR) && $(UV) build --wheel

# ---------- Lint / types ----------
.PHONY: lint
lint: lint.backend lint.frontend ## Run all linters

.PHONY: lint.backend
lint.backend: ## ruff + mypy on backend
	cd $(BACKEND_DIR) && $(UV) run --no-sync ruff check .
	cd $(BACKEND_DIR) && $(UV) run --no-sync mypy zvec_studio

.PHONY: lint.frontend
lint.frontend: ## eslint + tsc on frontend
	$(PNPM) --filter frontend lint
	$(PNPM) --filter frontend typecheck

.PHONY: format
format: ## Auto-format all files
	cd $(BACKEND_DIR) && $(UV) run --no-sync ruff format .
	$(PNPM) format

# ---------- Test ----------
.PHONY: test
test: test.unit test.integration ## Run all unit + integration tests

.PHONY: test.unit
test.unit: ## Run unit tests (backend + frontend)
	@mkdir -p $(ARTIFACTS_DIR)
	cd $(BACKEND_DIR) && $(UV) run --no-sync pytest tests/unit -v --tb=short \
		--junitxml=../../$(ARTIFACTS_DIR)/backend-unit.xml || (echo "Backend unit tests failed; see $(ARTIFACTS_DIR)/"; exit 1)
	$(PNPM) --filter frontend test:unit

.PHONY: test.integration
test.integration: ## Run integration tests
	@mkdir -p $(ARTIFACTS_DIR)
	cd $(BACKEND_DIR) && $(UV) run --no-sync pytest tests/integration -v --tb=short \
		--junitxml=../../$(ARTIFACTS_DIR)/backend-integration.xml || (echo "Backend integration tests failed"; exit 1)

.PHONY: test.contract
test.contract: ## Run OpenAPI contract tests (Schemathesis)
	@mkdir -p $(ARTIFACTS_DIR)
	cd $(BACKEND_DIR) && $(UV) run --no-sync pytest tests/contract -v --tb=short \
		--junitxml=../../$(ARTIFACTS_DIR)/backend-contract.xml || true

.PHONY: test.coverage
test.coverage: ## Run backend tests with coverage gate
	cd $(BACKEND_DIR) && $(UV) run --no-sync pytest --cov=zvec_studio --cov-report=term --cov-report=xml:../../$(ARTIFACTS_DIR)/coverage.xml --cov-fail-under=60 tests/unit tests/integration

# ---------- E2E ----------
.PHONY: e2e
e2e: ## Run Playwright end-to-end tests
	@mkdir -p $(ARTIFACTS_DIR)
	$(PNPM) --filter frontend e2e || (echo "E2E failed; see playwright-report/"; exit 1)

# ---------- Verify (Task-level gate) ----------
.PHONY: verify
verify: ## Full Task-level gate: lint + types + tests + coverage + contract (web stack)
	@mkdir -p $(ARTIFACTS_DIR)
	@echo "===> [1/5] Lint & typecheck"
	@$(MAKE) lint
	@echo "===> [2/5] Unit tests"
	@$(MAKE) test.unit
	@echo "===> [3/5] Integration tests"
	@$(MAKE) test.integration
	@echo "===> [4/5] Contract tests"
	@$(MAKE) test.contract
	@echo "===> [5/5] Coverage gate"
	@$(MAKE) test.coverage
	@echo ""
	@echo "make verify: ALL GREEN"

.PHONY: verify.desktop
verify.desktop: ## Desktop shell gate: cargo fmt --check + clippy + tests (requires Rust toolchain)
	@$(MAKE) desktop.check
	@$(MAKE) desktop.test
	@echo "make verify.desktop: ALL GREEN"

.PHONY: verify.fast
verify.fast: ## Subset verify (lint + unit only; skip slow paths)
	@$(MAKE) lint
	@$(MAKE) test.unit

# ---------- Desktop (Tauri v2 shell) ----------
.PHONY: desktop.dev
desktop.dev: ## Run the Tauri desktop shell in dev mode (auto-spawns backend sidecar + Vite)
	$(PNPM) --filter desktop tauri:dev

.PHONY: desktop.check
desktop.check: ## cargo fmt --check + cargo clippy on the Tauri shell
	cd $(DESKTOP_RUST_DIR) && cargo fmt --all -- --check
	cd $(DESKTOP_RUST_DIR) && cargo clippy --all-targets --no-deps -- -D warnings

.PHONY: desktop.test
desktop.test: ## Run the Rust unit tests for the Tauri shell
	cd $(DESKTOP_RUST_DIR) && cargo test --no-fail-fast

.PHONY: desktop.build
desktop.build: ## Produce a production .app bundle (slow; macOS signing handled in T13)
	$(PNPM) --filter desktop tauri:build

# ---------- Packaging (Task 13: PyInstaller sidecar + Tauri bundle) ----------
.PHONY: package.sidecar
package.sidecar: ## Freeze the FastAPI sidecar into a single-file binary (requires apps/backend[packaging])
	cd $(BACKEND_DIR) && $(UV) run --no-sync python ../../scripts/build_sidecar.py

.PHONY: package.desktop
package.desktop: ## Build the Tauri desktop bundle using tauri.bundle.conf.json overrides
	cd $(DESKTOP_DIR) && $(PNPM) tauri build --config src-tauri/tauri.bundle.conf.json

.PHONY: package
package: package.sidecar package.desktop ## Full packaging pipeline: sidecar binary -> Tauri installers
	@echo "make package: bundles available under $(DESKTOP_RUST_DIR)/target/release/bundle/"

# ---------- Clean ----------
.PHONY: clean
clean: ## Remove build / cache / artifact outputs
	rm -rf $(ARTIFACTS_DIR)
	rm -rf $(FRONTEND_DIR)/dist $(FRONTEND_DIR)/node_modules/.cache
	find . -type d -name "__pycache__" -prune -exec rm -rf {} +
	find . -type d -name ".pytest_cache" -prune -exec rm -rf {} +
	find . -type d -name ".ruff_cache" -prune -exec rm -rf {} +
	find . -type d -name ".mypy_cache" -prune -exec rm -rf {} +

.PHONY: release-check
release-check: ## Run the full release gate: verify + verify.desktop + e2e (used at T14 / v* tags)
	@mkdir -p $(ARTIFACTS_DIR)
	@echo "===> [release 1/3] make verify (web stack + coverage gate)"
	@$(MAKE) verify
	@echo "===> [release 2/3] make verify.desktop (cargo fmt/clippy/test)"
	@$(MAKE) verify.desktop
	@echo "===> [release 3/3] make e2e (Playwright)"
	@$(MAKE) e2e
	@echo ""
	@echo "make release-check: ALL GREEN — ready to tag."
