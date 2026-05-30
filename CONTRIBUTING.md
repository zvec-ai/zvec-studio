# Contributing to Zvec Studio

Thanks for your interest in contributing. This document covers the contribution workflow, DCO sign-off requirement, and local development setup.

## Developer Certificate of Origin (DCO)

All commits must be signed off per the [Developer Certificate of Origin](https://developercertificate.org/). Add the `-s` flag to `git commit`:

```bash
git commit -s -m "Your commit message"
```

Each commit message must end with a line like:

```
Signed-off-by: Your Name <your.email@example.com>
```

Pull requests without DCO sign-off will be blocked by CI.

## Local development

### Prerequisites

- Node.js >= 20 LTS
- pnpm >= 9 (`npm i -g pnpm`)
- Python 3.10 (pinned for the backend via `apps/backend/.python-version`)
- uv
- Rust stable (for desktop shell, optional at early stage)

### Bootstrap

```bash
make install
# Add `,ai` extras (sentence-transformers / dashscope / openai / dashtext)
# only when you need to exercise :embed / :rerank locally:
#   make install.ai
```

### Common commands

```bash
make dev          # Run backend + frontend dev servers concurrently
make build        # Build frontend + package backend
make test         # Run all test suites (216 backend + 97 frontend tests)
make lint         # Run linters across the monorepo
make verify       # Full quality gate: lint + types + tests + coverage + contract
make verify.fast  # Subset verify: lint + unit only (skip slow paths)
make e2e          # Run Playwright end-to-end tests
```

### Self-test & self-heal loop

Every Task must leave the repository in a state where `make verify` passes. See [docs/testing.md](docs/testing.md) (populated during T14) for the loop policy.

### Desktop development (Tauri)

```bash
# Dev mode — launches Tauri with hot-reload:
pnpm --filter desktop tauri:dev

# Production build (current platform):
make install.packaging
make package.sidecar
pnpm --filter desktop tauri:build

# macOS only — re-sign and recreate DMG:
cd apps/desktop && bash scripts/post-build-sign.sh
```

On Linux, install system dependencies first:
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev patchelf
```

### Version bumps

Version is maintained manually in three places:
1. `apps/desktop/src-tauri/tauri.conf.json` → `"version"`
2. `apps/backend/pyproject.toml` → `version`
3. Root `package.json` → `"version"` (if present)

Update all three, commit as `chore: bump version to X.Y.Z`, then tag `vX.Y.Z`.
The release workflow triggers on `v*` tags and creates a GitHub Release with
all platform bundles attached.

## Branching

- `main`: protected. No direct pushes.
- Feature branches: `feat/t{N}-{short-slug}` e.g. `feat/t6-collection-list-page`.
- One PR per Task. The PR body must reference the Task number and Definition of Done.

## Code style

- Python: `ruff` + `mypy` (strict). Run `ruff check --fix` before committing.
- TypeScript: `eslint` + `prettier`. Run `pnpm lint --fix` before committing.
- Rust: `cargo fmt` + `cargo clippy -- -D warnings`.
- Commits: Conventional Commits format (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`).

## Reporting bugs

Open a GitHub Issue with a minimal reproduction, the expected behavior, and any `artifacts/` output produced by a failed `make verify` run.
